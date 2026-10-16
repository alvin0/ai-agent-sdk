/** Structural adapter: this harness also runs against SDK branches without timeline types. */
export interface BenchTeamEvent {
  type: string; schemaVersion?: 1; teamId: string; sequence?: number; kind?: string; member: string
  parentTeamId?: string
  depth?: number
  conversationId?: string
  reason?: string
  context?: string
  code?: string
  busy?: number
  preparing?: number
  limit?: number
  occurredAt?: string
  elapsedMs?: number
  activation?: { source: string; sender?: string }
  message?: { id: string; sender: string; target: string; delivery: string; createdAt: string }
  runId?: string
  usage?: { reported: Record<string, unknown>; authoritative: boolean; coverage: { logicalCalls: number } }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
const asObject = (value: unknown) => object(value) ? value : {}

export function isTimelineEvent(event: Record<string, unknown>):
event is Record<string, unknown> & BenchTeamEvent & { sequence: number } {
  return event.schemaVersion === 1 && typeof event.sequence === 'number'
    && ['teamId', 'kind', 'member'].every(key => typeof event[key] === 'string')
}
export function lifecycleMetadata(event: Record<string, unknown>,
  rootTeamId: string | undefined): BenchTeamEvent | undefined {
  if (event.type === 'member-attached' && object(event.member) && typeof event.member.name === 'string') {
    return { type: event.type, teamId: rootTeamId ?? '', member: event.member.name }
  }
  if (event.type === 'message-accepted' && object(event.message)) return messageMetadata(event.message)
  if (typeof event.type === 'string' && event.type.startsWith('member-run-') && typeof event.member === 'string') {
    return runMetadata(event, rootTeamId)
  }
  return undefined
}
function messageMetadata(message: Record<string, unknown>): BenchTeamEvent | undefined {
  const { id, teamId, sender, target, delivery, createdAt } = message
  if (![id, teamId, sender, target, delivery, createdAt].every(value => typeof value === 'string')) return undefined
  return { type: 'message-accepted', teamId, member: target,
    message: { id, sender, target, delivery, createdAt } } as BenchTeamEvent
}
function runMetadata(event: Record<string, unknown>, rootTeamId: string | undefined) {
  const response = asObject(event.response)
  const report = asObject(response.report), outcome = asObject(response.outcome)
  return { type: String(event.type), teamId: rootTeamId ?? '', member: String(event.member),
    ...typeof report.runId === 'string' ? { runId: report.runId } : {},
    ...typeof outcome.yielded === 'boolean' ? { yielded: outcome.yielded } : {} }
}
