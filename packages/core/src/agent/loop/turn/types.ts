import type { CallConfig } from '../../../contract/index.ts'
import type { ModelOutputFormat, NativeToolSchema, ToolChoice } from '../../../contract/index.ts'
import { type Message } from '../../../message/index.ts'
import type { FinishReason, TokenUsage } from '../../../stream/index.ts'
import type { ToolCallId } from '../../../primitives/index.ts'
import type { ModelRegistry } from '../../../runtime/index.ts'
import type { ModelCallReport } from '../../../observation/index.ts'
import type { RunAccountingPort } from '../../accounting/contracts.ts'
import { History } from '../../history/history.ts'
import type { ApprovalBroker } from '../../tool/approval.ts'
import type { ToolInterceptor, ToolCallRequest } from '../../tool/pipeline.ts'
import type { ToolCatalog } from '../../tool/registry.ts'
import type { SpillStore } from '../../tool/output-budget.ts'
import { type SpanId, type TraceId, type TraceRef } from '../../trace/trace.ts'
import type { AssistantContentTiming, TurnBounds, TurnHooks } from '../types.ts'
import type { SdkLogger } from '../../../logging/types.ts'

export interface RunTurnOptions {
  readonly validateOutput?: (value: unknown) => void
  /** strict rejects known text-only models when request history contains images; project permits lossy conversion. */
  readonly imagePolicy?: 'strict' | 'project'
  readonly registry: ModelRegistry
  readonly config: CallConfig
  readonly history: History
  readonly tools?: ToolCatalog
  /** Tools executed inside the provider response (web search, image generation). */
  readonly nativeTools?: readonly NativeToolSchema[]
  /** Optional provider-neutral selection constraint for host or native tools. */
  readonly toolChoice?: ToolChoice
  /** Visible response format applied only when the loop produces its final answer. */
  readonly outputFormat?: ModelOutputFormat
  readonly system?: string
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly bounds?: Partial<TurnBounds>
  readonly hooks?: TurnHooks
  readonly signal?: AbortSignal
  /** Runtime-bound correlation; optional for the preserved low-level runner. */
  readonly logger?: SdkLogger
  /** Maximum wait for an uncooperative producer after the event consumer stops. Defaults to 30s. */
  readonly teardownTimeoutMs?: number
  /** Total wall-clock allowance for one model stream, including adapter preparation. Defaults to 10m. */
  readonly modelTimeoutMs?: number
  /** Maximum serialized request bytes passed to a model adapter. Defaults to 32 MiB. */
  readonly maxModelRequestBytes?: number
  /** Maximum serialized response bytes accepted from one model stream. Defaults to 32 MiB. */
  readonly maxModelResponseBytes?: number
  /** Maximum chunks accepted from one model stream. Defaults to 100,000. */
  readonly maxModelStreamEvents?: number
  /** Maximum wall time for one policy/lifecycle hook. Defaults to 10 minutes. */
  readonly hookTimeoutMs?: number
  /** Maximum wait after a timed-out hook ignores cancellation. Defaults to 30 seconds. */
  readonly hookTeardownTimeoutMs?: number
  /** Ask the model for concise user-visible progress narration around tool use. */
  readonly commentary?: 'auto' | 'concise' | 'off'
  readonly trace?: {
    readonly traceId?: TraceId
    readonly parentSpanId?: SpanId
    readonly conversationId?: string
    readonly agentId?: string
    readonly agentName?: string
  }
  /** Internal canonical accounting surface supplied by AgentSession. */
  readonly accounting?: RunAccountingPort
  /**
   * Where oversized tool output is saved instead of being cut.
   *
   * Mounting one switches the default `auto` policy from truncating to
   * spilling, so nothing the model asked for is lost — it reads a preview and
   * retrieves the rest.
   */
  readonly spillStore?: SpillStore
}

/** Internal request phase: structured process rounds defer the caller's final format. */
export type ModelRoundPhase = 'standard' | 'process' | 'final' | 'forced-final'

export interface RoundResult {
  readonly trace: TraceRef
  readonly message?: Message
  readonly finish: FinishReason
  readonly usage?: TokenUsage
  readonly report?: ModelCallReport
  readonly usageRequired?: boolean
  readonly usageUnavailable?: boolean
  readonly calls: readonly ToolCallRequest[]
  /**
   * Tool-call ids the provider repeated, which were dropped rather than run.
   *
   * Two calls cannot share one id — a result pairs to exactly one — so the
   * repeat goes and the first one stands. Reported so the model can be told
   * what happened instead of silently receiving one result for two calls.
   */
  readonly droppedDuplicateCalls?: readonly string[]
  readonly afterToolCallIds: readonly ToolCallId[]
  readonly timing: AssistantContentTiming
}
