/** Opt-in, local managed-team collaboration. Storage and filesystem policy remain host-owned. */
export interface ManagedTeamCollaborationOptions {
  /** Accepted message-triggered turn credits per unordered pair, for this team's lifetime. Default 8.
   * Every message consumes a credit, including steering into a busy turn. Credits never reset automatically. */
  readonly maxPeerTurnsPerPair?: number
  /** Per-join deadline before active (running, pending or preparing) members are cancelled.
   * Re-armed on each onLeadEnd; not a total run cap. Defaults to workerTimeoutMs (none unless configured).
   * Use the invocation signal for a total cap. The join runs inside the lead's onTurnEnd hook, so when the
   * lead sets `runtimeLimits.hookTimeoutMs` the effective deadline is clamped below it by
   * min(30 s, hookTimeoutMs / 5). */
  readonly joinTimeoutMs?: number
  /** Maximum retained tasks, including completed tasks. Default 128. */
  readonly maxTasks?: number
  /** Maximum serialized UTF-8 bytes per task, including notes/results. Default 16 KiB. */
  readonly maxTaskBytes?: number
  /** Maximum serialized UTF-8 board bytes. Default 1 MiB. */
  readonly maxBoardBytes?: number
}

export interface CollaborationTask {
  readonly id: string
  readonly revision: number
  readonly title: string
  readonly status: 'pending' | 'claimed' | 'completed'
  readonly owner?: string
  readonly blockedBy: readonly string[]
  /** Shared scratchpad for this task. Replace with a revision CAS to preserve concurrent findings. */
  readonly notes: string
  readonly result: string
}

export interface CollaborationTaskView extends CollaborationTask {
  readonly ready: boolean
}

export interface CollaborationBoardSnapshot {
  readonly tasks: readonly CollaborationTask[]
}

export interface CreateCollaborationTask {
  readonly id: string
  readonly title: string
  readonly blockedBy?: readonly string[]
  readonly notes?: string
}

export interface UpdateCollaborationTask {
  readonly id: string
  readonly expectedRevision: number
  readonly action: 'claim' | 'release' | 'complete' | 'reopen' | 'annotate'
  readonly notes?: string
  readonly result?: string
}
