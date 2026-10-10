import type { ChatController, ControllerContext, LiveRun } from './contracts'
import { writeTranscript } from '../idb'

export function settleRun(
  context: ControllerContext,
  id: string,
  run: LiveRun,
  refreshConversations: ChatController['refreshConversations'],
): void {
  const { runs, shown, setState, setRunningIds } = context
  const settled = run.nodes
  runs.current.delete(id)
  setRunningIds([...runs.current.keys()])
  // The run is over, so whatever it was waiting on is no longer true.
  if (shown.current === id) {
    setState(previous => ({ ...previous, nodes: settled, running: false, progress: null }))
  }
  else {
    // Nobody was watching, so nothing wrote the cache: do it here, or
    // coming back would show the transcript as it was before the run.
    void writeTranscript(id, settled)
  }
  void refreshConversations()
}
