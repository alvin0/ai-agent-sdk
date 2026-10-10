import { ModelError, MODEL_ERROR_CODES, resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type { ModelInvocationContext, SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import {
  DecisionAdapter, defineDecisionProviderPlugin, snapshotDecisionInput, validateDecisionResult,
  type DecisionInput, type DecisionModelInfo, type DecisionProviderPlugin, type DecisionRequest,
  type DecisionResult, type PreparedDecisionCall,
} from '@alvin0/ai-agent-sdk-decision-adapter'
import { dispatchTypesafe, type TypesafeDispatchRequest } from './dispatch.ts'
import { CAPABILITIES, bound, typesafeBaseUrl, captureCredential } from './configuration.ts'
import { decodeTypesafeResult } from './decode.ts'
import { object } from './response.ts'
import type { CapturedTypesafeRequest, TypesafeAdapterOptions, TypesafePluginOptions } from './types.ts'

export type { TypesafeAdapterOptions, TypesafePluginOptions } from './types.ts'

function capturePublicHeaders(source: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  let headers: Readonly<Record<string, string>>
  try { headers = Object.freeze(Object.fromEntries(new Headers(source).entries())) }
  catch { throw new ModelError('Invalid TypeSafe custom headers', MODEL_ERROR_CODES.INVALID_REQUEST) }
  for (const key of Object.keys(headers)) {
    if (['authorization', 'content-type', 'accept', 'host', 'content-length', 'traceparent'].includes(
      key)) throw new ModelError('TypeSafe custom headers cannot override transport headers',
        MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  return headers
}
function captureInvocationHeaders(context?: ModelInvocationContext): Readonly<Record<string, string>> {
  if (context?.providerOptions?.body !== undefined && Object.keys(
    context.providerOptions.body).length) throw new ModelError(
      'TypeSafe does not support providerOptions.body overrides', MODEL_ERROR_CODES.INVALID_REQUEST)
  return capturePublicHeaders(context?.providerOptions?.headers)
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
    const url = typesafeBaseUrl(options)
    this.#baseUrl = url.href.replace(/\/$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#headers = capturePublicHeaders(options.headers)
    this.#timeout = bound(options.requestTimeoutMs, 30_000, 'requestTimeoutMs')
    this.#maxRequest = bound(options.maxRequestBytes, 2_097_152, 'maxRequestBytes')
    this.#maxResponse = bound(options.maxResponseBytes, 4_194_304, 'maxResponseBytes')
    this.#retry = options.retryPolicy === undefined ? undefined : resolveRetryPolicy(options.retryPolicy,
      'typesafe.retryPolicy')
    this.#credential = captureCredential(options.apiKey)
  }
  override providerRetryPolicy(): ReturnType<typeof resolveRetryPolicy> | undefined { return this.#retry }
  override async resolveModel(provider: string, model: string): Promise<DecisionModelInfo> {
    return Object.freeze({ provider, id: model, name: model, capabilities: CAPABILITIES })
  }
  override async prepareDecisionCall(provider: string, model: string, _signal?: AbortSignal,
    context?: ModelInvocationContext): Promise<PreparedDecisionCall> {
    const headers = captureInvocationHeaders(context)
    let captured: { readonly request: DecisionRequest; readonly value: CapturedTypesafeRequest } | undefined
    return Object.freeze({ model: await this.resolveModel(provider, model), evaluate: (
      request: DecisionRequest, invocation = context) => {
      if (request.provider !== provider || request.model !== model) throw new ModelError(
        'Prepared TypeSafe decision target does not match request', MODEL_ERROR_CODES.INVALID_REQUEST)
      if (captured && captured.request !== request) throw new ModelError(
        'Prepared TypeSafe decision call cannot dispatch a different request', MODEL_ERROR_CODES.INVALID_REQUEST)
      captured ??= { request, value: this.#capture(request,
        invocation === context ? headers : captureInvocationHeaders(invocation)) }
      return this.#evaluate(captured.value, invocation)
    } })
  }
  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly DecisionModelInfo[]> {
    const result = await this.#dispatch({ provider, model: 'catalog', path: 'models', body: undefined,
      ...(signal === undefined ? {} : { callerSignal: signal }) })
    const models = object(result.value).models
    if (!Array.isArray(models) || models.length > 1_024) throw new ModelError(
      'Invalid TypeSafe model catalog', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
    return Object.freeze(models.map(entry => {
      const info = object(entry)
      if (typeof info.name !== 'string' || !info.name.trim() || info.name.length > 256) throw new ModelError(
        'Invalid TypeSafe model id', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      return Object.freeze({ provider, id: info.name, name: info.name, capabilities: CAPABILITIES })
    }))
  }
  override async evaluate(request: DecisionRequest, context?: ModelInvocationContext): Promise<DecisionResult> {
    return this.#evaluate(this.#capture(request, captureInvocationHeaders(context)), context)
  }
  #capture(request: DecisionRequest, headers: Readonly<Record<string, string>>): CapturedTypesafeRequest {
    if (typeof request.provider !== 'string' || !request.provider.trim() ||
      typeof request.model !== 'string' || !request.model.trim()) throw new ModelError(
        'TypeSafe requires provider and model identifiers', MODEL_ERROR_CODES.INVALID_REQUEST)
    const input = snapshotDecisionInput(request, CAPABILITIES)
    const timeout = Math.min(this.#timeout, input.timeoutMs ?? this.#timeout)
    let questions = this.#rubrics.get(input.questions)
    if (questions === undefined) {
      questions = JSON.stringify(Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
        switch (question.type) {
          case 'choice': return [id, { type: 'choice', instructions: question.instructions,
            criteria: question.options }]
          case 'score': return [id, { type: 'score', instructions: question.instructions, criteria: question.levels }]
          case 'boolean': return [id, { type: 'noul', instructions: question.instructions, ...(
            question.criteria === undefined ? {} : { criteria: question.criteria }) }]
        }
      })))
      this.#rubrics.set(input.questions, questions)
    }
    const wire = `{"questions":${questions},"model":${JSON.stringify(
      request.model)},"state":${JSON.stringify(input.state)}}`
    if (new TextEncoder().encode(wire).byteLength > this.#maxRequest) throw new ModelError(
      'TypeSafe request exceeds byte limit', MODEL_ERROR_CODES.INVALID_REQUEST)
    return { input, wire, timeout, provider: request.provider, model: request.model, headers }
  }
  async #evaluate(captured: CapturedTypesafeRequest, context?: ModelInvocationContext): Promise<DecisionResult> {
    const { input, wire, timeout, provider, model } = captured
    const response = await this.#dispatch({
      provider, model, path: 'systemone', body: wire,
      ...(input.signal === undefined ? {} : { callerSignal: input.signal }),
      ...(context === undefined ? {} : { context }),
      decode: value => decodeTypesafeResult(value, input), timeout, publicHeaders: captured.headers,
    })
    const result = response.value as DecisionResult
    return response.requestId === undefined ? result : validateDecisionResult({ ...result,
      providerRequestId: response.requestId }, input.questions)
  }
  async #dispatch(request: TypesafeDispatchRequest) {
    return dispatchTypesafe({
      baseUrl: this.#baseUrl, credential: this.#credential, fetch: this.#fetch, headers: this.#headers,
      maxResponse: this.#maxResponse, timeout: this.#timeout,
    }, request)
  }
}
export function typesafeAdapter(options: TypesafeAdapterOptions): DecisionAdapter {
  return new TypesafeDecisionAdapter(options)
}
export function typesafePlugin(options: TypesafePluginOptions): DecisionProviderPlugin {
  const adapter = typesafeAdapter(options)
  const routes = Object.freeze([...(options.routes ?? ['typesafe'])])
  return defineDecisionProviderPlugin({
    id: options.id ?? 'typesafe', routes,
    setup(registrar) {
      const registration = registrar.registerAdapter(routes, adapter)
      return () => registration.dispose()
    },
  })
}
