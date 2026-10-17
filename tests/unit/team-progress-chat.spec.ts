import { describe, expect, it, vi } from 'vitest'
import { listenTeamProgress } from '../../samples/chat-agents/backend/src/session/progress.ts'
import type { AgentTeamEvent, TeamProgressEvent } from '@alvin0/ai-agent-sdk-core/agent'

function setup(signal = new AbortController().signal) {
  let listener: (event: AgentTeamEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const notify = vi.fn()
  const team = { subscribe(callback: (event: AgentTeamEvent) => void) { listener = callback; return unsubscribe } }
  const close = listenTeamProgress(team, signal, notify)
  const emit = (event: AgentTeamEvent) => listener(event)
  return { close, emit, notify, unsubscribe }
}
const progress = (phase: 'report' | 'stopped'): TeamProgressEvent => ({ type: 'team-progress',
  phase, scheduleId: 1, teamId: 'test', lead: 'lead', occurredAt: 'now', elapsedMs: 20,
  reportsSent: 1, targets: ['worker'], members: [], text: 'worker: running; read_file cache.ts',
})

describe('chat sample progress stream', () => {
  it('renders reports and terminal reports as user notices and ignores ordinary team events', () => {
    const f = setup()
    f.emit(progress('report'))
    f.emit(progress('stopped'))
    f.emit({ type: 'member-run-start', member: 'worker' })
    expect(f.notify.mock.calls).toEqual([
      [{ t: 'notice', level: 'info', message: 'worker: running; read_file cache.ts' }],
      [{ t: 'notice', level: 'info', message: 'worker: running; read_file cache.ts' }],
    ])
    f.close()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  })
  it('unsubscribes on user abort and on stream cleanup', () => {
    const controller = new AbortController()
    const f = setup(controller.signal)
    controller.abort()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    f.close()
    const alreadyAborted = setup(controller.signal)
    expect(alreadyAborted.unsubscribe).toHaveBeenCalledTimes(1)
    alreadyAborted.close()
  })
})
