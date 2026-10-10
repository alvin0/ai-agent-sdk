import type { ControllerContext } from './contracts'
import type { LiveRun } from './run-types'

export function showRun(context: ControllerContext, id: string, run: LiveRun): void {
  const { shown, setState } = context
  if (shown.current !== id)
    return
  setState({
    nodes: run.nodes,
    running: true,
    members: run.members,
    spans: run.spans,
    runId: run.runId,
    usage: run.usage,
    progress: run.progress,
  })
}
