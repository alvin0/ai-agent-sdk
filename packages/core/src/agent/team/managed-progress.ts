/** A single fail-safe timeout chain; every continuation rechecks its ownership and bounds. */
import type { AgentSession } from '../define/session.ts'
import type { AgentTeam } from './team.ts'
import type { ProgressRequest } from './managed-progress-tool.ts'
import type { TeamMemberSnapshot } from './team-timeline.ts'
import type { TeamProgressEvent, TeamProgressOptions, TeamProgressState,
  TeamProgressStopReason, TeamProgressMember } from './team-progress.ts'
import { progressChannel, watchProgressActivity, type ProgressActivity } from './team-progress-internal.ts'
import { deepCloneFreeze } from './common.ts'

interface ProgressHost {
  readonly team: AgentTeam
  readonly lead: string
  readonly signal: AbortSignal
  session(): AgentSession
  workers(): readonly string[]
  busy(name: string): boolean
  owned(): object | undefined
}
interface Schedule {
  readonly id: number
  readonly intervalMs: number
  readonly targets: readonly string[]
  readonly signal: AbortSignal
  readonly owner: object
  readonly started: number
  readonly startedAt: string
  reportsSent: number
  failures: number
  stalls: number
  revision: number
  timer?: ReturnType<typeof setTimeout> | undefined
  nextAt?: string | undefined
}
interface Activity { calls: number; reported: number; lastTool?: string; argumentHint?: string | undefined }

export class ManagedProgress {
  private readonly limits: Required<TeamProgressOptions>
  private current: Schedule | undefined
  private previous: TeamProgressState = { active: false, reportsSent: 0 }
  private serial = 0
  private revision = 0
  private ticking = false
  private stopping = false
  private readonly activity = new Map<string, Activity>()
  private latestSignal: AbortSignal | undefined
  private unbindRun = () => {}
  private readonly cleanup: (() => void)[] = []
  readonly enabled: boolean

  constructor(private readonly host: ProgressHost, options: false | TeamProgressOptions | undefined) {
    this.enabled = options !== false
    this.limits = progressLimits(options || {})
    const channel = progressChannel(host.team)
    this.cleanup.push(watchProgressActivity(host.team, event => this.observe(event)),
      host.team.subscribe(event => {
        if (event.type !== 'team-timeline' || event.member === host.lead) return
        if ((event.kind === 'model-requested' || event.kind === 'worker-settled')
          && this.current?.targets.includes(event.member)) this.revision++
        if (event.kind === 'worker-settled' || event.kind === 'member-closed') {
          // Outcome publication can precede slot/settlement bookkeeping in the same stack.
          queueMicrotask(() => this.checkSettled())
        }
      }))
    this.listen(host.signal, () => this.stop('closed'))
    this.listen(channel.signal, () => this.dispose())
  }
  private listen(signal: AbortSignal, callback: () => void): void {
    signal.addEventListener('abort', callback, { once: true })
    this.cleanup.push(() => signal.removeEventListener('abort', callback))
  }
  private observe(event: ProgressActivity): void {
    if (event.member === this.host.lead) {
      if (event.kind === 'invocation') this.beginInvocation(event.signal)
      if (event.kind === 'run-end') this.leadEnded(event.status)
      return
    }
    if (event.kind === 'settlement') { this.checkSettled(); return }
    if (event.kind !== 'tool' || !this.host.workers().includes(event.member)) return
    const old = this.activity.get(event.member) ?? { calls: 0, reported: 0 }
    this.activity.set(event.member, { ...old, calls: old.calls + 1, lastTool: event.name.slice(0, 80),
      argumentHint: pathHint(event.args) })
    if (this.current?.targets.includes(event.member)) this.revision++
  }
  private beginInvocation(signal: AbortSignal): void {
    const owner = this.host.owned() ?? signal
    if (this.current !== undefined && this.current.owner !== owner) this.stop('run-ended')
    this.latestSignal = signal
    // Subscribe at invocation admission: failures before the observation span starts still release idle.
    const ended = () => {
      if (this.latestSignal !== signal || this.host.owned() !== undefined) return
      this.latestSignal = undefined
      this.finishInvocation(signal.aborted ? 'aborted' : 'run-ended')
    }
    void this.host.session().whenIdle().then(ended, ended)
  }
  private leadEnded(status: string): void {
    if (status !== 'success') this.stop(status === 'aborted' ? 'aborted' : 'run-ended')
  }
  private bindScheduleSignal(s: Schedule): void {
    const abort = () => { if (this.current === s) this.stop('aborted') }
    s.signal.addEventListener('abort', abort, { once: true })
    this.unbindRun = () => s.signal.removeEventListener('abort', abort)
    if (s.signal.aborted) abort()
  }
  state(): TeamProgressState {
    const s = this.current
    return deepCloneFreeze(s === undefined ? this.previous : { active: true, intervalMs: s.intervalMs,
      targets: s.targets, startedAt: s.startedAt, reportsSent: s.reportsSent,
      ...s.nextAt === undefined ? {} : { nextAt: s.nextAt } })
  }
  configure(request: ProgressRequest) {
    if (this.stopping || this.ticking) throw new Error('progress schedule is delivering; retry after delivery')
    if (request.stop) { this.stop('requested'); return { scheduled: false } }
    // Replace first: invalid or dead replacement requests must not leave the previous loop running.
    this.stop('replaced')
    if (!this.enabled) throw new Error('progress updates disabled')
    this.host.signal.throwIfAborted()
    progressChannel(this.host.team).signal.throwIfAborted()
    const signal = this.latestSignal
    if (signal === undefined || !this.leadAlive()) throw new Error('progress updates require a live lead invocation')
    signal.throwIfAborted()
    const targets = progressTargets(request.targets, this.host.workers())
    const intervalMs = Math.max(this.limits.minIntervalMs, Math.min(this.limits.maxIntervalMs, request.interval_ms!))
    const s: Schedule = { id: ++this.serial, intervalMs, targets, signal,
      owner: this.host.owned() ?? signal, started: performance.now(),
      startedAt: new Date().toISOString(), reportsSent: 0, failures: 0, stalls: 0, revision: this.revision }
    for (const value of this.activity.values()) value.reported = value.calls
    this.current = s
    this.bindScheduleSignal(s)
    if (!this.checkSettled()) this.arm(s)
    return { scheduled: this.current === s, interval_ms: intervalMs, targets }
  }
  finishInvocation(reason: TeamProgressStopReason): void {
    if (!this.checkSettled()) this.stop(reason)
  }
  stop(reason: TeamProgressStopReason = 'host'): void {
    const s = this.current
    if (s === undefined) return
    this.current = undefined // Invalidate before calling any host code (including reentrant listeners).
    this.unbindRun()
    this.unbindRun = () => {}
    clearTimeout(s.timer)
    this.previous = { active: false, intervalMs: s.intervalMs, targets: s.targets,
      startedAt: s.startedAt, reportsSent: s.reportsSent, reason }
    this.stopping = true
    try { this.deliver(s, 'stopped', reason) } catch { /* Terminal delivery is attempted once, never retried. */ }
    finally { this.stopping = false }
  }
  dispose(): void {
    this.stop('closed')
    this.unbindRun()
    this.unbindRun = () => {}
    for (const remove of this.cleanup.splice(0)) remove()
    this.activity.clear()
    this.latestSignal = undefined
  }
  private checkSettled(): boolean {
    const s = this.current
    if (s === undefined) return true
    if (s.targets.some(name => this.host.busy(name))) return false
    this.stop('settled')
    return true
  }
  private arm(s: Schedule): void {
    if (this.current !== s) return
    const remaining = this.limits.maxDurationMs - (performance.now() - s.started)
    const delay = Math.max(0, Math.min(s.intervalMs, remaining))
    s.nextAt = new Date(Date.now() + delay).toISOString()
    s.timer = setTimeout(() => this.tick(s), delay)
    ;(s.timer as { unref?: () => void }).unref?.()
  }
  private tick(s: Schedule): void {
    if (this.current !== s || this.ticking) return
    s.timer = undefined
    s.nextAt = undefined
    this.ticking = true
    try { this.report(s) } catch {
      if (++s.failures >= this.limits.maxConsecutiveFailures) this.stop('delivery-failed')
    } finally {
      this.ticking = false
      // Contained failures get only a bounded retry; successful delivery is not a model wake.
      if (this.current === s) this.arm(s)
    }
  }
  private report(s: Schedule): void {
    const reason = this.expired(s)
    if (reason !== undefined) { this.stop(reason); return }
    if (this.checkSettled()) return
    s.stalls = s.revision === this.revision ? s.stalls + 1 : 0
    s.revision = this.revision
    if (s.stalls >= this.limits.stalledIntervals) { this.stop('stalled'); return }
    if (!this.deliver(s, 'report')) throw new Error('progress delivery failed')
    if (this.current !== s) return
    s.failures = 0
    s.reportsSent++
    for (const value of this.activity.values()) value.reported = value.calls
    if (s.reportsSent >= this.limits.maxReports) this.stop('max-reports')
  }
  private leadAlive(): boolean {
    return this.host.owned() !== undefined || this.host.session().isRunning
  }
  private expired(s: Schedule): TeamProgressStopReason | undefined {
    if (this.host.signal.aborted || progressChannel(this.host.team).signal.aborted) return 'closed'
    if (s.signal.aborted) return 'aborted'
    if (!this.leadAlive()) return 'run-ended'
    if (performance.now() - s.started >= this.limits.maxDurationMs) return 'max-duration'
    return undefined
  }
  private deliver(s: Schedule, phase: TeamProgressEvent['phase'], reason?: TeamProgressStopReason): boolean {
    let snapshot
    try { snapshot = this.host.team.snapshot() } catch (error) {
      if (phase !== 'stopped') throw error
      snapshot = { teamId: this.host.team.id, occurredAt: new Date().toISOString(), members: [] }
    }
    const members = snapshot.members.filter(member => s.targets.includes(member.name))
      .map(member => progressMember(member, this.activity.get(member.name), snapshot.occurredAt))
    const text = members.map(member => `${member.name}: ${member.status}, ${Math.round(member.elapsedMs / 1000)}s, `
      + `${member.modelCalls} model calls, ${member.toolCalls} tools since last report`
      + (member.lastTool === undefined ? '' : `; ${member.lastTool} ${member.argumentHint ?? ''}`)).join('; ')
    return progressChannel(this.host.team).emit(deepCloneFreeze({ type: 'team-progress', teamId: snapshot.teamId,
      lead: this.host.lead, scheduleId: s.id, phase, ...reason === undefined ? {} : { reason },
      occurredAt: snapshot.occurredAt, elapsedMs: Math.max(0, performance.now() - s.started),
      reportsSent: s.reportsSent + Number(phase === 'report'), targets: s.targets, members,
      text: (phase === 'stopped' ? `Progress updates stopped (${reason}). ` : 'Worker progress: ') + text }))
  }
}
function progressLimits(options: TeamProgressOptions): Required<TeamProgressOptions> {
  const limits = { minIntervalMs: 5000, maxIntervalMs: 600_000, maxDurationMs: 30 * 60_000,
    maxReports: 120, stalledIntervals: 3, maxConsecutiveFailures: 2, ...options }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new TypeError(`${key} must be a positive timer-safe integer`)
    }
  }
  if (limits.minIntervalMs > limits.maxIntervalMs) throw new TypeError('minIntervalMs exceeds maxIntervalMs')
  return limits
}
function pathHint(args: unknown): string | undefined {
  if (typeof args === 'string') {
    if (args.length > 8192) return undefined
    try { args = JSON.parse(args) } catch { return undefined }
  }
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['path', 'file', 'filename', 'file_path']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string') return value.replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 120)
  }
  return undefined
}

function progressMember(member: TeamMemberSnapshot, activity: Activity | undefined,
  occurredAt: string): TeamProgressMember {
  const elapsedMs = progressElapsed(member, occurredAt)
  return { ...member, elapsedMs, toolCalls: (activity?.calls ?? 0) - (activity?.reported ?? 0),
    ...activity?.lastTool === undefined ? {} : { lastTool: activity.lastTool },
    ...activity?.argumentHint === undefined ? {} : { argumentHint: activity.argumentHint } }
}

function progressTargets(requested: readonly string[] | undefined, workers: readonly string[]): string[] {
  const targets = [...new Set(requested ?? workers)]
  if (targets.length === 0 || targets.some(name => !workers.includes(name))) {
    throw new TypeError('targets must name current managed workers')
  }
  return targets
}

function progressElapsed(member: TeamMemberSnapshot, occurredAt: string): number {
  const end = member.activeRuns > 0 ? occurredAt : member.settledAt ?? occurredAt
  return member.startedAt === undefined ? 0 : Math.max(0, Date.parse(end) - Date.parse(member.startedAt))
}
