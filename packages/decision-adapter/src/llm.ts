import { captureLlmGeneration, llmResponseLimit } from './llm-configuration.ts'
import { answerSchema, OUTPUT_NAME, SYSTEM, EVIDENCE_SYSTEM } from './llm-schema.ts'
import { runLlmDecision, type CapturedLlmRequest } from './llm-response.ts'
import { createTextMessage, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ModelAdapter, ModelInvocationContext, PreparedAdapterCall,
} from '@alvin0/ai-agent-sdk-core/provider'
import { DecisionAdapter, type PreparedDecisionCall } from './adapter.ts'
import { abortable, throwIfAborted } from './async.ts'
import { defineDecisionProviderPlugin, type DecisionProviderPlugin } from './plugin.ts'
import type { DecisionModelInfo, DecisionQuestions, DecisionRequest, DecisionResult } from './types.ts'
import { bindDecisionInput, decisionError, identifier, snapshotDecisionInput, snapshotJson,
} from './validation.ts'

export interface LlmDecisionAdapterOptions {
  /** Raw, single-attempt SDK adapter. The decision runtime owns retries. */
  readonly adapter: ModelAdapter
  readonly outputMode?: 'json-schema' | 'tool'
  /** Self-reported evidence is opt-in and always tagged model-generated. */
  readonly evidence?: 'none' | 'model-generated'
  readonly generation?: Readonly<Pick<GenerateOptions, 'temperature' | 'topP' | 'maxTokens' | 'reasoningEffort'>>
  /** Includes visible output, tool arguments, and reasoning. Default: 2 MiB. */
  readonly maxResponseBytes?: number
}
export interface LlmDecisionPluginOptions extends LlmDecisionAdapterOptions {
  readonly id: string
  readonly routes: readonly string[]
}

export function llmDecisionAdapter(options: LlmDecisionAdapterOptions): DecisionAdapter {
  return new LlmDecisionAdapter(options) }
export function llmDecisionPlugin(options: LlmDecisionPluginOptions): DecisionProviderPlugin {
  const adapter = llmDecisionAdapter(options)
  const routes = [...options.routes]
  return defineDecisionProviderPlugin({ id: options.id, routes, setup(registrar) { registrar.registerAdapter(
    routes, adapter) } })
}

class LlmDecisionAdapter extends DecisionAdapter {
  readonly #adapter: ModelAdapter
  readonly #mode: 'json-schema' | 'tool'
  readonly #evidence: boolean
  readonly #generation: LlmDecisionAdapterOptions['generation']
  readonly #maxBytes: number
  readonly #rubrics = new WeakMap<DecisionQuestions, { readonly prefix: string;
    readonly output: Pick<GenerateOptions, 'outputFormat' | 'tools' | 'toolChoice'> }>()
  constructor(options: LlmDecisionAdapterOptions) {
    super()
    if (typeof options.adapter?.prepareCall !== 'function' ||
      typeof options.adapter?.stream !== 'function') decisionError('LLM decision requires a model adapter')
    this.#adapter = options.adapter
    this.#mode = options.outputMode ?? 'json-schema'
    if (!['json-schema', 'tool'].includes(this.#mode)) decisionError('Invalid LLM decision output mode')
    if (!['none', 'model-generated'].includes(options.evidence ?? 'none')) decisionError(
      'Invalid LLM decision evidence mode')
    this.#evidence = options.evidence === 'model-generated'
    this.#generation = captureLlmGeneration(options.generation)
    this.#maxBytes = llmResponseLimit(options.maxResponseBytes)
  }
  override providerRetryPolicy(provider: string) { return this.#adapter.providerRetryPolicy(provider) }
  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly DecisionModelInfo[]> {
    return Object.freeze((await this.#adapter.listModels(provider, signal)).map(model => Object.freeze({
      provider: model.provider, id: model.id, name: model.name })))
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<DecisionModelInfo> {
    const resolved = await this.#adapter.resolveModel(provider, model, signal)
    return Object.freeze({ provider: resolved.provider, id: resolved.id, name: resolved.name })
  }
  override async prepareDecisionCall(provider: string, model: string, signal?: AbortSignal,
    context?: ModelInvocationContext): Promise<PreparedDecisionCall> {
    const cancellation = signal ?? new AbortController().signal
    throwIfAborted(cancellation)
    const prepared = await abortable(this.#adapter.prepareCall(provider, model, cancellation, context), cancellation)
    const info = prepared.model
    const metadata = Object.freeze({ provider: info.provider, id: info.id, name: info.name })
    let captured: { readonly request: DecisionRequest; readonly value: CapturedLlmRequest } | undefined
    return Object.freeze({ model: metadata, evaluate: (request: DecisionRequest, invocation = context) => {
      if (request.provider !== provider || request.model !== model) decisionError(
        'Prepared LLM decision target does not match request')
      // One prepared generation belongs to one logical call. Transport body caches have the same scope.
      if (captured && captured.request !== request) decisionError(
        'Prepared LLM decision call cannot dispatch a different request')
      captured ??= { request, value: this.#capture(request) }
      return this.#evaluate(prepared, captured.value, invocation)
    } })
  }
  override async evaluate(request: DecisionRequest, context?: ModelInvocationContext): Promise<DecisionResult> {
    const input = snapshotDecisionInput(request)
    const provider = identifier(request.provider, 'Provider route'), model = identifier(request.model, 'Model id')
    const timeout = input.timeoutMs ?? 30_000
    validateLlmTimeout(timeout)
    const controller = new AbortController()
    const forward = () => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forward, { once: true })
    if (input.signal?.aborted) forward()
    const timer = setTimeout(() => controller.abort(new ModelError('LLM decision deadline exceeded',
      'TIMEOUT')), timeout)
    try {
      throwIfAborted(controller.signal)
      const prepared = await this.prepareDecisionCall(provider, model, controller.signal, context)
      if (prepared.model.provider !== provider || prepared.model.id !== model) decisionError(
        'Prepared LLM decision identity mismatch', true)
      return await abortable(prepared.evaluate(bindDecisionInput(input, { signal: controller.signal,
        provider, model, timeoutMs: timeout }), context), controller.signal)
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', forward)
    }
  }
  #capture(request: DecisionRequest): CapturedLlmRequest {
    const input = snapshotDecisionInput(request)
    let rubric = this.#rubrics.get(input.questions)
    if (!rubric) {
      const schema = answerSchema(input.questions, this.#evidence)
      rubric = {
        prefix: `{"questions":${JSON.stringify(input.questions)},"state":`,
        output: this.#mode === 'json-schema'
          ? { outputFormat: Object.freeze({ type: 'json_schema' as const, name: OUTPUT_NAME, schema }) }
          : { tools: Object.freeze([Object.freeze({ name: OUTPUT_NAME,
            description: 'Return the evaluated decisions without executing any action.',
            parameters: schema })]), toolChoice: Object.freeze({ type: 'tool' as const, name: OUTPUT_NAME }) },
      }
      this.#rubrics.set(input.questions, rubric)
    }
    return {
      input,
      generation: Object.freeze({
        ...this.#generation, provider: request.provider, model: request.model,
        system: this.#evidence ? EVIDENCE_SYSTEM : SYSTEM,
        messages: Object.freeze([snapshotJson(createTextMessage(`${rubric.prefix}${JSON.stringify(input.state)}}`))]),
        ...rubric.output,
      }),
    }
  }
  async #evaluate(prepared: PreparedAdapterCall, captured: CapturedLlmRequest,
    context?: ModelInvocationContext): Promise<DecisionResult> {
    return runLlmDecision(prepared, captured, {
      mode: this.#mode, evidence: this.#evidence, maxBytes: this.#maxBytes,
    }, context)
  }
}

function validateLlmTimeout(timeout: number): void {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) decisionError(
    'Invalid LLM decision timeout')
}
