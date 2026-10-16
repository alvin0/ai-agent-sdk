const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function memberName(member: unknown): string | undefined {
  if (typeof member === 'string') return member
  return object(member) && typeof member.name === 'string' ? member.name : undefined
}
function timelineEvents(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return object(value) && Array.isArray(value.events) ? value.events : []
}
function parsedArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return undefined }
}
const spawnTool = (name: string) => /spawn.*agents?|delegate|create.*(?:agent|worker)/i.test(name)

export interface DelegationMetrics {
  spawnAttempts: number
  spawnsAccepted: number
  spawnsRejected: number
  spawnRejectionReasons: Record<string, number>
  forkSpawns: number
  freshSpawns: number
  contextUnknownSpawns: number
  maxConcurrentWorkers: number
  delegated: boolean
}

/** Attachment is the legacy acceptance contract; dispatch/errors cover SDKs without timelines. */
export class DelegationCollector {
  readonly teamEvents: unknown[] = []
  readonly timelineEvents: unknown[] = []
  private readonly active = new Set<string>()
  private readonly contexts = new Map<string, string>()
  private readonly accepted: (string | undefined)[] = []
  private readonly rejections = new Map<string, string>()
  private readonly attempts = new Map<string, number>()
  private maxConcurrentWorkers = 0

  dispatch(member: string, call: { toolName: string; callId: string; args: unknown }) {
    if (!spawnTool(call.toolName)) return
    const args = parsedArgs(call.args)
    const batch = object(args) ? args.agents ?? args.requests ?? args.tasks : undefined
    this.attempts.set(`${member}:${call.callId}`, Array.isArray(batch) ? batch.length : 1)
  }
  rejected(member: string, call: { toolName: string; callId: string }, reason: string) {
    if (spawnTool(call.toolName)) this.rejections.set(`${member}:${call.callId}`, reason)
  }
  toolResult(member: string, call: { toolName: string; callId: string }, result: unknown) {
    if (!spawnTool(call.toolName) || !object(result) || !Array.isArray(result.content)) return
    const rejections = result.content.flatMap(block => {
      if (!object(block) || block.type !== 'text') return []
      return rejectedEntries(parsedArgs(block.text))
    })
    rejections.forEach((entry, index) => this.rejections.set(`${member}:${call.callId}:${index}`, reasonText(entry)))
  }
  observationFailure(member: string, callId: unknown, reason: string) {
    const id = `${member}:${String(callId)}`
    if (this.attempts.has(id) && !this.rejections.has(id)) this.rejections.set(id, reason)
  }
  resolved(name: string, context: unknown) {
    if (context === 'fork' || context === 'fresh') this.contexts.set(name, context)
  }
  running(name: string) {
    if (name === 'lead') return
    this.active.add(name)
    this.maxConcurrentWorkers = Math.max(this.maxConcurrentWorkers, this.active.size)
  }
  settled(name: string) { this.active.delete(name) }
  teamEvent(event: unknown) {
    this.teamEvents.push(event)
    if (!object(event)) return
    const member = event.member
    const name = memberName(member)
    if (typeof name !== 'string' || name === 'lead') return
    if (event.type === 'member-attached') this.accepted.push(this.contexts.get(name))
    if (event.type === 'member-run-start') this.running(name)
    if (['member-run-end', 'member-run-error', 'member-run-cancelled'].includes(String(event.type))) {
      this.settled(name)
    }
  }
  timelineEvent(event: unknown) { this.timelineEvents.push(event) }
  /** Optional public timeline snapshot. Absence, unknown shapes and future API errors are harmless. */
  captureTimeline(team: unknown) {
    if (!object(team) || !('timeline' in team)) return
    try {
      const value: unknown = typeof team.timeline === 'function' ? team.timeline() : team.timeline
      // Async APIs are outside this snapshot contract; consume their rejection without failing the run.
      if (value instanceof Promise) { void value.catch(() => {}); return }
      this.timelineEvents.push(...timelineEvents(value))
    } catch { /* This SDK revision has a different timeline API; retain legacy evidence. */ }
  }
  metrics(spawns: number): DelegationMetrics {
    const timeline = this.timelineSummary()
    const spawnsRejected = Math.max(this.rejections.size, timeline.reasons.length)
    const reasonCounts = new Map<string, number>()
    const reasons = timeline.reasons.length >= this.rejections.size ? timeline.reasons : [...this.rejections.values()]
    for (const reason of reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    const spawnRejectionReasons = Object.fromEntries(reasonCounts)
    const contexts = this.accepted
    const forkSpawns = Math.min(spawns, Math.max(contexts.filter(c => c === 'fork').length, timeline.fork))
    const freshSpawns = Math.min(spawns - forkSpawns,
      Math.max(contexts.filter(c => c === 'fresh').length, timeline.fresh))
    const dispatched = [...this.attempts.values()].reduce((a, b) => a + b, 0)
    return { spawnAttempts: Math.max(dispatched || spawns + spawnsRejected, spawns, timeline.attempts),
    spawnsAccepted: spawns, spawnsRejected, spawnRejectionReasons, forkSpawns, freshSpawns,
    contextUnknownSpawns: Math.max(0, spawns - forkSpawns - freshSpawns),
    maxConcurrentWorkers: Math.max(this.maxConcurrentWorkers, timeline.maxConcurrent), delegated: spawns > 0 }
  }
  private timelineSummary() {
    const seen = new Set<string>(), summary = new TimelineSummary()
    for (const event of this.timelineEvents) {
      if (!object(event)) continue
      const id = String(event.eventId ?? JSON.stringify(event))
      if (seen.has(id)) continue
      seen.add(id)
      summary.add(event)
    }
    return summary
  }
}

function timelineType(event: Record<string, unknown>) { return String(event.type ?? event.kind ?? '') }

class TimelineSummary {
  attempts = 0
  reasons: string[] = []
  fork = 0
  fresh = 0
  maxConcurrent = 0
  private readonly active = new Set<string>()
  add(event: Record<string, unknown>) {
    const data = object(event.data) ? event.data : event
    const type = timelineType(event)
    if (['spawn-attempt', 'spawn-requested'].includes(type)) this.attempts++
    if (type === 'spawn-rejected') this.reasons.push(reasonText(data.reason ?? data.error ?? 'unknown'))
    if (['spawn-accepted', 'worker-spawned'].includes(type)) this.context(data.context)
    this.lifecycle(type, memberName(data.worker ?? data.name ?? data.member))
  }
  private context(context: unknown) {
    if (context === 'fork') this.fork++
    if (context === 'fresh') this.fresh++
  }
  private lifecycle(type: string, name: string | undefined) {
    if (name === undefined || name === 'lead') return
    if (['worker-started', 'member-run-start'].includes(type)) this.active.add(name)
    if (['worker-settled', 'worker-completed', 'worker-failed', 'worker-closed', 'member-run-end',
      'member-run-error', 'member-run-cancelled'].includes(type)) this.active.delete(name)
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active.size)
  }
}

function reasonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'unknown'
}
/** Recognize explicit refusal shapes only; a worker's failed lifecycle is not a rejected spawn. */
function rejectedEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(rejectedEntries)
  if (!object(value)) return []
  if (value.accepted === false || value.status === 'rejected') return [value.reason ?? value.error ?? 'unknown']
  const nested = value.results ?? value.agents ?? value.workers
  const explicit = Array.isArray(value.rejected) ? value.rejected.map(entry =>
    object(entry) ? entry.reason ?? entry.error ?? 'unknown' : entry) : []
  return [...rejectedEntries(nested), ...explicit]
}
