import type { HistoryEntry, HistorySnapshot } from '../history/index.ts'

/**
 * Copy the lead's conversation up to the last point it was complete.
 *
 * The lead is INSIDE a turn when it calls `spawn_agent`: the assistant message
 * carrying that very call is already in history, and its result cannot be,
 * because producing it is what this code is doing. Handing that tail to a
 * worker gives it a conversation ending in an unanswered tool call — which
 * providers reject, and which would turn a context optimisation into a spawn
 * that fails outright.
 *
 * So the fork is cut at the last position where no tool call was outstanding.
 * That is also the honest boundary in meaning: work still in flight is not yet
 * something the lead knows. The DeepSeek harness names the same rule a
 * "completed-turn prefix".
 *
 * A prefix is safe to hydrate as a history in its own right: `replace` surface
 * ops and compaction records only ever reference earlier entries, so cutting
 * from the end cannot orphan a reference.
 * @param snapshot - The lead's history, taken mid-turn.
 * @returns Entries up to that boundary; empty when nothing has completed.
 */
export function completedHistoryPrefix(
  snapshot: HistorySnapshot,
): readonly HistoryEntry[] {
  const pending = new Set<string>()
  let cut = 0
  snapshot.entries.forEach((entry, index) => {
    const event = entry.event
    if (event.kind === 'tool-call') pending.add(event.callId)
    else if (event.kind === 'tool-result') pending.delete(event.callId)
    else if (event.kind === 'assistant') {
      // The assistant MESSAGE carries its own tool-call blocks, separately from
      // the `tool-call` events beside it. Counting only the events left the
      // spawn call in the fork, complete with the synthetic "interrupted before
      // a result was recorded" error the request builder pairs it with — the
      // worker's first sight of its lead being that it had just failed.
      for (const block of event.message.content) {
        if (block.type === 'tool-call') pending.add(block.id)
      }
    }
    // An interrupted assistant message is a turn that never finished; treating
    // it as settled context would hand a worker a half-formed intention.
    const settled = pending.size === 0
      && !(event.kind === 'assistant' && event.interrupted === true)
    if (settled) cut = index + 1
  })
  return snapshot.entries.slice(0, cut)
}
