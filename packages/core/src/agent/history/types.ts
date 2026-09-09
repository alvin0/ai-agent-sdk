import type { Message } from '../../message/index.ts'
import type { TokenUsage } from '../../stream/index.ts'
import type { ToolCallId } from '../../primitives/index.ts'
import type { ToolExecutionResult } from '../tool/definition.ts'

export type SurfaceOp = 'append' | {
  readonly op: 'replace'
  /** Backward-compatible inclusive log range for simple replacements. */
  readonly from: number
  readonly to: number
  /** Exact current-surface nodes, required when prior replacements made seqs non-contiguous. */
  readonly targets?: readonly number[]
}

/** Shared persisted/runtime compaction backoff vocabulary. */
export type CompactionBackoffReason = 'low-savings' | 'unreachable-threshold'

export type HistoryEvent =
  | { readonly kind: 'user'; readonly message: Message }
  | {
    readonly kind: 'assistant'
    readonly message: Message
    readonly interrupted?: true
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'tool-call'
    readonly callId: ToolCallId
    readonly name: string
    readonly rawArguments: string
  }
  | {
    readonly kind: 'tool-result'
    readonly callId: ToolCallId
    readonly message: Message
    readonly result: ToolExecutionResult
  }
  | {
    readonly kind: 'compaction-start'
    readonly compactionId: string
    readonly trigger: 'pressure' | 'context-overflow' | 'manual'
    readonly at: string
  }
  | {
    readonly kind: 'compaction-prune'
    readonly callId: ToolCallId
    readonly originalSeq: number
    readonly charsBefore: number
    readonly charsAfter: number
  }
  | {
    readonly kind: 'compaction-summary'
    readonly compactionId: string
    readonly summary: string
    readonly shadowedSeqs: readonly number[]
    readonly estimatedTokensBefore: number
    readonly estimatedTokensAfter: number
    readonly provider: string
    readonly model: string
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'compaction-end'
    readonly compactionId: string
    readonly status: 'completed' | 'failed'
    readonly at: string
    readonly thresholdTokens?: number
    readonly estimatedNonCompactableTokens?: number
    readonly backoffReason?: CompactionBackoffReason
    readonly cooldownSteps?: number
    readonly error?: string
  }

export interface HistoryEntry {
  readonly seq: number
  readonly event: HistoryEvent
  readonly surfaceOp: SurfaceOp
}

export interface HistorySnapshot {
  readonly version: 1
  readonly entries: readonly HistoryEntry[]
}

export interface HistoryLimits {
  /** Maximum append-only entries retained by one in-memory history. Defaults to 100,000. */
  readonly maxEntries?: number
  /** Maximum serialized bytes for one entry. Defaults to 16 MiB. */
  readonly maxEntryBytes?: number
  /** Maximum cumulative serialized entry bytes. Defaults to 128 MiB. */
  readonly maxBytes?: number
}

export interface ResolvedHistoryLimits {
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxBytes: number
}
