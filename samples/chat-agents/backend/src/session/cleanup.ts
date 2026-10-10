import { saveHistory } from '../conversations'
import { EventProjector } from '../event-projection'
import type { StoredNode } from '../event-projection'
import { LEAD_NAME, displacedRuns } from './ownership'
import type { RunHandles } from '../agent-runtime'
import type { ChatSession } from './types'

interface PromptCleanup {
  readonly live: ChatSession
  readonly controller: AbortController
  readonly id: string
  readonly handles: RunHandles
  readonly project: EventProjector
  persist(node: StoredNode): Promise<void>
}

export async function cleanupPrompt({live, controller, id, handles, project, persist}: PromptCleanup): Promise<void> {
  // Whether a NEWER prompt displaced this run.
  //
  // Not the same as being cancelled: a cancel leaves the conversation idle,
  // so whatever this run had still belongs at the end of the transcript. A
  // displaced run's late content has nowhere to go. The transcript is append-only and the newer run has
  // already written into it, so persisting here files the answer to the
  // ABANDONED prompt underneath the answer to the current one, and the
  // conversation reads as though the assistant replied twice, second reply
  // first. The prompt it belonged to was withdrawn; the notice above already
  // records that this run was replaced, and usage is accounted separately, so
  // nothing billed is lost by dropping the text nobody asked for any more.
  const superseded = displacedRuns.has(controller)
  // An answer that landed as the run was tearing down still belongs in the
  // transcript, even though there is no longer a stream to yield it on.
  const outbox = superseded ? [] : live.outbox.splice(0)
  if (!superseded) {
    for (const entry of outbox) {
      if (entry.node !== undefined) await persist(entry.node)
    }
    for (const node of project.flush()) await persist(node)
    for (const node of project.settled()) await persist(node)
  }
  await saveHistory(id, live.history)
  await handles.close()
  if (!displacedRuns.has(controller)) {
    live.steerRun = undefined
    live.notify = undefined
  }
  // Reached only when a worker is STILL going after all that — the client
  // disconnected, or a new prompt took the conversation over. Its report is
  // written to the transcript so a reload shows it; it is deliberately not
  // queued for the next stream, where it would arrive out of order among
  // that run's own events.
  // ONE projector, not one per event: a projector accumulates deltas into a
  // settled node, and a fresh one per event turns a streamed answer into a
  // scatter of fragments.
  //
  // And the lead is projected AS THE LEAD. Routing everything through
  // `forMember` filed the lead's own woken turn — the synthesis — under a
  // subagent, which is what put a finished report inside a worker's panel
  // and made the run look abandoned.
  const closing = new EventProjector()
  if (!displacedRuns.has(controller)) live.workerSink = (member, event) => {
    if (member === LEAD_NAME) {
      for (const _wire of closing.forLead(event)) { /* nobody is listening */ }
    } else {
      void closing.forMember(member, event)
    }
    for (const node of closing.flush()) void persist(node)
  }
  if (live.abort === controller) live.abort = undefined
}
