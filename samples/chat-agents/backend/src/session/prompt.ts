import {
  readPromptSelection, takeOverPrompt, recordInstructions, recordSkills, persistPrompt, promptInput,
} from './preparation'
import { createCallRecording } from './call-recording'
import { admitPrompt } from './admission'
import { createPromptProjection } from './projection'
import { startPromptExecution, bindPromptExecution } from './runtime'
import { streamPrompt } from './run-stream'
import { appendMessage } from '../conversations'
import { RunTrace } from '../traces'
import type { StoredNode } from '../event-projection'
import type { WireEvent } from '../wire'
import type { ChatSession } from './types'

// Positional compatibility for the sample's HTTP routes and existing callers.
type RunPromptArgs = [
  id: string, prompt: string, groupId?: string, attachmentIds?: readonly string[], skillIds?: readonly string[],
]

/** Prepare one turn, then stream and clean up its run-owned resources. */
export async function* runPrompt(
  ...[id, prompt, groupId, attachmentIds = [], skillIds = []]: RunPromptArgs
): AsyncGenerator<WireEvent> {
  const selected = await readPromptSelection(id, groupId)
  const { live } = selected
  const owner = takeOverPrompt(live)
  const persist = async (node: StoredNode): Promise<void> => {
    await appendMessage(id, live.seq, node.kind, node)
    live.seq += 1
  }
  const recording = createCallRecording()
  let admitted: Awaited<ReturnType<typeof admitPrompt>>
  try {
    admitted = await admitPrompt(selected.selection, recording, {
      rememberedEffort: selected.rememberedEffort, attachmentIds,
    })
  } catch (error) {
    yield* preparationFailure({ live, persist, runId: owner.runId }, error)
    return
  }
  const context = { ...selected, ...owner, ...admitted, id, prompt, persist }
  const trace = new RunTrace(id, owner.runId, prompt)
  await recordInstructions(trace, selected.workspaceRoot)
  const mentioned = await recordSkills(trace, {
    prompt, groupId: selected.group.id, workspaceRoot: selected.workspaceRoot,
    skillIds, signal: owner.controller.signal,
  })
  await persistPrompt({ ...context, mentioned })
  const input = promptInput(prompt, admitted.attached, mentioned)
  const state = createPromptProjection(context, trace, recording)
  let handles
  try { handles = await startPromptExecution(input, state) }
  catch (error) {
    yield* preparationFailure({ live, persist, runId: owner.runId }, error)
    return
  }
  await bindPromptExecution(state, handles)
  yield* streamPrompt(state, handles)
}

async function* preparationFailure(
  { live, persist, runId }: {
    readonly live: ChatSession; readonly runId: string; persist(node: StoredNode): Promise<void>
  }, error: unknown,
): AsyncGenerator<WireEvent> {
  const message = error instanceof Error ? error.message : String(error)
  await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
  yield { t: 'run-start', runId, members: [] }
  yield { t: 'error', message }
}
