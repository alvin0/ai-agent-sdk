import type { WireEvent } from '@chat-agents/backend'
import type { LiveRun } from './run-types'
import { reduce, reduceMembers, reduceSpans } from './reducers'

export function foldEvent(run: LiveRun, event: WireEvent): void {
  run.nodes = reduce(run.nodes, event)
  run.members = reduceMembers(run.members, event)
  run.spans = reduceSpans(run.spans, event)
  if (event.t === 'run-start')
    run.runId = event.runId
  // Live status, deliberately not a transcript node: it is true only
  // while it is on screen.
  if (event.t === 'progress')
    run.progress = event.message
  if (event.t === 'usage') {
    run.usage = {
      inputTokens: run.usage.inputTokens + event.inputTokens,
      outputTokens: run.usage.outputTokens + event.outputTokens,
    }
  }
}
export async function readStream(body: NonNullable<Response['body']>, run: LiveRun, show: () => void): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done)
      break
    buffer += chunk.value
    // SSE frames are separated by a blank line; a partial tail stays buffered.
    let separator = buffer.indexOf('\n\n')
    while (separator !== -1) {
      const frame = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      separator = buffer.indexOf('\n\n')
      const payload = frame.startsWith('data: ') ? frame.slice(6) : ''
      if (payload === '')
        continue
      const event = JSON.parse(payload) as WireEvent
      foldEvent(run, event)
      show()
    }
  }
}
