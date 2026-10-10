import type { AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { EventProjector } from '../event-projection'
import type { StoredNode } from '../event-projection'
import type { WireEvent } from '../wire'
import type { ChatSession } from './types'
import type { Doorbell } from './streams'

/** Tracks which team members are working, and projects what they report. */
export interface MemberFeed {
  /** Members currently working; the run closes any left open at teardown. */
  readonly open: Set<string>
  /**
   * Project one member event, bracketing it with lifecycle events.
   * @param member - Who reported.
   * @param event - Their raw SDK event.
   */
  handle(member: string, event: AgentRunEvent): void
}

/**
 * Follow a team's members.
 *
 * A member opens on its first event and closes on its OWN `agent-end`, which is
 * when IT finished — not when the run did. Reporting the end only at the run's
 * teardown left every member shown as busy for the whole rest of the run, long
 * after its work was visibly complete. A member is dropped from `open` rather
 * than flagged done, because it can be woken again and its next event has to
 * reopen it.
 * @param project - The projector turning SDK events into wire events.
 * @param push - Receives every wire event, in order.
 * @returns The feed.
 */
export function createMemberFeed(
  project: EventProjector,
  push: (event: WireEvent) => void,
): MemberFeed {
  const open = new Set<string>()
  return {
    open,
    handle(member, event) {
      if (!open.has(member)) {
        open.add(member)
        push({ t: 'member-start', member })
      }
      for (const wire of project.forMember(member, event)) push(wire)
      if (event.type === 'agent-end') {
        open.delete(member)
        push({ t: 'member-end', member })
      }
    },
  }
}

/**
 * Keep reporting while a lead's workers are still running.
 *
 * A worker outlives the run that spawned it, so the lead finishing is not the
 * conversation finishing. Closing the stream there would leave the user with an
 * answer and no sign of the two agents still working behind it — they would only
 * find out on their next prompt.
 *
 * Stops as soon as a NEW run takes over the conversation: two streams draining
 * the same outbox and numbering the same transcript would interleave.
 * @param live - The conversation's live state.
 * @param controller - This run's abort handle, and its claim on the session.
 * @param wake - Rung by worker events and by the run's heartbeat.
 * @param queued - Wire events waiting to go out.
 * @param project - The run's projector, for the nodes to persist.
 * @param persist - Appends one settled node to the transcript.
 * @param drainOutbox - Flushes anything another request queued.
 * @returns Progress and worker events until they settle.
 */
type FollowWorkersArgs = [
  live: ChatSession, controller: AbortController, wake: Doorbell, queued: WireEvent[],
  project: EventProjector, persist: (node: StoredNode) => Promise<void>,
  drainOutbox: () => AsyncGenerator<WireEvent>,
]

export async function* followWorkers(
  ...[live, controller, wake, queued, project, persist, drainOutbox]: FollowWorkersArgs
): AsyncGenerator<WireEvent> {
  let reported = false
  let lastProgress: string | undefined
  for (;;) {
    const managed = live.managed
    if (managed === undefined) break
    if (controller.signal.aborted || live.abort !== controller) break
    // The ROSTER, not just the workers: a worker finishing wakes the lead for
    // a follow-up turn, and that turn is the synthesis. Watching only the
    // workers would close the stream at the exact moment the lead started
    // writing it.
    // `pending` counts as busy: a worker held until its dependencies settle has
    // not started, let alone finished. Watching only `running` would end the
    // stream while the queued half of the plan was still to come.
    const busy = managed.team.members()
      .filter(memberBusy)
    if (busy.length === 0) {
      // Everyone LOOKS idle — but a worker's last event fires before its run
      // resolves, and the report that wakes the lead is delivered after that.
      // Believing the roster in that gap is what closed the stream one instant
      // before the synthesis, leaving the conversation ending on a worker.
      await waitForQuiet(managed, controller.signal)
      const stillBusy = managed.team.members()
        .some(memberBusy)
      if (!stillBusy) break
      continue
    }
    reported = true
    // Only when it CHANGES. The doorbell rings on every worker event, and three
    // busy workers ring it many times a second; re-sending the same line each
    // time sent 189 identical events in one measured run. The client counts the
    // elapsed seconds itself, so an unchanged line carries no new information —
    // it is pure traffic, and it buries everything else in the stream.
    const message = `Waiting for ${busy.map(member => member.name).join(', ')}`
    if (message !== lastProgress) {
      lastProgress = message
      yield { t: 'progress', message }
    }
    // The run's heartbeat rings this every few seconds, and every worker event
    // rings it immediately, so this is neither a spin nor a fixed poll.
    await wake.wait()
    yield* flushWorkerEvents(queued, drainOutbox, { project, persist })
  }
  yield* flushWorkerEvents(queued, drainOutbox, { project, persist })
  if (reported) yield { t: 'progress', message: null }

  // Release the settled workers' slots.
  //
  // The SDK keeps a finished worker addressable, and occupying one of
  // `maxWorkers`, until something closes it — that is what makes `close_agent`
  // worth calling. This app holds the harness for the whole conversation, so a
  // lead that forgets to close would exhaust the cap after a few prompts and
  // every later spawn would fail. Their answers are already in the lead's
  // history and in the transcript, so nothing is lost by reclaiming the slot.
  await closeSettledWorkers(live, controller)
}

function memberBusy(member: { readonly status: string }): boolean {
  return member.status === 'running' || member.status === 'pending'
}

async function closeSettledWorkers(live: ChatSession, controller: AbortController): Promise<void> {
  const settled = live.managed
  if (settled !== undefined && live.abort === controller) {
    for (const worker of settled.workers()) {
      // A pending worker has not run yet; closing it would silently delete the
      // step the lead had queued behind another one.
      if (worker.status === 'running' || worker.status === 'pending') continue
      await settled.closeWorker(worker.name).catch(() => undefined)
    }
  }
}

async function* flushWorkerEvents(
  queued: WireEvent[], drainOutbox: () => AsyncGenerator<WireEvent>,
  { project, persist }: { readonly project: EventProjector; persist(node: StoredNode): Promise<void> },
): AsyncGenerator<WireEvent> {
  while (queued.length > 0) yield queued.shift() as WireEvent
  yield* drainOutbox()
  for (const node of project.flush()) await persist(node)
}

async function waitForQuiet(managed: NonNullable<ChatSession['managed']>, signal: AbortSignal): Promise<void> {
  try { await managed.whenQuiet(signal) } catch { /* Aborted, or a harness without the wait. */ }
}
