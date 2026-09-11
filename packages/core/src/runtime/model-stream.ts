import type { ModelAdapter, PreparedAdapterCall } from '../contract/adapter.ts'
import { callConfigEquals, type CallConfig } from '../contract/call-config.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import { isNativeToolSchema } from '../contract/tool.ts'
import type { ProviderInfo, ResolvedModelInfo } from '../contract/model-info.ts'
import type { ResolvedRetryPolicy } from '../contract/retry-policy.ts'
import { normalizeModelFailure } from '../errors/failure.ts'
import { MODEL_ERROR_CODES, ModelError, REGISTRY_ERROR_CODES } from '../errors/model-error.ts'
import {
  contentHasDocument, contentHasImage, projectDocumentsForTextModel, projectImagesForTextModel,
} from '../message/projection.ts'
import type { ModelInvocationContext } from '../observation/report.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import { waitForSettlement } from '../async/settlement.ts'
import {
  normalizeResolvedModelInfo,
  projectReplayForAdapter,
  resolveCallWithModelInfo,
} from './model-metadata.ts'

export interface RuntimeAdapterRegistration {
  readonly adapter: ModelAdapter
  readonly provider: ProviderInfo
  readonly retryPolicy: ResolvedRetryPolicy
  readonly pluginId?: string
  readonly family?: string
}

export interface PreparedDispatch {
  readonly registration: RuntimeAdapterRegistration
  readonly config: CallConfig
  readonly modelInfo: ResolvedModelInfo
  readonly dispatch: (options: GenerateOptions, context: ModelInvocationContext) => AsyncIterable<StreamChunk>
}

export interface AdapterStreamInput {
  readonly options: GenerateOptions
  readonly context: ModelInvocationContext
  readonly onDispatch: () => void
  readonly prepared?: PreparedDispatch
  readonly maxCatalogBytes: number
  readonly registration: (provider: string) => RuntimeAdapterRegistration
  readonly registeredAdapter: (provider: string) => ModelAdapter | undefined
}

/** Run one adapter generation through the registry's single failure/cancellation funnel. */
export async function* streamAdapter(input: AdapterStreamInput): AsyncGenerator<StreamChunk> {
  const { options, context } = input
  let iterator: AsyncIterator<StreamChunk>
  try {
    const registration = input.prepared?.registration ?? input.registration(options.provider)
    const adapter = registration.adapter
    const prepared = await prepareDispatch(input, registration, adapter)
    const withConfig = callConfigEquals(options, prepared.config)
      ? options
      : { ...options, ...prepared.config }
    const hasUnsupportedImages = prepared.modelInfo.inputModalities !== undefined
      && !prepared.modelInfo.inputModalities.includes('image')
      && withConfig.messages.some(message => contentHasImage(message.content))
    const hasUnsupportedDocuments = prepared.modelInfo.inputModalities !== undefined
      && !prepared.modelInfo.inputModalities.includes('document')
      && withConfig.messages.some(message => contentHasDocument(message.content))
    if (withConfig.imagePolicy !== undefined && withConfig.imagePolicy !== 'strict' && withConfig.imagePolicy !== 'project') throw new ModelError('invalid image policy', 'INVALID_IMAGE_POLICY')
    if (withConfig.documentPolicy !== undefined && withConfig.documentPolicy !== 'strict' && withConfig.documentPolicy !== 'project') throw new ModelError('invalid document policy', 'INVALID_DOCUMENT_POLICY')
    if (hasUnsupportedImages && withConfig.imagePolicy === 'strict') throw new ModelError(
      `model ${prepared.modelInfo.id} does not support required image input`, 'UNSUPPORTED_IMAGE_INPUT',
    )
    if (hasUnsupportedDocuments && withConfig.documentPolicy === 'strict') throw new ModelError(
      `model ${prepared.modelInfo.id} does not support required document input`, 'UNSUPPORTED_DOCUMENT_INPUT',
    )
    const withImages = hasUnsupportedImages
      ? { ...withConfig, messages: projectImagesForTextModel(withConfig.messages) }
      : withConfig
    const projected = hasUnsupportedDocuments
      ? { ...withImages, messages: projectDocumentsForTextModel(withImages.messages) }
      : withImages
    validateNativeTools(projected, prepared.modelInfo)
    input.onDispatch()
    iterator = prepared.dispatch(projectReplayForAdapter(
      projected, adapter, input.registeredAdapter,
    ), context)[Symbol.asyncIterator]()
  } catch (error: unknown) {
    yield adapterFailureChunk(error, options.signal)
    return
  }
  yield* consumeIterator(iterator, options.signal)
}

async function prepareDispatch(
  input: AdapterStreamInput,
  registration: RuntimeAdapterRegistration,
  adapter: ModelAdapter,
): Promise<{ readonly modelInfo: ResolvedModelInfo; readonly config: CallConfig;
  readonly dispatch: PreparedDispatch['dispatch'] }> {
  const { options, context, prepared } = input
  if (prepared !== undefined) {
    if (!callConfigEquals(options, prepared.config)) {
      throw new ModelError(
        'prepared call config changed before adapter dispatch',
        REGISTRY_ERROR_CODES.INVALID_PREPARED_CALL,
      )
    }
    return { modelInfo: prepared.modelInfo, config: prepared.config, dispatch: prepared.dispatch }
  }
  const adapterCall: PreparedAdapterCall = await adapter.prepareCall(
    options.provider, options.model, options.signal, context,
  )
  const modelInfo = normalizeResolvedModelInfo(
    registration.provider.id, options.model, adapterCall.model, input.maxCatalogBytes,
  )
  return {
    modelInfo,
    config: resolveCallWithModelInfo(options, modelInfo).config,
    dispatch: (request, activeContext) => adapterCall.stream(request, activeContext),
  }
}

function validateNativeTools(options: GenerateOptions, model: ResolvedModelInfo): void {
  if (model.nativeTools === undefined) return
  for (const tool of options.tools ?? []) {
    if (isNativeToolSchema(tool) && !model.nativeTools.includes(tool.name)) {
      throw new ModelError(
        `model "${model.id}" on route "${model.provider}" does not support native tool "${tool.name}"`,
        REGISTRY_ERROR_CODES.UNSUPPORTED_NATIVE_TOOL,
      )
    }
  }
}

async function* consumeIterator(
  iterator: AsyncIterator<StreamChunk>,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let completed = false
  try {
    while (true) {
      let item: { done: true } | { done: false; value: StreamChunk }
      try {
        const next = await iterator.next()
        item = next.done === true ? { done: true } : { done: false, value: next.value }
      } catch (error: unknown) {
        completed = true
        yield adapterFailureChunk(error, signal)
        return
      }
      if (item.done) { completed = true; return }
      yield item.value
    }
  } finally {
    if (!completed) await closeIterator(iterator)
  }
}

async function closeIterator(iterator: AsyncIterator<StreamChunk>): Promise<void> {
  const close = iterator.return?.bind(iterator)
  if (close === undefined) return
  const closing = Promise.resolve().then(async () => { await close() })
  if (!await waitForSettlement(closing, 30_000)) {
    throw new ModelError(
      'model adapter ignored cancellation for more than 30000ms',
      MODEL_ERROR_CODES.TEARDOWN_TIMEOUT,
    )
  }
}

function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeModelFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted === true || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}
