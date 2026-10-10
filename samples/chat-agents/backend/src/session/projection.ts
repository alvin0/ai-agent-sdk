import { createApprovalPolicy } from '../approvals'
import type { ApprovalPolicy } from '../approvals'
import type { UsageTally } from '../usage'
import { EventProjector } from '../event-projection'
import type { RunTrace } from '../traces'
import type { WireEvent } from '../wire'
import type { AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { createDoorbell } from './streams'
import type { Doorbell } from './streams'
import { createMemberFeed } from './members'
import type { MemberFeed } from './members'
import { memberObserver } from './member-observer'
import type { createCallRecording } from './call-recording'
import type { PromptRunContext } from './run-context'

export interface PromptProjection {
  readonly context: PromptRunContext
  readonly trace: RunTrace
  readonly tally: UsageTally
  readonly memberRoutes: Map<string, { provider: string; model: string; effort?: string }>
  readonly queued: WireEvent[]
  readonly policy: ApprovalPolicy
  readonly project: EventProjector
  readonly wake: Doorbell
  readonly feed: MemberFeed
  onMemberEvent(member: string, event: AgentRunEvent): void
}

export function createPromptProjection(
  context: PromptRunContext, trace: RunTrace, recording: ReturnType<typeof createCallRecording>,
): PromptProjection {
  const { id, group, runId, model, effort, live, workspaceRoot } = context
  /**
   * What this run has already recorded, per member.
   *
   * Two sources report the same tokens — the per-call events and the turn's own
   * report — so the second only records what the first did not.
   */
  const tally: UsageTally = new Map()

  /**
   * Each team member's route, by member name.
   *
   * Filled once the roster is known — after `startRun` — which is before any
   * member can report usage, so a lookup here is never premature.
   */
  const memberRoutes = new Map<string, { provider: string; model: string; effort?: string }>()

  // Member events arrive through a callback rather than the lead's stream, so
  // they are queued here and drained into the same wire order.
  const queued: WireEvent[] = []
  // One gate per run, over grants that outlive the run: the broker only has to
  // survive the calls it parks, while the session's answers must not be
  // re-asked on the next prompt.
  const policy = createApprovalPolicy({ workspaceRoot, sessionGrants: live.sessionGrants })
  live.approvals = policy
  const project = new EventProjector({ approval: callId => policy.prompt(callId) })

  const wake = createDoorbell()

  recording.attach(trace, queued, wake)

  const feed = createMemberFeed(project, (event) => { queued.push(event) })
  const onMemberEvent = memberObserver({
    id, groupId: group.id, runId, model, effort, tally, memberRoutes, trace, queued, project, feed, wake,
  })

  return { context, trace, tally, memberRoutes, queued, policy, project, wake, feed, onMemberEvent }
}
