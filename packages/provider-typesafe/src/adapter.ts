import { assertUsableApiKey, attributionHeaders, ModelError, MODEL_ERROR_CODES, normalizeModelFailure, ProviderRequestId, resolveRetryPolicy, validateUsageCounters, type UsageCounters } from '@alvin0/ai-agent-sdk-core'
import { CREDENTIAL_CAPABILITY_API_VERSION, type CredentialInput, type ModelInvocationContext, type ProviderAttemptHandle, type RetryPolicyConfig, type SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { DecisionAdapter, defineDecisionProviderPlugin, snapshotDecisionInput, validateDecisionResult, type DecisionAnswer, type DecisionInput, type DecisionModelInfo, type DecisionProviderPlugin, type DecisionRequest, type DecisionResult, type PreparedDecisionCall } from '@alvin0/ai-agent-sdk-decision-adapter'
import { abortable, throwIfAborted } from '@alvin0/ai-agent-sdk-decision-adapter/transport'

const CAPABILITIES = Object.freeze({ questionTypes: Object.freeze(['choice', 'score', 'boolean'] as const), maxChoiceOptions: 255, maxScoreLevels: 10 })
const NULL_LOGGER: SdkLogger = Object.freeze({ child: () => NULL_LOGGER, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} })
interface CapturedTypesafeRequest { readonly input: DecisionInput; readonly wire: string; readonly timeout: number; readonly provider: string; readonly model: string; readonly headers: Readonly<Record<string, string>> }
export interface TypesafeAdapterOptions {
  readonly apiKey: CredentialInput
  /** API root including /v1. Default: https://api.typesafe.ai/v1 */
  readonly baseUrl?: string | URL
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly retryPolicy?: RetryPolicyConfig
  /** For explicitly configured development endpoints only. */
  readonly allowInsecureHttp?: boolean
}
export interface TypesafePluginOptions extends TypesafeAdapterOptions {
  readonly id?: string
  readonly routes?: readonly string[]
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ModelError('TypeSafe returned an invalid response object', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  return value as Record<string, unknown>
}
/** Compare JSON rubric values without depending on object property order. */
function sameDescription(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') return false
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => sameDescription(value, actual[index]))
  if (Array.isArray(actual)) return false
  const keys = Object.keys(expected)
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key) && sameDescription((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key]))
}
function capturePublicHeaders(source: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  let headers: Readonly<Record<string, string>>
  try { headers = Object.freeze(Object.fromEntries(new Headers(source).entries())) }
  catch { throw new ModelError('Invalid TypeSafe custom headers', MODEL_ERROR_CODES.INVALID_REQUEST) }
  for (const key of Object.keys(headers)) {
    if (['authorization', 'content-type', 'accept', 'host', 'content-length', 'traceparent'].includes(key)) throw new ModelError('TypeSafe custom headers cannot override transport headers', MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  return headers
}
function captureInvocationHeaders(context?: ModelInvocationContext): Readonly<Record<string, string>> {
  if (context?.providerOptions?.body !== undefined && Object.keys(context.providerOptions.body).length) throw new ModelError('TypeSafe does not support providerOptions.body overrides', MODEL_ERROR_CODES.INVALID_REQUEST)
  return capturePublicHeaders(context?.providerOptions?.headers)
}
function bound(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new Error(`Invalid TypeSafe ${name}`)
  return result
}
function responseUsage(value: unknown): UsageCounters | undefined {
  const raw = object(value).usage
  if (raw === undefined) return undefined
  const source = object(raw)
  const counters = {
    ...(source.input_tokens === undefined ? {} : { inputTokens: source.input_tokens }),
    ...(source.output_tokens === undefined ? {} : { outputTokens: source.output_tokens }),
  }
  const validated = validateUsageCounters(counters)
  if (validated.invalidFields.length || validated.overflow) throw new ModelError('Invalid TypeSafe usage counters', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  return validated.reported
}
function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}
function statusCode(status: number): string {
  if (status === 401 || status === 403) return MODEL_ERROR_CODES.AUTH
  if (status === 429) return MODEL_ERROR_CODES.RATE_LIMIT
  if (status >= 500) return MODEL_ERROR_CODES.SERVER
  return MODEL_ERROR_CODES.INVALID_REQUEST
}
async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get('content-length'))
  if (length > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new ModelError('TypeSafe response exceeds byte limit', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  }
  if (!response.body) throw new ModelError('TypeSafe returned an empty response', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal)
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > maxBytes) throw new ModelError('TypeSafe response exceeds byte limit', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      text += decoder.decode(item.value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) as unknown }
    catch { throw new ModelError('TypeSafe returned invalid JSON', MODEL_ERROR_CODES.MALFORMED_RESPONSE) }
  } catch (error) {
    throwIfAborted(signal)
    if (error instanceof ModelError) throw error
    throw new ModelError('TypeSafe returned an unreadable JSON response', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  } finally {
    // Do not wait indefinitely for a foreign stream's cancellation hook.
    void reader.cancel().catch(() => {})
  }
}
class TypesafeDecisionAdapter extends DecisionAdapter {
  readonly #baseUrl: string
  readonly #credential: string | ((signal: AbortSignal, logger: SdkLogger) => Promise<string>)
  readonly #fetch: typeof globalThis.fetch
  readonly #headers: Readonly<Record<string, string>>
  readonly #timeout: number
  readonly #maxRequest: number
  readonly #maxResponse: number
  readonly #retry: ReturnType<typeof resolveRetryPolicy> | undefined
  readonly #rubrics = new WeakMap<DecisionInput['questions'], string>()
  constructor(options: TypesafeAdapterOptions) {
    super()
    const url = new URL(options.baseUrl ?? 'https://api.typesafe.ai/v1')
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowInsecureHttp === true))) throw new Error('TypeSafe requires an HTTPS API root without credentials, query or fragment')
    this.#baseUrl = url.href.replace(/\/$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#headers = capturePublicHeaders(options.headers)
    this.#timeout = bound(options.requestTimeoutMs, 30_000, 'requestTimeoutMs')
    this.#maxRequest = bound(options.maxRequestBytes, 2_097_152, 'maxRequestBytes')
    this.#maxResponse = bound(options.maxResponseBytes, 4_194_304, 'maxResponseBytes')
    this.#retry = options.retryPolicy === undefined ? undefined : resolveRetryPolicy(options.retryPolicy, 'typesafe.retryPolicy')
    if (typeof options.apiKey === 'string') this.#credential = assertUsableApiKey(options.apiKey, 'TypeSafe', 'apiKey')
    else {
      const source = options.apiKey
      if (source?.kind !== 'credential-source' || source.apiVersion !== CREDENTIAL_CAPABILITY_API_VERSION || typeof source.resolve !== 'function') throw new Error('TypeSafe requires a compatible credential source')
      const resolve = source.resolve.bind(source)
      this.#credential = async (signal, logger) => assertUsableApiKey(await resolve({ signal, logger }), 'TypeSafe', 'credential source')
    }
  }
  override providerRetryPolicy(): ReturnType<typeof resolveRetryPolicy> | undefined { return this.#retry }
  override async resolveModel(provider: string, model: string): Promise<DecisionModelInfo> {
    return Object.freeze({ provider, id: model, name: model, capabilities: CAPABILITIES })
  }
  override async prepareDecisionCall(provider: string, model: string, _signal?: AbortSignal, context?: ModelInvocationContext): Promise<PreparedDecisionCall> {
    const headers = captureInvocationHeaders(context)
    let captured: { readonly request: DecisionRequest; readonly value: CapturedTypesafeRequest } | undefined
    return Object.freeze({ model: await this.resolveModel(provider, model), evaluate: (request: DecisionRequest, invocation = context) => {
      if (request.provider !== provider || request.model !== model) throw new ModelError('Prepared TypeSafe decision target does not match request', MODEL_ERROR_CODES.INVALID_REQUEST)
      if (captured && captured.request !== request) throw new ModelError('Prepared TypeSafe decision call cannot dispatch a different request', MODEL_ERROR_CODES.INVALID_REQUEST)
      captured ??= { request, value: this.#capture(request, invocation === context ? headers : captureInvocationHeaders(invocation)) }
      return this.#evaluate(captured.value, invocation)
    } })
  }
  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly DecisionModelInfo[]> {
    const result = await this.#dispatch(provider, 'catalog', 'models', undefined, signal)
    const models = object(result.value).models
    if (!Array.isArray(models) || models.length > 1_024) throw new ModelError('Invalid TypeSafe model catalog', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
    return Object.freeze(models.map(entry => {
      const info = object(entry)
      if (typeof info.name !== 'string' || !info.name.trim() || info.name.length > 256) throw new ModelError('Invalid TypeSafe model id', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      return Object.freeze({ provider, id: info.name, name: info.name, capabilities: CAPABILITIES })
    }))
  }
  override async evaluate(request: DecisionRequest, context?: ModelInvocationContext): Promise<DecisionResult> {
    return this.#evaluate(this.#capture(request, captureInvocationHeaders(context)), context)
  }
  #capture(request: DecisionRequest, headers: Readonly<Record<string, string>>): CapturedTypesafeRequest {
    if (typeof request.provider !== 'string' || !request.provider.trim() || typeof request.model !== 'string' || !request.model.trim()) throw new ModelError('TypeSafe requires provider and model identifiers', MODEL_ERROR_CODES.INVALID_REQUEST)
    const input = snapshotDecisionInput(request, CAPABILITIES)
    const timeout = Math.min(this.#timeout, input.timeoutMs ?? this.#timeout)
    let questions = this.#rubrics.get(input.questions)
    if (questions === undefined) {
      questions = JSON.stringify(Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
        switch (question.type) {
          case 'choice': return [id, { type: 'choice', instructions: question.instructions, criteria: question.options }]
          case 'score': return [id, { type: 'score', instructions: question.instructions, criteria: question.levels }]
          case 'boolean': return [id, { type: 'noul', instructions: question.instructions, ...(question.criteria === undefined ? {} : { criteria: question.criteria }) }]
        }
      })))
      this.#rubrics.set(input.questions, questions)
    }
    const wire = `{"questions":${questions},"model":${JSON.stringify(request.model)},"state":${JSON.stringify(input.state)}}`
    if (new TextEncoder().encode(wire).byteLength > this.#maxRequest) throw new ModelError('TypeSafe request exceeds byte limit', MODEL_ERROR_CODES.INVALID_REQUEST)
    return { input, wire, timeout, provider: request.provider, model: request.model, headers }
  }
  async #evaluate(captured: CapturedTypesafeRequest, context?: ModelInvocationContext): Promise<DecisionResult> {
    const { input, wire, timeout, provider, model } = captured
    const response = await this.#dispatch(provider, model, 'systemone', wire, input.signal, context, value => {
      const raw = object(value)
      const rawAnswers = object(raw.answers)
      // Validate wire identifiers/types BEFORE projecting, so surplus answers cannot disappear.
      if (Object.keys(rawAnswers).length !== Object.keys(input.questions).length) throw new ModelError('Unexpected TypeSafe answer ids', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      const answers: Record<string, DecisionAnswer> = Object.create(null) as Record<string, DecisionAnswer>
      for (const [id, question] of Object.entries(input.questions)) {
        if (!Object.hasOwn(rawAnswers, id)) throw new ModelError('Missing TypeSafe answer', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
        const answer = object(rawAnswers[id])
        const evidence = { probabilitySource: 'provider' as const, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence as number }) }
        switch (question.type) {
          case 'choice':
            if (answer.type !== 'choice' || answer.probabilities === undefined || answer.confidence === undefined) throw new ModelError('Invalid TypeSafe choice answer', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
            answers[id] = { type: 'choice', choice: answer.choice as string, probabilities: answer.probabilities as Record<string, number>, ...evidence }
            break
          case 'score': {
            if (answer.type !== 'score' || answer.probabilities === undefined || answer.confidence === undefined) throw new ModelError('Invalid TypeSafe score answer', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
            const legend = object(answer.legend)
            if (Object.keys(legend).length !== question.levels.length || question.levels.some((level, i) => !Object.hasOwn(legend, String(i)) || !sameDescription(level, legend[String(i)]))) throw new ModelError('Invalid TypeSafe score legend', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
            answers[id] = { type: 'score', score: answer.score as number, probabilities: answer.probabilities as Record<string, number>, ...evidence }
            break
          }
          case 'boolean':
            if (answer.type !== 'noul') throw new ModelError('Invalid TypeSafe boolean answer', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
            answers[id] = { type: 'boolean', value: (answer.noul as number) >= 0.5, probabilityTrue: answer.noul as number, probabilitySource: 'provider' }
            break
        }
      }
      const usage = responseUsage(raw)
      return validateDecisionResult({
        model: raw.model, answers,
        ...(usage === undefined ? {} : { usage }),
      }, input.questions)
    }, timeout, captured.headers)
    const result = response.value as DecisionResult
    return response.requestId === undefined ? result : validateDecisionResult({ ...result, providerRequestId: response.requestId }, input.questions)
  }
  async #dispatch(provider: string, model: string, path: string, body: string | undefined, callerSignal?: AbortSignal, context?: ModelInvocationContext, decode?: (value: unknown) => DecisionResult, timeout = this.#timeout, publicHeaders: Readonly<Record<string, string>> = {}): Promise<{ value: unknown; requestId?: string }> {
    const controller = new AbortController()
    const forward = () => controller.abort(callerSignal?.reason ?? new ModelError('TypeSafe call aborted', MODEL_ERROR_CODES.ABORTED))
    callerSignal?.addEventListener('abort', forward, { once: true })
    if (callerSignal?.aborted) forward()
    const timer = setTimeout(() => controller.abort(new ModelError('TypeSafe request timed out', MODEL_ERROR_CODES.TIMEOUT)), timeout)
    const signal = controller.signal
    let attempt: ProviderAttemptHandle | undefined
    let response: Response | undefined
    let sent = false
    let requestId: string | undefined
    let reportedUsage: UsageCounters | undefined
    try {
      throwIfAborted(signal)
      const credential = this.#credential
      const key = typeof credential === 'string' ? credential : await abortable(credential(signal, context?.logger ?? NULL_LOGGER), signal)
      throwIfAborted(signal)
      const url = `${this.#baseUrl}/${path}`
      context?.declareProviderAttemptAccounting?.()
      attempt = await abortable(Promise.resolve(context?.startProviderAttempt?.({ provider, model, method: body === undefined ? 'GET' : 'POST', origin: new URL(url).origin }, signal)).then(handle => {
        if (signal.aborted) handle?.end({ status: 'aborted', dispatchState: 'not-sent' })
        return handle
      }), signal)
      throwIfAborted(signal)
      const headers = new Headers({ ...this.#headers, ...publicHeaders, ...attributionHeaders(), authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' })
      if (attempt) headers.set('traceparent', attempt.traceparent)
      const received = await abortable<Response>(Promise.resolve().then(() => {
        throwIfAborted(signal)
        sent = true
        return this.#fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body }), signal, redirect: 'error' })
      }).then(result => {
        if (signal.aborted) void result.body?.cancel().catch(() => {})
        return result
      }).catch(() => {
        throwIfAborted(signal)
        throw new ModelError('TypeSafe transport failed', MODEL_ERROR_CODES.TRANSPORT)
      }), signal)
      response = received
      const headerId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
      requestId = headerId && headerId.length <= 256 ? headerId : undefined
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        const delay = retryAfter(response.headers.get('retry-after'))
        throw new ModelError(`TypeSafe HTTP request failed (${response.status})`, statusCode(response.status), { status: response.status, ...(delay === undefined ? {} : { providerRetryAfterMs: delay }), ...(requestId === undefined ? {} : { requestId: ProviderRequestId(requestId) }) })
      }
      const json = await readJson(response, this.#maxResponse, signal)
      // Usage is billable evidence even when the decision answers are malformed.
      if (decode !== undefined) reportedUsage = responseUsage(json)
      const value = decode ? decode(json) : json
      throwIfAborted(signal)
      const usage = reportedUsage
      attempt?.end({ status: 'success', dispatchState: 'sent', httpStatus: response.status, ...(requestId === undefined ? {} : { providerRequestId: requestId }), ...(usage === undefined ? {} : { reported: usage, usageFinal: true }) })
      return { value, ...(requestId === undefined ? {} : { requestId }) }
    } catch (error) {
      let failure: unknown = error
      if (signal.aborted) { try { throwIfAborted(signal) } catch (aborted) { failure = aborted } }
      const normalized = normalizeModelFailure(failure)
      attempt?.end({ status: normalized.code === MODEL_ERROR_CODES.ABORTED ? 'aborted' : 'error', dispatchState: sent ? 'sent' : 'not-sent', ...(response === undefined ? {} : { httpStatus: response.status }), ...(requestId === undefined ? {} : { providerRequestId: requestId }), ...(reportedUsage === undefined ? {} : { reported: reportedUsage, usageFinal: true }), error: { type: 'ModelError', message: 'TypeSafe request failed', code: normalized.code } })
      throw failure
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', forward)
    }
  }
}
export function typesafeAdapter(options: TypesafeAdapterOptions): DecisionAdapter { return new TypesafeDecisionAdapter(options) }
export function typesafePlugin(options: TypesafePluginOptions): DecisionProviderPlugin {
  const adapter = typesafeAdapter(options)
  const routes = Object.freeze([...(options.routes ?? ['typesafe'])])
  return defineDecisionProviderPlugin({ id: options.id ?? 'typesafe', routes, setup(registrar) { const registration = registrar.registerAdapter(routes, adapter); return () => registration.dispose() } })
}
