import { ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import {
  type ModelModality,
} from '@alvin0/ai-agent-sdk-core/provider'
import type {
  ProviderCatalogModel,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  type ModelDiscoveryContext,
} from '@alvin0/ai-agent-sdk-provider-http'
import { rejectCodexRedirect } from './common/no-follow.ts'
import type { WireCatalogModel } from './adapter-types.ts'

/**
 * Keep only the modalities this SDK has a vocabulary for.
 *
 * Discovery is the sole source of Codex capability data, so an unrecognized value
 * has to be dropped rather than guessed at — but `file` is accepted as a spelling
 * of `document`, because the upstream catalog names the PDF modality that way and
 * dropping it would silently strip every document from the request.
 */
export function catalogModalities(values: readonly string[] | undefined): readonly ModelModality[] {
  return (values ?? []).flatMap((value): ModelModality[] => {
    if (value === 'text' || value === 'image' || value === 'document') return [value]
    if (value === 'file' || value === 'pdf') return ['document']
    return []
  })
}

/** Read `/models`, which requires — and is gated on — a client version. */
export async function discoverCodexModels(
  context: ModelDiscoveryContext,
  clientVersion: string,
  limits: {
    readonly maxBytes: number
    readonly maxModels: number
    readonly maxChunks: number
    readonly timeoutMs: number
  },
  fetchImpl: typeof globalThis.fetch,
): Promise<readonly ProviderCatalogModel[]> {
  const url = `${context.baseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout])
  const response = await fetchImpl(url, {
    headers: context.headers,
    signal,
    redirect: 'manual',
  })
  await rejectCodexRedirect(response, url, 'model catalog', 30_000)
  if (!response.ok) return []
  const body = await readCatalogJson(response, limits.maxBytes, limits.maxChunks, signal)
  const models = Array.isArray(body.models) ? body.models as WireCatalogModel[] : []
  if (models.length > limits.maxModels) {
    throw new RangeError(`Codex model catalog exceeds the ${limits.maxModels}-model limit`)
  }
  return models.flatMap(catalogModel)
}

export async function readCatalogJson(
  response: Response,
  maxBytes: number,
  maxChunks: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  await checkDeclaredSize(response, maxBytes)
  if (response.body === null) throw new TypeError('Codex model catalog returned no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let chunkCount = 0
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal)
      if (next.done) break
      if (next.value === undefined) continue
      chunkCount++
      if (chunkCount > maxChunks) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        throw new RangeError(`Codex model catalog exceeds the ${maxChunks}-chunk limit`)
      }
      bytes += next.value.byteLength
      if (bytes > maxBytes) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        throw new RangeError(`Codex model catalog exceeds the ${maxBytes}-byte limit`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return parseCatalogChunks(chunks, bytes)
}

export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Codex catalog request aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Codex catalog request aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Codex ${field} must be a positive safe integer`)
  return value
}

function catalogModel(entry: WireCatalogModel): ProviderCatalogModel[] {
  if (typeof entry.slug !== 'string' || entry.slug.length === 0) return []
  const modalities = catalogModalities(entry.input_modalities)
  const outputModalities = catalogModalities(entry.output_modalities)
  const efforts = catalogEfforts(entry)
  return [{
    id: entry.slug,
    ...entry.display_name === undefined ? {} : { name: entry.display_name },
    ...entry.description === undefined ? {} : { description: entry.description },
    ...modalities.length > 0 ? { inputModalities: modalities } : {},
    ...outputModalities.length > 0 ? { outputModalities } : {},
    ...catalogCapacity(entry),
    ...efforts.length === 0 ? {} : { reasoning: { efforts } },
  }]
}

function catalogEfforts(entry: WireCatalogModel) {
  return (entry.supported_reasoning_levels ?? []).flatMap((candidate) => {
    if (typeof candidate.effort !== 'string' || candidate.effort.length === 0) return []
    return [{
      id: ReasoningEffortId(candidate.effort),
      name: candidate.effort,
      ...candidate.description === undefined ? {} : { description: candidate.description },
    }]
  })
}

function catalogCapacity(entry: WireCatalogModel) {
  return {
    ...typeof entry.context_window === 'number'
      && Number.isSafeInteger(entry.context_window) && entry.context_window > 0
      ? { defaultContextWindow: entry.context_window }
      : {},
    ...typeof entry.max_context_window === 'number' && Number.isSafeInteger(entry.max_context_window)
      && entry.max_context_window >= (entry.context_window ?? 1)
      ? { maxContextWindow: entry.max_context_window } : {},
  }
}

async function checkDeclaredSize(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body !== null) await waitForSettlement(response.body.cancel().catch(() => undefined), 30_000)
    throw new RangeError(`Codex model catalog exceeds the ${maxBytes}-byte limit`)
  }
}

function parseCatalogChunks(chunks: readonly Uint8Array[], bytes: number): Record<string, unknown> {
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(merged))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Codex model catalog must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
