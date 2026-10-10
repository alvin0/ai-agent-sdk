import { ModelError, MODEL_ERROR_CODES, resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core/provider'
import { DecisionAdapter, defineDecisionProviderPlugin, snapshotDecisionInput, validateDecisionResult,
  type DecisionInput, type DecisionModelInfo, type DecisionProviderPlugin, type DecisionRequest,
  type DecisionResult, type PreparedDecisionCall } from '@alvin0/ai-agent-sdk-decision-adapter'
import { dispatchDecisionHttp, type DecisionHttpHost } from '@alvin0/ai-agent-sdk-decision-adapter/transport'
import { baseUrl, bound, CAPABILITIES, captureCredential, captureHeaders, invocationHeaders,
  safetyIdentifier } from './configuration.ts'
import { decodeDecision } from './decode.ts'
import { responseUsage } from './response.ts'
import type { OpenAiDecisionAdapterOptions, OpenAiDecisionPluginOptions } from './types.ts'
import { decisionWire } from './wire.ts'

interface CapturedDecision {
  readonly input: DecisionInput
  readonly wire: string
  readonly provider: string
  readonly model: string
  readonly headers: Readonly<Record<string, string>>
}
class OpenAiDecisionAdapter extends DecisionAdapter {
  readonly #host: DecisionHttpHost
  readonly #maxRequest: number
  readonly #safetyIdentifier: string | undefined
  readonly #retry: ReturnType<typeof resolveRetryPolicy> | undefined
  constructor(options: OpenAiDecisionAdapterOptions) {
    super()
    this.#host = Object.freeze({ label: 'OpenAI Decisions', baseUrl: baseUrl(options),
      credential: captureCredential(options.apiKey), fetch: options.fetch ?? globalThis.fetch,
      headers: captureHeaders(options.headers), timeout: bound(options.requestTimeoutMs, 30_000, 'requestTimeoutMs'),
      maxResponse: bound(options.maxResponseBytes, 4_194_304, 'maxResponseBytes'), readUsage: responseUsage })
    this.#maxRequest = bound(options.maxRequestBytes, 2_097_152, 'maxRequestBytes')
    this.#safetyIdentifier = safetyIdentifier(options.safetyIdentifier)
    this.#retry = options.retryPolicy === undefined ? undefined : resolveRetryPolicy(options.retryPolicy,
      'openaiDecisions.retryPolicy')
  }
  override providerRetryPolicy(): ReturnType<typeof resolveRetryPolicy> | undefined { return this.#retry }
  override async resolveModel(provider: string, model: string): Promise<DecisionModelInfo> {
    return Object.freeze({ provider, id: model, name: model, capabilities: CAPABILITIES })
  }
  /** Known native Decisions model; generation /models does not advertise this capability. */
  override async listModels(provider: string): Promise<readonly DecisionModelInfo[]> {
    return Object.freeze([await this.resolveModel(provider, 'gpt-6-luna')])
  }
  override async prepareDecisionCall(provider: string, model: string, _signal?: AbortSignal,
    context?: ModelInvocationContext): Promise<PreparedDecisionCall> {
    const headers = invocationHeaders(context)
    let captured: { readonly request: DecisionRequest; readonly value: CapturedDecision } | undefined
    return Object.freeze({ model: await this.resolveModel(provider, model), evaluate: (
      request: DecisionRequest, invocation = context) => {
      if (request.provider !== provider || request.model !== model) throw new ModelError(
        'Prepared OpenAI decision target does not match request', MODEL_ERROR_CODES.INVALID_REQUEST)
      if (captured && captured.request !== request) throw new ModelError(
        'Prepared OpenAI decision call cannot dispatch a different request', MODEL_ERROR_CODES.INVALID_REQUEST)
      captured ??= { request, value: this.#capture(request,
        invocation === context ? headers : invocationHeaders(invocation)) }
      return this.#evaluate(captured.value, invocation)
    } })
  }
  override async evaluate(request: DecisionRequest, context?: ModelInvocationContext): Promise<DecisionResult> {
    return this.#evaluate(this.#capture(request, invocationHeaders(context)), context)
  }
  #capture(request: DecisionRequest, headers: Readonly<Record<string, string>>): CapturedDecision {
    if (!validIdentifier(request.provider) || !validIdentifier(request.model)) throw new ModelError(
      'OpenAI Decisions requires provider and model identifiers', MODEL_ERROR_CODES.INVALID_REQUEST)
    const input = snapshotDecisionInput(request, CAPABILITIES)
    const wire = decisionWire(input, request.model, this.#safetyIdentifier)
    if (new TextEncoder().encode(wire).byteLength > this.#maxRequest) throw new ModelError(
      'OpenAI Decisions request exceeds byte limit', MODEL_ERROR_CODES.INVALID_REQUEST)
    return { input, wire, provider: request.provider, model: request.model, headers }
  }
  async #evaluate(captured: CapturedDecision, context?: ModelInvocationContext): Promise<DecisionResult> {
    const { input, wire, provider, model, headers } = captured
    const response = await dispatchDecisionHttp(this.#host, {
      provider, model, path: 'decisions', body: wire, publicHeaders: headers,
      timeout: Math.min(this.#host.timeout, input.timeoutMs ?? this.#host.timeout),
      ...(input.signal === undefined ? {} : { callerSignal: input.signal }),
      ...(context === undefined ? {} : { context }), decode: value => decodeDecision(value, input),
    })
    const result = response.value as DecisionResult
    return response.requestId === undefined ? result : validateDecisionResult({ ...result,
      providerRequestId: response.requestId }, input.questions)
  }
}
function validIdentifier(value: string): boolean {
  return typeof value === 'string' && !!value.trim() && value.length <= 256
}
export function openAiDecisionAdapter(options: OpenAiDecisionAdapterOptions): DecisionAdapter {
  return new OpenAiDecisionAdapter(options)
}
export function openAiDecisionPlugin(options: OpenAiDecisionPluginOptions): DecisionProviderPlugin {
  const adapter = openAiDecisionAdapter(options)
  const routes = Object.freeze([...(options.routes ?? ['openai'])])
  return defineDecisionProviderPlugin({ id: options.id ?? 'openai-decisions', routes,
    setup(registrar) {
      const registration = registrar.registerAdapter(routes, adapter)
      return () => registration.dispose()
    } })
}
