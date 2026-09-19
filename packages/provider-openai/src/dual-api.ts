/**
 * One route, two OpenAI wires: Responses for some models, Chat Completions for
 * others — chosen per model id, from `models[].api`.
 *
 * ## Why a delegating adapter rather than a composite protocol
 *
 * `provider-copilot`'s `copilotDualProtocol` solves the same shape of problem
 * (Requirement 9 there) by building one `RuntimeWireProtocol` whose
 * `endpointPath`/`serialize`/`translate` each branch on `request.model.id`, so
 * a single `HttpModelAdapter` instance still owns one shared connection.
 *
 * That approach earns its complexity when the two wires must share one
 * connection (Copilot's device-code credential, one client identity for
 * both). Here they do not: Responses and Chat Completions each already have
 * their own complete, independently-tested `createHttpProvider` wiring in
 * `./adapter.ts`, and `ModelAdapter` (`@alvin0/ai-agent-sdk-core`) is an
 * abstract class with exactly one required method (`stream`) and sensible
 * defaults for the rest — built specifically so "one adapter instance can
 * serve many routes" (see its own module doc). A facade that HOLDS two
 * complete adapters and delegates each call by model id reuses both wires
 * exactly as built, with no new protocol-level branching to keep in sync
 * with either one's own evolution.
 *
 * @module ai-agent-sdk/providers/openai/dual-api
 */

import {
  ModelAdapter,
  type GenerateOptions,
  type ModelCatalogOptions,
  type ModelCatalogSnapshot,
  type ModelInfo,
  type ModelInvocationContext,
  type PreparedAdapterCall,
  type ProviderInfo,
  type ResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'

/** Which OpenAI wire one exact model id speaks. */
export type OpenAiApi = 'responses' | 'chat-completions'

/**
 * Delegates every call to whichever underlying adapter the model id maps to,
 * falling back to `defaultApi` for an id neither catalog named explicitly.
 */
export class OpenAiDualApiAdapter extends ModelAdapter {
  readonly #responses: ModelAdapter
  readonly #chat: ModelAdapter
  readonly #apiOf: ReadonlyMap<string, OpenAiApi>
  readonly #defaultApi: OpenAiApi

  constructor(
    responses: ModelAdapter,
    chat: ModelAdapter,
    apiOf: ReadonlyMap<string, OpenAiApi>,
    defaultApi: OpenAiApi,
  ) {
    super()
    this.#responses = responses
    this.#chat = chat
    this.#apiOf = apiOf
    this.#defaultApi = defaultApi
  }

  #adapterFor(model: string): ModelAdapter {
    return (this.#apiOf.get(model) ?? this.#defaultApi) === 'chat-completions' ? this.#chat : this.#responses
  }

  override providerInfo(provider: string): ProviderInfo {
    return this.#responses.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.#responses.providerRetryPolicy(provider)
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    const [responsesModels, chatModels] = await Promise.all([
      this.#responses.listModels(provider, signal),
      this.#chat.listModels(provider, signal),
    ])
    return Object.freeze([...responsesModels, ...chatModels])
  }

  override async modelCatalog(
    provider: string,
    options: ModelCatalogOptions = {},
  ): Promise<ModelCatalogSnapshot> {
    const [responsesCatalog, chatCatalog] = await Promise.all([
      this.#responses.modelCatalog(provider, options),
      this.#chat.modelCatalog(provider, options),
    ])
    const models = Object.freeze([...responsesCatalog.models, ...chatCatalog.models])
    return Object.freeze({
      provider: responsesCatalog.provider,
      state: models.length === 0 ? 'empty' as const : 'fresh' as const,
      revision: `dual-api:${responsesCatalog.revision}+${chatCatalog.revision}`,
      models,
      observedAt: new Date().toISOString(),
    })
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return this.#adapterFor(model).resolveModel(provider, model, signal)
  }

  override prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall> {
    return this.#adapterFor(model).prepareCall(provider, model, signal, context)
  }

  override stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    return this.#adapterFor(options.model).stream(options, context)
  }
}
