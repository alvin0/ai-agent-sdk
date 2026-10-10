import type { AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { addToTally, recordUsage, turnShortfall, usageOf } from '../usage'
import type { UsageTally } from '../usage'
import { EventProjector } from '../event-projection'
import { RunTrace } from '../traces'
import type { WireEvent } from '../wire'
import { LEAD_NAME } from './ownership'
import type { ResolvedModel } from '../registry'
import type { Doorbell } from './streams'
import type { MemberFeed } from './members'

interface MemberObservation {
  readonly id: string
  readonly groupId: string
  readonly runId: string
  readonly model: ResolvedModel
  readonly effort: string | undefined
  readonly tally: UsageTally
  readonly memberRoutes: Map<string, { provider: string; model: string; effort?: string }>
  readonly trace: RunTrace
  readonly queued: WireEvent[]
  readonly project: EventProjector
  readonly feed: MemberFeed
  readonly wake: Doorbell
}

export function memberObserver(context: MemberObservation): (member: string, event: AgentRunEvent) => void {
  const { trace, queued, project, feed, wake } = context
  return (member, event): void => {
    recordMemberSpend(context, member, event)
    // Spans first: the step that produced these events opened before them.
    for (const wire of trace.observe(event, member === LEAD_NAME ? undefined : member)) {
      queued.push(wire)
    }
    if (member === LEAD_NAME) {
      // The agent the user is talking to, reporting a turn it was woken for
      // after a worker finished. Projected as the lead so its synthesis reads
      // at the top level rather than inside a subagent panel.
      for (const wire of project.forLead(event)) queued.push(wire)
    } else {
      feed.handle(member, event)
    }
    // Wake the generator itself. A member's permission prompt must reach the
    // browser while its lead is blocked waiting for that very member.
    wake.ring()
  }
}

function memberContextFor(
  { id, groupId, runId, model, effort, memberRoutes }: MemberObservation, member: string,
) {
  const route = memberRoutes.get(member)
  const memberContext = {
    conversationId: id,
    groupId: groupId,
    runId,
    provider: route?.provider ?? model.config.provider,
    model: route?.model ?? model.config.model,
    effort: route?.effort ?? effort ?? undefined,
    // A turn the lead was woken for is still the lead, not a worker.
    ...member === LEAD_NAME ? {} : { member },
  }
  return memberContext
}

function recordMemberSpend(context: MemberObservation, member: string, event: AgentRunEvent): void {
  const { tally } = context
  const memberContext = memberContextFor(context, member)
  // The lead keeps ONE tally whichever path its events arrive on: a woken
  // turn counted under a second key would reconcile against an empty one.
  const tallyKey = member === LEAD_NAME ? undefined : member
  const streamed = usageOf(event)
  if (streamed !== undefined) {
    addToTally(tally, tallyKey, streamed)
    void recordUsage(streamed, memberContext)
  }
  void recordUsage(turnShortfall(event, tally, tallyKey), memberContext)

}
