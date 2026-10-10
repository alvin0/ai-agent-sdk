import { onCommandOutput, TOOL_LABELS } from '../tools'
import { createIdleWatch } from '../resilience'
import type { WireEvent } from '../wire'
import type { Doorbell } from './streams'

/** Owns heartbeat, command-output subscription and idle progress for one run. */
export class RunActivity {
  private readonly idle = createIdleWatch()
  private readonly inFlight = new Map<string, string>()
  private reporting = false
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly unwatchOutput: () => void

  constructor(wake: Doorbell, queued: WireEvent[]) {
    this.heartbeat = setInterval(() => { wake.ring() }, 5_000)
    this.heartbeat.unref?.()
    this.unwatchOutput = onCommandOutput((callId, chunk) => {
      if (!this.inFlight.has(callId)) return
      queued.push({ t: 'tool-output', id: callId, chunk })
      wake.ring()
    })
  }

  touch(): WireEvent | undefined {
    this.idle.touch(Date.now())
    if (!this.reporting) return undefined
    this.reporting = false
    return { t: 'progress', message: null }
  }

  track(wire: WireEvent): void {
    if (wire.t === 'tool-call') this.inFlight.set(wire.id, wire.name)
    if (wire.t === 'tool-result') this.inFlight.delete(wire.id)
  }

  silence(waitingOnUser: boolean): WireEvent | undefined {
    const verdict = this.idle.check(Date.now(), waitingOnUser)
    if (verdict.kind !== 'report') return undefined
    this.reporting = true
    const running = [...this.inFlight.values()]
    const what = running.length === 0
      ? 'Thinking'
      : `Running ${running.map(name => TOOL_LABELS[name] ?? name).join(', ')}`
    return { t: 'progress', message: what }
  }

  finalProgress(): WireEvent | undefined {
    return this.reporting ? { t: 'progress', message: null } : undefined
  }

  close(): void {
    clearInterval(this.heartbeat)
    this.unwatchOutput()
  }
}
