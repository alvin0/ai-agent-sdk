import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type {
  ModelFailure,
  ModelInvocationContext,
  ProviderAttemptHandle,
  ProviderRequestId,
  SafeErrorRecord,
  UsageCounters,
} from '@alvin0/ai-agent-sdk-core'
import { normalizeHttpBoundaryError } from '../common/failure.ts'
import type { HttpTransportConnection } from './connection.ts'
import { requestIdFrom } from './errors.ts'
import {
  abortError,
  cancelResponseBody,
  endpointUrl,
  raceWithSignal,
  redactHeaders,
  redactQueryUrl,
  rejectProviderRedirect,
  requestLogId,
  safeProviderFailure,
} from './http.ts'
import { httpFailure } from './http-failure.ts'
import { resolveTransportLimits, type ResolvedTransportLimits } from './limits.ts'
import type {
  HttpTransportRequestInput,
  HttpTransportSession,
  PreparedWireBody,
  TransportAttemptStatus,
} from './session-types.ts'

interface PreparedRequest {
  readonly body: PreparedWireBody
  readonly url: string
  readonly origin: string
  readonly headers: Readonly<Record<string, string>>
  readonly logId: string
}

/** Own one request deadline, its attempt evidence, and every response body it receives. */
export class TransportRequest {
  private readonly connection: HttpTransportConnection
  private readonly context: ModelInvocationContext | undefined
  private readonly displayName: string
  private readonly model: string
  private readonly provider: string
  private readonly callerSignal: AbortSignal | undefined
  private readonly consumer: AbortController
  private readonly limits: ResolvedTransportLimits
  private readonly timeout: AbortSignal
  private readonly signal: AbortSignal
  private admissionFailure: { readonly value: unknown } | undefined
  private ownedResponse: Response | undefined

  constructor(private readonly input: HttpTransportRequestInput) {
    const { connection, context, displayName, model, provider } = input
    this.connection = connection
    this.context = context
    this.displayName = displayName
    this.model = model
    this.provider = provider
    this.callerSignal = input.signal
    this.consumer = new AbortController()
    this.limits = resolveTransportLimits(connection)
    this.timeout = AbortSignal.timeout(this.limits.requestTimeoutMs)
    this.signal = AbortSignal.any([
      this.consumer.signal, this.timeout,
      ...this.callerSignal === undefined ? [] : [this.callerSignal],
    ])
  }

  async * run<T>(use: (session: HttpTransportSession) => AsyncIterable<T>): AsyncGenerator<T> {
    try {
      const request = await this.prepare()
      yield* this.runAttempt(request, use)
    } catch (error: unknown) {
      throw this.outerFailure(error)
    } finally {
      this.consumer.abort(new Error(`${this.displayName} stream consumer stopped`))
      if (this.ownedResponse !== undefined) await cancelResponseBody(this.ownedResponse)
    }
  }

  private async prepare(): Promise<PreparedRequest> {
    const { input, connection, signal, displayName, limits } = this
    signal.throwIfAborted()
    const body = typeof input.body === 'function' ? await input.body(signal) : input.body
    if (body.bytes > limits.maxRequestBytes) {
      throw new ModelError(
        `${displayName} request exceeds the ${limits.maxRequestBytes}-byte limit`,
        MODEL_ERROR_CODES.INVALID_REQUEST,
      )
    }
    const endpoint = endpointUrl(connection.baseUrl, input.path, connection.allowInsecureHttp ?? false)
    const request = {
      body, url: endpoint.href, origin: endpoint.origin, headers: connection.headers, logId: requestLogId(),
    }
    await this.observeRequest(request)
    return request
  }

  private async observeRequest(request: PreparedRequest): Promise<void> {
    const { connection, input, signal, limits, provider, model } = this
    const { url, headers, body, logId } = request
    // Diagnostics are best-effort; dispatch never depends on their success.
    try {
      const loggerSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.requestLoggerTimeoutMs)])
      await raceWithSignal(Promise.resolve(input.observeRequest?.({
        schemaVersion: 1,
        type: 'provider-request',
        id: logId,
        timestamp: new Date().toISOString(),
        provider,
        model,
        method: 'POST',
        url: redactQueryUrl(url, connection.sensitiveQueryParamNames),
        headers: redactHeaders(headers, connection.sensitiveHeaderNames),
        body: body.value,
        bodyBytes: body.bytes,
      })), loggerSignal)
    } catch { /* observers never veto dispatch */ }
  }

  private async * runAttempt<T>(
    request: PreparedRequest, use: (session: HttpTransportSession) => AsyncIterable<T>,
  ): AsyncGenerator<T> {
    const evidence = new AttemptEvidence()
    try {
      this.signal.throwIfAborted()
      evidence.attempt = await this.admitAttempt(request.origin)
      this.signal.throwIfAborted()
      evidence.dispatchState = 'unknown'
      const response = await this.dispatch(request, evidence)
      yield* use(this.session(request, response, evidence))
    } catch (error: unknown) {
      const mapped = this.attemptFailure(error, request.origin)
      evidence.status = mapped.code === MODEL_ERROR_CODES.ABORTED ? 'aborted' : 'error'
      evidence.error = safeProviderFailure(mapped.failure)
      throw mapped
    } finally {
      evidence.end()
    }
  }

  private async admitAttempt(origin: string): Promise<ProviderAttemptHandle | undefined> {
    try {
      return await this.context?.startProviderAttempt?.({
        provider: this.provider, model: this.model, method: 'POST', origin,
      }, this.signal)
    } catch (error: unknown) {
      this.admissionFailure = { value: error }
      throw error
    }
  }

  private async dispatch(request: PreparedRequest, evidence: AttemptEvidence): Promise<Response> {
    const { connection, signal, limits, input } = this
    const fetchImplementation = connection.fetch ?? globalThis.fetch
    const pendingResponse = fetchImplementation(request.url, {
      method: 'POST', headers: request.headers, body: request.body.encoded, signal, redirect: 'manual',
    })
    // A custom fetch may deliver its body after abort; retain cleanup ownership.
    void pendingResponse.then(response => {
      if (signal.aborted) return cancelResponseBody(response)
      return undefined
    }, () => undefined)
    const response = await raceWithSignal(pendingResponse, signal)
    this.ownedResponse = response
    signal.throwIfAborted()
    evidence.dispatchState = 'sent'
    evidence.httpStatus = response.status
    evidence.providerRequestId = requestIdFrom(response.headers)
    await rejectProviderRedirect(response, request.url)
    if (!response.ok) {
      throw await httpFailure(response, {
        origin: request.origin, maxBytes: limits.maxErrorBodyBytes, signal,
      }, input)
    }
    return response
  }

  private session(
    request: PreparedRequest, response: Response, evidence: AttemptEvidence,
  ): HttpTransportSession {
    const providerRequestId = evidence.providerRequestId
    const attempt = evidence.attempt
    return Object.freeze({
      response,
      url: request.url,
      origin: request.origin,
      signal: this.signal,
      requestLogId: request.logId,
      accept: this.input.accept,
      limits: this.limits,
      ...providerRequestId === undefined ? {} : { providerRequestId },
      reportUsage(usage: UsageCounters, final = true) {
        evidence.usage = usage
        evidence.usageFinal = final
      },
      ...(attempt === undefined ? {} : { attemptId: attempt.attemptId }),
      reportOutcome(status: TransportAttemptStatus, failure?: ModelFailure) {
        evidence.status = status
        if (failure !== undefined) evidence.error = safeProviderFailure(failure)
      },
    })
  }

  private attemptFailure(error: unknown, origin: string): ModelError {
    if (this.admissionFailure !== undefined && error === this.admissionFailure.value) throw error
    if (this.timeout.aborted && this.callerSignal?.aborted !== true) return this.timeoutFailure(error)
    if (this.signal.aborted) return abortError(this.displayName, error)
    return normalizeHttpBoundaryError(error, `${this.displayName} request to ${origin} failed`)
  }

  private outerFailure(error: unknown): ModelError {
    if (this.callerSignal?.aborted === true) return abortError(this.displayName, error)
    if (this.timeout.aborted) return this.timeoutFailure(error)
    if (this.admissionFailure !== undefined && error === this.admissionFailure.value) throw error
    return normalizeHttpBoundaryError(error, `${this.displayName} stream failed`)
  }

  private timeoutFailure(error: unknown): ModelError {
    return new ModelError(
      `${this.displayName} request exceeded its ${this.limits.requestTimeoutMs}ms time limit`,
      MODEL_ERROR_CODES.TIMEOUT,
      { cause: error },
    )
  }
}

class AttemptEvidence {
  attempt: ProviderAttemptHandle | undefined
  dispatchState: 'not-sent' | 'sent' | 'unknown' = 'not-sent'
  httpStatus: number | undefined
  providerRequestId: ProviderRequestId | undefined
  status: TransportAttemptStatus = 'unknown'
  usage: UsageCounters | undefined
  usageFinal = true
  error: SafeErrorRecord | undefined

  end(): void {
    this.attempt?.end({
      status: this.status,
      dispatchState: this.dispatchState,
      ...this.usage === undefined ? {} : { reported: this.usage },
      ...this.usageFinal ? {} : { usageFinal: false },
      ...this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus },
      ...this.providerRequestId === undefined ? {} : { providerRequestId: this.providerRequestId },
      ...this.error === undefined ? {} : { error: this.error },
    })
  }
}
