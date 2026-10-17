import type { BenchTeamEvent } from './team-events.ts'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function memberName(member: unknown): string | undefined {
  if (typeof member === 'string') return member
  return object(member) && typeof member.name === 'string' ? member.name : undefined
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

/** Legacy estimates are used only when the SDK emits no schema-v1 timeline facts. */
export class DelegationCollector {
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
  metrics(spawns: number, timeline: readonly BenchTeamEvent[] = []): DelegationMetrics & { spawns: number } {
    if (timeline.length > 0) return timelineMetrics(timeline)
    const spawnsRejected = this.rejections.size
    const reasonCounts = new Map<string, number>()
    const reasons = [...this.rejections.values()]
    for (const reason of reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    const spawnRejectionReasons = Object.fromEntries(reasonCounts)
    const contexts = this.accepted
    const forkSpawns = Math.min(spawns, contexts.filter(c => c === 'fork').length)
    const freshSpawns = Math.min(spawns - forkSpawns,
      contexts.filter(c => c === 'fresh').length)
    return { spawns, spawnAttempts: spawns + spawnsRejected,
    spawnsAccepted: spawns, spawnsRejected, spawnRejectionReasons, forkSpawns, freshSpawns,
    contextUnknownSpawns: Math.max(0, spawns - forkSpawns - freshSpawns),
    maxConcurrentWorkers: this.maxConcurrentWorkers, delegated: spawns > 0 }
  }
}

/** Restore per-team sequence order, preserving arrival slots between independent team streams. */
function orderedTimeline(events: readonly BenchTeamEvent[]) {
  const teams = new Map<string, BenchTeamEvent[]>()
  for (const event of events) {
    if (!teams.has(event.teamId)) teams.set(event.teamId, [])
    teams.get(event.teamId)!.push(event)
  }
  for (const stream of teams.values()) stream.sort((a, b) => a.sequence! - b.sequence!)
  const positions = new Map<string, number>()
  return events.map(event => {
    const index = positions.get(event.teamId) ?? 0
    positions.set(event.teamId, index + 1)
    return teams.get(event.teamId)![index]!
  })
}

function timelineMetrics(events: readonly BenchTeamEvent[]): DelegationMetrics & { spawns: number } {
  const summary = new TimelineSummary()
  for (const event of orderedTimeline(events)) summary.add(event)
  const { spawns, spawnsRejected, spawnAttempts, forkSpawns, freshSpawns,
    spawnRejectionReasons, maxConcurrentWorkers } = summary
  return { spawns, spawnsAccepted: spawns, spawnAttempts, spawnsRejected, spawnRejectionReasons,
    forkSpawns, freshSpawns, contextUnknownSpawns: Math.max(0, spawns - forkSpawns - freshSpawns),
    maxConcurrentWorkers, delegated: spawns > 0 }
}

class TimelineSummary {
  spawns = 0
  spawnsRejected = 0
  spawnAttempts = 0
  forkSpawns = 0
  freshSpawns = 0
  maxConcurrentWorkers = 0
  readonly spawnRejectionReasons: Record<string, number> = Object.create(null)
  private readonly active = new Map<string, Set<string>>()
  private readonly pendingContexts = new Map<string, (string | undefined)[]>()

  add(event: BenchTeamEvent) {
    const key = JSON.stringify([event.teamId, event.member])
    switch (event.kind) {
      case 'spawn-requested':
        this.spawnAttempts++
        this.requestContext(key, event.context)
        break
      case 'spawn-accepted':
        this.spawns++
        this.acceptContext(this.pendingContexts.get(key)?.shift())
        break
      case 'spawn-rejected':
        this.reject(event.reason ?? 'unknown')
        this.rejectContext(key, event.reason)
        break
    }
    if (this.pendingContexts.get(key)?.length === 0) this.pendingContexts.delete(key)
    this.lifecycle(event)
  }
  private requestContext(key: string, context: string | undefined) {
    if (!this.pendingContexts.has(key)) this.pendingContexts.set(key, [])
    this.pendingContexts.get(key)!.push(context)
  }
  private rejectContext(key: string, reason: string | undefined) {
    // Invalid/aborted requests never reached spawn-requested. Other refusals end the
    // newest request; a duplicate must leave an earlier same-name preparation intact.
    if (reason !== 'invalid' && reason !== 'aborted') this.pendingContexts.get(key)?.pop()
  }
  private acceptContext(context: string | undefined) {
    if (context === 'fork') this.forkSpawns++
    if (context === 'fresh') this.freshSpawns++
  }
  private reject(reason: string) {
    this.spawnsRejected++
    this.spawnRejectionReasons[reason] = (this.spawnRejectionReasons[reason] ?? 0) + 1
    // Invalid/already-aborted admission has no preceding spawn-requested fact.
    if (reason === 'invalid' || reason === 'aborted') this.spawnAttempts++
  }
  private lifecycle(event: BenchTeamEvent) {
    if (event.member === 'lead') return
    const key = JSON.stringify([event.teamId, event.member])
    if (event.kind === 'member-started') {
      if (!this.active.has(key)) this.active.set(key, new Set())
      this.active.get(key)!.add(event.runId!)
    }
    if (event.kind === 'member-settled') {
      this.active.get(key)?.delete(event.runId!)
      if (this.active.get(key)?.size === 0) this.active.delete(key)
    }
    this.maxConcurrentWorkers = Math.max(this.maxConcurrentWorkers, this.active.size)
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
