/** Validated policy for automatic and manual context compaction. */

export interface AgentCompactionOptions {
  /** Run pressure checks before model steps. Defaults to true. */
  readonly auto?: boolean
  /** Absolute request threshold. When omitted, thresholdRatio uses model metadata. */
  readonly maxInputTokens?: number
  /** Fraction of the model context window that triggers compaction. Defaults to 0.8. */
  readonly thresholdRatio?: number
  /** Recent context retained verbatim as a fraction of the context window. Defaults to 0.2. */
  readonly retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with retainRatio. */
  readonly retainTokens?: number
  readonly summarizationProvider?: string
  readonly summarizationModel?: string
  readonly summarizationEffort?: string
  /** Provider output cap for the checkpoint call. Defaults to 4096. */
  readonly maxSummaryTokens?: number
  /** Additional pressure compactions attempted at one step. Defaults to 1. */
  readonly compactionRetries?: number
  /** Retries after a canonical context-window error. Defaults to 1. */
  readonly maxOverflowRetries?: number
  /** Per-block character cap in the summarizer replay. Defaults to 12,000. */
  readonly maxSummaryInputChars?: number
  /** Cumulative replay payload characters sent to the summarizer. Defaults to 256,000. */
  readonly maxSummaryRequestChars?: number
  /** Maximum serialized summarizer request bytes, including schemas/system text. Defaults to 32 MiB. */
  readonly maxSummaryRequestBytes?: number
  /** Maximum serialized response bytes accepted from the summarizer. Defaults to 8 MiB. */
  readonly maxSummaryResponseBytes?: number
  /** Maximum chunks accepted from the summarizer. Defaults to 50,000. */
  readonly maxSummaryStreamEvents?: number
  /** Total summarizer/model-metadata deadline. Defaults to 10 minutes. */
  readonly summaryTimeoutMs?: number
  /** Maximum wait for a non-cooperative summarizer teardown. Defaults to 30 seconds. */
  readonly teardownTimeoutMs?: number
  /** Text retained in each model-visible tool result before summary selection. Defaults to 24,000. */
  readonly maxToolResultChars?: number
}

export interface AgentCompactionConfig {
  readonly auto: boolean
  readonly maxInputTokens: number | undefined
  readonly thresholdRatio: number
  readonly retainRatio: number | undefined
  readonly retainTokens: number | undefined
  readonly summarizationProvider: string | undefined
  readonly summarizationModel: string | undefined
  readonly summarizationEffort: string | undefined
  readonly maxSummaryTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  readonly maxSummaryInputChars: number
  readonly maxSummaryRequestChars: number
  readonly maxSummaryRequestBytes: number
  readonly maxSummaryResponseBytes: number
  readonly maxSummaryStreamEvents: number
  readonly summaryTimeoutMs: number
  readonly teardownTimeoutMs: number
  readonly maxToolResultChars: number
}

export function resolveCompactionConfig(input: AgentCompactionOptions | undefined): AgentCompactionConfig {
  if (input?.retainRatio !== undefined && input.retainTokens !== undefined) {
    throw new TypeError('agent compaction retainRatio and retainTokens are mutually exclusive')
  }
  if ((input?.summarizationProvider === undefined) !== (input?.summarizationModel === undefined)) {
    throw new TypeError('agent compaction summarizationProvider and summarizationModel must be set together')
  }
  const thresholdRatio = ratio(input?.thresholdRatio ?? 0.8, 'thresholdRatio')
  const retainRatio = input?.retainTokens === undefined
    ? ratio(input?.retainRatio ?? 0.2, 'retainRatio')
    : undefined
  if (retainRatio !== undefined && retainRatio >= thresholdRatio) {
    throw new RangeError('agent compaction retainRatio must be lower than thresholdRatio')
  }
  return Object.freeze({
    auto: input?.auto ?? true,
    maxInputTokens: optionalPositiveInteger(input?.maxInputTokens, 'maxInputTokens'),
    thresholdRatio,
    retainRatio,
    retainTokens: optionalNonNegativeInteger(input?.retainTokens, 'retainTokens'),
    summarizationProvider: optionalNonEmpty(input?.summarizationProvider, 'summarizationProvider'),
    summarizationModel: optionalNonEmpty(input?.summarizationModel, 'summarizationModel'),
    summarizationEffort: optionalNonEmpty(input?.summarizationEffort, 'summarizationEffort'),
    maxSummaryTokens: positiveInteger(input?.maxSummaryTokens ?? 4096, 'maxSummaryTokens'),
    compactionRetries: nonNegativeInteger(input?.compactionRetries ?? 1, 'compactionRetries'),
    maxOverflowRetries: nonNegativeInteger(input?.maxOverflowRetries ?? 1, 'maxOverflowRetries'),
    maxSummaryInputChars: positiveInteger(input?.maxSummaryInputChars ?? 12_000, 'maxSummaryInputChars'),
    maxSummaryRequestChars: positiveInteger(input?.maxSummaryRequestChars ?? 256_000, 'maxSummaryRequestChars'),
    maxSummaryRequestBytes: positiveInteger(input?.maxSummaryRequestBytes ?? 32 * 1024 * 1024, 'maxSummaryRequestBytes'),
    maxSummaryResponseBytes: positiveInteger(input?.maxSummaryResponseBytes ?? 8 * 1024 * 1024, 'maxSummaryResponseBytes'),
    maxSummaryStreamEvents: positiveInteger(input?.maxSummaryStreamEvents ?? 50_000, 'maxSummaryStreamEvents'),
    summaryTimeoutMs: positiveInteger(input?.summaryTimeoutMs ?? 10 * 60_000, 'summaryTimeoutMs'),
    teardownTimeoutMs: positiveInteger(input?.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs'),
    maxToolResultChars: positiveInteger(input?.maxToolResultChars ?? 24_000, 'maxToolResultChars'),
  })
}

function ratio(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(`agent compaction ${name} must be > 0 and < 1`)
  }
  return value
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`agent compaction ${name} must be a positive safe integer`)
  }
  return value
}
function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`agent compaction ${name} must be a non-negative safe integer`)
  }
  return value
}
function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name)
}
function optionalNonNegativeInteger(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, name)
}
function optionalNonEmpty(value: string | undefined, name: string): string | undefined {
  if (value !== undefined && value.trim().length === 0) {
    throw new TypeError(`agent compaction ${name} must be non-empty`)
  }
  return value
}
