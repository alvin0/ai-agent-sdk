/** Host-only team facts. Emitted through AgentTeamEvent; never injected into model history. */
import type { RunUsageReport } from '../accounting/report.ts'
import type { ExhaustedBudget } from '../loop/events.ts'
import type { OperationStatus } from '../../observation/event.ts'

export type TeamWakeReason = 'settlement' | 'synthesis' | 'steering' | 'message' | 'host'
export type TeamSettlementStatus = 'completed' | 'failed' | 'timeout' | 'cancelled'

export interface TeamActivation {
  readonly source: TeamWakeReason | 'initial' | 'follow-up'
  readonly sender?: string
}
export type TeamSpawnRejection = 'capacity' | 'duplicate' | 'invalid' | 'setup'

export type TeamTimelineData =
  | { readonly kind: 'spawn-requested'; readonly member: string; readonly context: 'fresh' | 'fork' }
  | { readonly kind: 'spawn-accepted'; readonly member: string }
  | { readonly kind: 'spawn-rejected'; readonly member: string; readonly reason: TeamSpawnRejection;
      readonly code: string; readonly busy: number; readonly preparing: number; readonly limit: number }
  | { readonly kind: 'spawn-failed'; readonly member: string; readonly reason: 'setup'; readonly code: string }
  | { readonly kind: 'slot-released' | 'member-closed'; readonly member: string }
  | { readonly kind: 'lead-returned' | 'team-joined'; readonly member: string;
      readonly busy: number; readonly preparing: number }
  | { readonly kind: 'member-started'; readonly member: string; readonly runId: string;
      readonly conversationId?: string; readonly activation: TeamActivation }
  | { readonly kind: 'member-settled'; readonly member: string; readonly runId: string;
      readonly status: OperationStatus; readonly durationMs: number; readonly usage: RunUsageReport }
  | { readonly kind: 'worker-settled'; readonly member: string; readonly status: TeamSettlementStatus;
      readonly runId?: string; readonly usage?: RunUsageReport }
  | { readonly kind: 'model-requested'; readonly member: string; readonly runId: string;
      readonly conversationId?: string }
  | { readonly kind: 'lead-yielded'; readonly member: string; readonly reason: 'host' | 'workers' | 'capacity' }
  | { readonly kind: 'lead-woken'; readonly member: string; readonly reason: TeamWakeReason }
  | { readonly kind: 'wasted-wake'; readonly member: string; readonly reason: 'no-new-team-information' }
  | { readonly kind: 'notice-delivered'; readonly member: string; readonly workers: readonly string[];
      readonly delivery: 'mailbox' | 'injection' }
  | { readonly kind: 'budget'; readonly member: string;
      readonly budget: ExhaustedBudget | 'workers' | 'peer-turns' | 'synthesis' | 'pending-inputs'
        | 'collaboration-join';
      readonly action: 'exhausted' | 'consumed'; readonly used?: number; readonly limit?: number }
  | { readonly kind: 'board-operation'; readonly member: string; readonly taskId: string;
      readonly operation: 'create' | 'claim' | 'release' | 'complete' | 'reopen' | 'annotate';
      readonly revision: number; readonly status: 'pending' | 'claimed' | 'completed' }

export type TeamTimelineEvent = TeamTimelineData & {
  readonly type: 'team-timeline'
  readonly schemaVersion: 1
  readonly teamId: string
  readonly parentTeamId?: string
  readonly depth: number
  /** Monotonic within this team instance. Consumers must sort by sequence; observers may reenter. */
  readonly sequence: number
  readonly occurredAt: string
  readonly elapsedMs: number
}

export interface TeamMemberSnapshot {
  readonly name: string
  readonly agentId: string
  readonly conversationId?: string
  readonly role: 'lead' | 'peer'
  readonly attached: boolean
  readonly status: 'pending' | 'running' | 'idle' | TeamSettlementStatus | 'unknown'
  readonly attachedAt: string
  readonly startedAt?: string
  readonly settledAt?: string
  readonly durationMs: number
  readonly modelCalls: number
  readonly runs: number
  readonly activeRuns: number
  /** Completed-run ledger aggregates; active usage remains provisional and is excluded. */
  readonly usage?: RunUsageReport
}

export interface TeamSnapshot {
  readonly schemaVersion: 1
  readonly teamId: string
  readonly parentTeamId?: string
  readonly depth: number
  readonly sequence: number
  readonly occurredAt: string
  readonly elapsedMs: number
  readonly members: readonly TeamMemberSnapshot[]
}
