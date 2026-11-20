import { AgentSdkError, defineModelProviderPlugin, type ModelInvocationContext, type ModelTarget,
  type CredentialCommitInput, type CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import { resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import {
  HttpModelAdapter, endpointHeaders, mergeRequestBody, observeCredentialOperation, observeModelCatalogOperation,
  type HttpConnection, type ProviderCatalogModel, type ProviderRequest,
  type ProtocolSseEvent, type RuntimeHttpProviderOptions,
} from '@alvin0/ai-agent-sdk-provider-http'
import { createAntigravityCredentialResolver } from './auth.ts'
import { ANTIGRAVITY_BASE_URL } from './config.ts'
import { abortable, endpoint, NULL_LOGGER, object, requestJson } from './http.ts'
import { antigravityHeaders } from './oauth.ts'
import { serializeAntigravityRequest } from './serialize.ts'
import { translateAntigravityStream } from './translate.ts'
import type { AntigravityAuthFile, AntigravityCredentialStore, AntigravityOAuthOptions } from './types.ts'
import { isAntigravityImageModel } from './image.ts'

type TransportOptions = Pick<RuntimeHttpProviderOptions<object>,
  'defaultMaxTokens' | 'defaultContextWindow' | 'streamIdleTimeoutMs' | 'requestTimeoutMs'
  | 'maxRequestBytes' | 'maxResponseBytes' | 'maxResponseChunks' | 'maxSseEvents' | 'maxSseEventChars'
  | 'maxErrorBodyBytes' | 'requestLoggerTimeoutMs' | 'requestLogger' | 'responseLogger'>

export interface AntigravityProviderOptions extends AntigravityOAuthOptions, TransportOptions {
  readonly authStore: AntigravityCredentialStore
  /** Advisory catalog override. Omit to discover models available to this account. */
  readonly models?: readonly ProviderCatalogModel[]
}

export interface AntigravityPluginOptions extends AntigravityProviderOptions {
  readonly id?: string
  readonly routes?: readonly string[]
  readonly defaultModel?: string | ModelTarget
}

interface AntigravityConnection extends HttpConnection { readonly projectId: string; readonly sessionId: string }

/** Capture a revisioned store without invoking user accessors or storage during construction. */
function captureStore(store: AntigravityCredentialStore): AntigravityCredentialStore {
  const data = (key: keyof AntigravityCredentialStore): unknown => {
    let owner: object | null = store
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      if (descriptor !== undefined) {
        if (!('value' in descriptor)) throw new TypeError('Antigravity credential store must not use accessors')
        return descriptor.value
      }
      owner = Object.getPrototypeOf(owner)
    }
    return undefined
  }
  if (store === null || typeof store !== 'object' || data('kind') !== 'credential-store' || data('apiVersion') !== 1) {
    throw new TypeError('Antigravity requires a revisioned credential store')
  }
  const read = data('read')
  const commit = data('commit')
  const id = data('id')
  const label = data('label')
  if (typeof read !== 'function' || typeof commit !== 'function') {
    throw new TypeError('Invalid Antigravity credential store methods')
  }
  if (!validIdentity(id) || !validIdentity(label)) throw new TypeError('Invalid Antigravity credential store identity')
  return Object.freeze({ kind: 'credential-store', apiVersion: 1, id, label,
    read: (options: CredentialOperationOptions) =>
      Reflect.apply(read, store, [options]) as ReturnType<AntigravityCredentialStore['read']>,
    commit: (input: CredentialCommitInput<AntigravityAuthFile>, options: CredentialOperationOptions) =>
      Reflect.apply(commit, store, [input, options]) as ReturnType<AntigravityCredentialStore['commit']>,
  })
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024
}

function operationSignal(timeout: number, ...signals: (AbortSignal | undefined)[]): AbortSignal {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new TypeError('Invalid requestTimeoutMs')
  }
  const deadline = AbortSignal.timeout(timeout)
  return AbortSignal.any([deadline, ...signals.filter(signal => signal !== undefined)])
}

function catalogModel([id, value]: [string, unknown]): ProviderCatalogModel[] {
  const model = object(value)
  if (model.isInternal === true || model.disabled === true) return []
  return [{ id, ...(typeof model.displayName === 'string' ? { name: model.displayName } : {}),
    ...catalogLimits(model),
    outputModalities: isAntigravityImageModel(id) ? ['text', 'image'] : ['text'], nativeTools: [],
  }]
}

function catalogLimits(model: Record<string, unknown>) {
  const context = positiveTokenLimit(model.maxTokens)
  const output = positiveTokenLimit(model.maxOutputTokens)
  // Cloud Code can report an output limit equal to its context window. That is
  // not an SDK combined-window ceiling with input headroom. Keep the advertised
  // context and omit the contradictory output ceiling instead of inventing capacity.
  const usableOutput = output !== undefined && (context === undefined || output < context)
  return { ...(context === undefined ? {} : { contextWindow: context }),
    ...(usableOutput ? { maxTokens: output } : {}) }
}

function positiveTokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

class AntigravityAdapter extends HttpModelAdapter {
  protected readonly displayName = 'Antigravity'
  private readonly credentials: ReturnType<typeof createAntigravityCredentialResolver>
  private readonly baseUrl: string
  private catalog: { key: string; expiresAt: number; models: readonly ProviderCatalogModel[] } | undefined

  constructor(private readonly options: AntigravityProviderOptions) {
    super()
    const responseLogger = options.responseLogger
    if (responseLogger !== undefined) this.observeResponse = responseLogger
    this.baseUrl = endpoint(options.baseUrl ?? ANTIGRAVITY_BASE_URL, options.allowInsecureHttp).href.replace(/\/$/, '')
    this.credentials = createAntigravityCredentialResolver(captureStore(options.authStore), options)
  }

  protected override async connect(
    provider: string, signal?: AbortSignal, context?: ModelInvocationContext, model?: string,
  ): Promise<AntigravityConnection> {
    const bounded = operationSignal(this.options.requestTimeoutMs ?? 30_000, signal, this.options.signal)
    bounded.throwIfAborted()
    const customHeaders = endpointHeaders(context?.providerOptions?.headers)({ provider })
    const file = await observeCredentialOperation(context, provider, 'resolve', () =>
      abortable(this.credentials({ signal: bounded, logger: context?.logger ?? NULL_LOGGER }), bounded))
    const headers = antigravityHeaders(file.tokens.access_token, this.options)
    const models = await this.catalogModels(file, headers, { signal: bounded, provider, context })
    return {
      ...this.options, baseUrl: this.baseUrl, models, projectId: file.projectId,
      sessionId: context?.correlation?.sessionId ?? crypto.randomUUID(),
      retryPolicy: resolveRetryPolicy(undefined, 'Antigravity.retryPolicy'),
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs ?? 300_000,
      ...this.imageStreamLimit(model, models),
      endpointHeaders: customHeaders, headers,
    }
  }

  private imageStreamLimit(model: string | undefined, models: readonly ProviderCatalogModel[]) {
    if (this.options.maxSseEventChars !== undefined) return { maxSseEventChars: this.options.maxSseEventChars }
    if (model === undefined) return {}
    const image = isAntigravityImageModel(model) || models.find(entry => entry.id === model)
      ?.outputModalities?.includes('image') === true
    // Same 12 MiB image-event bound as the shared native image-generation pipeline.
    return image ? { maxSseEventChars: 12 * 1_048_576 } : {}
  }

  private async catalogModels(
    file: AntigravityAuthFile, headers: Record<string, string>,
    operation: { signal: AbortSignal; provider: string; context: ModelInvocationContext | undefined },
  ): Promise<readonly ProviderCatalogModel[]> {
    const { signal, provider, context } = operation
    if (this.options.models !== undefined) return this.options.models
    const key = `${file.projectId}:${file.tokens.refresh_token}`
    if (this.catalog?.key === key && this.catalog.expiresAt > Date.now()) return this.catalog.models
    const body = await observeModelCatalogOperation(context, provider, new URL(this.baseUrl).origin, () =>
      requestJson(`${this.baseUrl}/v1internal:fetchAvailableModels`, {
        method: 'POST', headers, body: JSON.stringify({ project: file.projectId }),
      }, { ...this.options, signal }))
    const entries = Object.entries(object(body.models))
    if (entries.length > 1_024) {
      throw new AgentSdkError('Antigravity catalog exceeds 1024 models', 'MALFORMED_RESPONSE')
    }
    const models = entries.flatMap(catalogModel)
    this.catalog = { key, models, expiresAt: Date.now() + 60_000 }
    return models
  }

  protected override endpointPath(): string { return '/v1internal:streamGenerateContent?alt=sse' }

  protected override buildBody(request: ProviderRequest): unknown {
    const body = request.providerOptionsBody ?? {}
    const reserved = ['project', 'model', 'requestId', 'requestType', 'userAgent', 'request', 'sessionId']
    if (reserved.some(field => Object.hasOwn(body, field))) {
      throw new AgentSdkError('Antigravity routing and session fields are provider-owned', 'INVALID_REQUEST')
    }
    return {
      project: (request.connection as AntigravityConnection).projectId,
      model: request.options.model, requestType: 'agent', userAgent: 'antigravity',
      requestId: `agent-${crypto.randomUUID()}`,
      request: { ...mergeRequestBody(serializeAntigravityRequest(request), body),
        sessionId: (request.connection as AntigravityConnection).sessionId },
    }
  }

  protected override translate(events: AsyncIterable<ProtocolSseEvent>) {
    return translateAntigravityStream(events)
  }

  protected override observeRequest(record: Parameters<NonNullable<TransportOptions['requestLogger']>>[0]) {
    return this.options.requestLogger?.(record)
  }
}

export function antigravityAdapter(options: AntigravityProviderOptions): HttpModelAdapter {
  return new AntigravityAdapter({ ...options })
}

export function antigravityPlugin(options: AntigravityPluginOptions) {
  const id = options.id ?? 'antigravity'
  const routes = Object.freeze([...(options.routes ?? [id])])
  if (typeof options.defaultModel === 'string' && routes.length !== 1) {
    throw new TypeError('A string defaultModel requires exactly one Antigravity route')
  }
  // Capture at construction; no credential read or network traffic happens here.
  const adapter = antigravityAdapter(options)
  return defineModelProviderPlugin({ id, routes, family: 'antigravity', displayName: 'Antigravity',
    ...(options.defaultModel === undefined ? {} : { defaultModel: typeof options.defaultModel === 'string'
      ? { provider: routes[0]!, id: options.defaultModel } : options.defaultModel }),
    setup(registrar) {
      const remove = registrar.registerAdapter(adapter)
      return () => { remove(); return undefined }
    },
  })
}
