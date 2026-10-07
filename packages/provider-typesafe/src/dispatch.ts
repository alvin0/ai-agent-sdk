import {
  attributionHeaders, ModelError, MODEL_ERROR_CODES, normalizeModelFailure, ProviderRequestId,
} from '@alvin0/ai-agent-sdk-core'
import type { UsageCounters } from '@alvin0/ai-agent-sdk-core'
import type {
  EndProviderAttemptInput, ModelInvocationContext, ProviderAttemptHandle, SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'
import type { DecisionResult } from '@alvin0/ai-agent-sdk-decision-adapter'
import { abortable, throwIfAborted } from '@alvin0/ai-agent-sdk-decision-adapter/transport'
import { NULL_LOGGER } from './configuration.ts'
import { readJson, responseUsage, retryAfter, statusCode } from './response.ts'

export interface TypesafeDispatchHost {
  readonly baseUrl: string
  readonly credential: string | ((signal: AbortSignal, logger: SdkLogger) => Promise<string>)
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly maxResponse: number
  readonly timeout: number
}

export interface TypesafeDispatchRequest {
  readonly provider: string
  readonly model: string
  readonly path: string
  readonly body: string | undefined
  readonly callerSignal?: AbortSignal
  readonly context?: ModelInvocationContext
  readonly decode?: (value: unknown) => DecisionResult
  readonly timeout?: number
  readonly publicHeaders?: Readonly<Record<string, string>>
}

export function dispatchTypesafe(host: TypesafeDispatchHost, request: TypesafeDispatchRequest) {
  return new TypesafeDispatch(host, request).run()
}

/** The attempt handle is consumed before invoking a potentially throwing extension. */
class TypesafeDispatch {
  private readonly controller = new AbortController()
  private readonly signal = this.controller.signal
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly forward: () => void
  private attempt: ProviderAttemptHandle | undefined
  private response: Response | undefined
  private sent = false
  private requestId: string | undefined
  private reportedUsage: UsageCounters | undefined

  constructor(private readonly host: TypesafeDispatchHost, private readonly request: TypesafeDispatchRequest) {
    const { callerSignal } = request
    const timeout = request.timeout ?? host.timeout
    this.forward = () => this.controller.abort(callerSignal?.reason
      ?? new ModelError('TypeSafe call aborted', MODEL_ERROR_CODES.ABORTED))
    callerSignal?.addEventListener('abort', this.forward, { once: true })
    if (callerSignal?.aborted) this.forward()
    this.timer = setTimeout(() => this.controller.abort(
      new ModelError('TypeSafe request timed out', MODEL_ERROR_CODES.TIMEOUT),
    ), timeout)
  }

  async run(): Promise<{ value: unknown; requestId?: string }> {
    const { signal, request } = this
    try {
      const prepared = await this.prepare()
      this.response = await this.fetch(prepared)
      this.captureRequestId(this.response)
      this.assertHttpSuccess(this.response)
      const json = await readJson(this.response, this.host.maxResponse, signal)
      // Usage remains billable evidence when the decision answers are malformed.
      if (request.decode !== undefined) this.reportedUsage = responseUsage(json)
      const value = request.decode ? request.decode(json) : json
      throwIfAborted(signal)
      this.endSuccess(this.response)
      const requestId = this.requestId
      return { value, ...(requestId === undefined ? {} : { requestId }) }
    } catch (error) {
      return this.fail(error)
    } finally {
      clearTimeout(this.timer)
      request.callerSignal?.removeEventListener('abort', this.forward)
    }
  }

  private async prepare(): Promise<{ url: string; headers: Headers }> {
    const { signal, host, request } = this
    const { provider, model, body, context } = request
    throwIfAborted(signal)
    const credential = host.credential
    const key = typeof credential === 'string' ? credential
      : await abortable(credential(signal, context?.logger ?? NULL_LOGGER), signal)
    throwIfAborted(signal)
    const url = `${host.baseUrl}/${request.path}`
    context?.declareProviderAttemptAccounting?.()
    this.attempt = await abortable(Promise.resolve(context?.startProviderAttempt?.({
      provider, model, method: body === undefined ? 'GET' : 'POST', origin: new URL(url).origin,
    }, signal)).then(handle => {
      if (signal.aborted) handle?.end({ status: 'aborted', dispatchState: 'not-sent' })
      return handle
    }), signal)
    throwIfAborted(signal)
    return { url, headers: this.requestHeaders(key) }
  }

  private requestHeaders(key: string): Headers {
    const { host, request } = this
    const headers = new Headers({
      ...host.headers, ...(request.publicHeaders ?? {}), ...attributionHeaders(),
      authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json',
    })
    if (this.attempt) headers.set('traceparent', this.attempt.traceparent)
    return headers
  }

  private fetch(prepared: { url: string; headers: Headers }): Promise<Response> {
    const { signal, request } = this
    const body = request.body
    return abortable<Response>(Promise.resolve().then(() => {
      throwIfAborted(signal)
      this.sent = true
      return this.host.fetch(prepared.url, {
        method: body === undefined ? 'GET' : 'POST', headers: prepared.headers,
        ...(body === undefined ? {} : { body }), signal, redirect: 'error',
      })
    }).then(result => {
      if (signal.aborted) void result.body?.cancel().catch(() => {})
      return result
    }).catch(() => {
      throwIfAborted(signal)
      throw new ModelError('TypeSafe transport failed', MODEL_ERROR_CODES.TRANSPORT)
    }), signal)
  }

  private captureRequestId(response: Response): void {
    const headerId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
    this.requestId = headerId && headerId.length <= 256 ? headerId : undefined
  }

  private assertHttpSuccess(response: Response): void {
    if (response.ok) return
    void response.body?.cancel().catch(() => {})
    const delay = retryAfter(response.headers.get('retry-after'))
    const requestId = this.requestId
    throw new ModelError(`TypeSafe HTTP request failed (${response.status})`, statusCode(response.status), {
      status: response.status,
      ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
      ...(requestId === undefined ? {} : { requestId: ProviderRequestId(requestId) }),
    })
  }

  private endAttempt(input: EndProviderAttemptInput): void {
    const handle = this.attempt
    this.attempt = undefined
    handle?.end(input)
  }

  private endSuccess(response: Response): void {
    const requestId = this.requestId
    const usage = this.reportedUsage
    this.endAttempt({
      status: 'success', dispatchState: 'sent', httpStatus: response.status,
      ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      ...(usage === undefined ? {} : { reported: usage, usageFinal: true }),
    })
  }

  private fail(error: unknown): never {
    let failure: unknown = error
    if (this.signal.aborted) {
      try { throwIfAborted(this.signal) } catch (aborted) { failure = aborted }
    }
    const normalized = normalizeModelFailure(failure)
    const response = this.response
    const requestId = this.requestId
    const reportedUsage = this.reportedUsage
    this.endAttempt({
      status: normalized.code === MODEL_ERROR_CODES.ABORTED ? 'aborted' : 'error',
      dispatchState: this.sent ? 'sent' : 'not-sent',
      ...(response === undefined ? {} : { httpStatus: response.status }),
      ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      ...(reportedUsage === undefined ? {} : { reported: reportedUsage, usageFinal: true }),
      error: { type: 'ModelError', message: 'TypeSafe request failed', code: normalized.code },
    })
    throw failure
  }
}
