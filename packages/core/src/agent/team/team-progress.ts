/** User-facing progress is ephemeral host data, never model input. */
import type { TeamMemberSnapshot } from './team-timeline.ts'

export interface TeamProgressOptions {
  readonly minIntervalMs?: number
  readonly maxIntervalMs?: number
  readonly maxDurationMs?: number
  readonly maxReports?: number
  readonly stalledIntervals?: number
  readonly maxConsecutiveFailures?: number
}
/** Host cancellation only; settlement and scheduler reasons are runtime-owned. */
export type TeamProgressHostStopReason = 'host' | 'run-ended' | 'aborted'
export type TeamProgressStopReason = 'requested' | 'host' | 'settled' | 'run-ended' | 'aborted'
  | 'steered' | 'closed' | 'max-duration' | 'max-reports' | 'stalled' | 'delivery-failed' | 'replaced'
export interface TeamProgressState {
  readonly active: boolean
  readonly intervalMs?: number
  readonly targets?: readonly string[]
  readonly startedAt?: string
  readonly reportsSent: number
  readonly nextAt?: string
  readonly reason?: TeamProgressStopReason
}
export interface TeamProgressMember extends TeamMemberSnapshot {
  readonly elapsedMs: number
  readonly toolCalls: number
  readonly lastTool?: string
  /** Only a path/file hint, capped at 120 characters; no arbitrary arguments/results. */
  readonly argumentHint?: string
}
export interface TeamProgressEvent {
  readonly type: 'team-progress'
  readonly teamId: string
  readonly lead: string
  readonly scheduleId: number
  readonly phase: 'report' | 'stopped'
  readonly reason?: TeamProgressStopReason
  readonly occurredAt: string
  readonly elapsedMs: number
  readonly reportsSent: number
  readonly targets: readonly string[]
  readonly members: readonly TeamProgressMember[]
  readonly text: string
}
