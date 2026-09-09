/**
 * Token accounting.
 *
 * Every model call a run makes is recorded here, so the settings page can show
 * what each model — and each reasoning effort — has actually cost. The numbers
 * come from the SDK's run report, which carries one entry per model call with
 * the provider's own counters; nothing is inferred from the transcript.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import { database, schema } from './db/client'

/** Token counters as the run loop reports them. */
interface Counters {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** What one row of the usage table adds up to. */
export interface UsageTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly calls: number
}

/** Usage for one provider / model / effort route. */
export interface UsageRow extends UsageTotals {
  readonly provider: string
  readonly model: string
  readonly effort: string | null
  readonly lastUsedAt: number
}

export interface UsageSummary {
  readonly rows: readonly UsageRow[]
  readonly totals: UsageTotals
  /** Unix seconds of the oldest recorded call, or null when nothing is stored. */
  readonly since: number | null
}

/** Where the usage came from. */
export interface UsageContext {
  readonly conversationId: string
  readonly groupId: string
  readonly runId: string
  readonly provider: string
  readonly model: string
  readonly effort: string | undefined
  /** Team member that spent it; omitted for the agent the user talks to. */
  readonly member?: string
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * The token counters carried by a run event, if it carries any.
 *
 * TWO sources, because one is not enough.
 *
 * A `usage` event is emitted per model call, but only for a provider that
 * streams its counters — and a route that reports nothing until the response
 * completes emits none at all, which is how this page sat at zero through a
 * whole day of real runs. `turn-end` carries the turn's own accounting, which
 * the SDK assembles from every model call it made, so it is the one source
 * that exists whenever any usage exists at all.
 *
 * The two are reconciled by the caller rather than added: see
 * {@link turnShortfall}.
 * @param event - A run event from the lead or a member.
 * @returns The counters, or undefined for every other event.
 */
export function usageOf(event: AgentRunEvent): Counters | undefined {
  return event.type === 'usage' ? event.usage : undefined
}

/** Running total of what one run has already recorded, per member. */
export type UsageTally = Map<string, Counters>

const TALLY_KEYS = [
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
] as const

/**
 * Add one call's counters to what a run has recorded so far.
 * @param tally - The run's tally.
 * @param member - Team member, or undefined for the lead.
 * @param counters - What was just recorded.
 */
export function addToTally(tally: UsageTally, member: string | undefined, counters: Counters): void {
  const key = member ?? ''
  const current = tally.get(key) ?? {}
  const next: Record<string, number> = {}
  for (const field of TALLY_KEYS) {
    next[field] = count(current[field]) + count(counters[field])
  }
  tally.set(key, next as Counters)
}

/**
 * What a finished turn spent that has not been recorded yet.
 *
 * The turn's report is authoritative and complete; the per-call events are
 * earlier and may be absent. Recording the DIFFERENCE means a provider that
 * streams counters is counted once, and a provider that only reports at the
 * end is counted at all.
 * @param event - A run event; only `turn-end` carries a report.
 * @param tally - What this run has already recorded for this member.
 * @param member - Team member, or undefined for the lead.
 * @returns The unrecorded remainder, or undefined when there is none.
 */
export function turnShortfall(
  event: AgentRunEvent,
  tally: UsageTally,
  member?: string,
): Counters | undefined {
  if (event.type !== 'turn-end') return undefined
  const report = event.outcome.usageReport
  // `reported` is what providers actually returned. An estimate fills in only
  // where nothing was reported, and it is flagged as such by the SDK; counting
  // it here would present a guess as a measurement.
  const total: Counters = report.reported
  const already = tally.get(member ?? '') ?? {}
  const remainder: Record<string, number> = {}
  let any = false
  for (const field of TALLY_KEYS) {
    const value = count(total[field]) - count(already[field])
    if (value <= 0) continue
    remainder[field] = value
    any = true
  }
  // The report closes the turn, so the tally starts again with the next one.
  // Carrying it forward made an earlier turn's streamed counters look like this
  // turn's, and a turn the provider only reported at the end was then swallowed
  // whole by what the previous turn had already streamed.
  tally.delete(member ?? '')
  if (!any) return undefined
  return remainder as Counters
}

/**
 * Record one model call's token spend.
 *
 * A call that reports nothing at all is dropped rather than stored as a row of
 * zeroes: an empty row would inflate the call count without adding tokens.
 * @param counters - What the call spent.
 * @param context - Route, conversation, run, and the member that spent it.
 */
export async function recordUsage(
  counters: Counters | undefined,
  context: UsageContext,
): Promise<void> {
  if (counters === undefined) return
  const row = {
    id: `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    conversationId: context.conversationId,
    groupId: context.groupId === '' ? null : context.groupId,
    runId: context.runId,
    member: context.member ?? null,
    provider: context.provider,
    model: context.model,
    effort: context.effort ?? null,
    inputTokens: count(counters.inputTokens),
    outputTokens: count(counters.outputTokens),
    cacheReadTokens: count(counters.cacheReadTokens),
    cacheWriteTokens: count(counters.cacheWriteTokens),
    reasoningTokens: count(counters.reasoningTokens),
  }
  if (row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens === 0) return
  const { db } = database()
  await db.insert(schema.usageEvents).values(row).run()
}

/**
 * Totals per provider / model / effort, busiest first.
 * @param groupId - Restrict to one project; omitted counts every project.
 * @returns The rows, their sum, and when recording started.
 */
export async function usageSummary(groupId?: string): Promise<UsageSummary> {
  const { db } = database()
  const table = schema.usageEvents
  const scope = groupId === undefined || groupId === ''
    ? undefined
    : eq(table.groupId, groupId)
  const rows = await db.select({
    provider: table.provider,
    model: table.model,
    effort: table.effort,
    inputTokens: sql<number>`sum(${table.inputTokens})`,
    outputTokens: sql<number>`sum(${table.outputTokens})`,
    cacheReadTokens: sql<number>`sum(${table.cacheReadTokens})`,
    cacheWriteTokens: sql<number>`sum(${table.cacheWriteTokens})`,
    reasoningTokens: sql<number>`sum(${table.reasoningTokens})`,
    calls: sql<number>`count(*)`,
    lastUsedAt: sql<number>`max(${table.createdAt})`,
    firstUsedAt: sql<number>`min(${table.createdAt})`,
  })
    .from(table)
    .where(scope === undefined ? and() : scope)
    .groupBy(table.provider, table.model, table.effort)
    .all()

  const mapped: UsageRow[] = rows.map(row => ({
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
    totalTokens: Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0)
      + Number(row.cacheReadTokens ?? 0) + Number(row.cacheWriteTokens ?? 0),
    calls: Number(row.calls ?? 0),
    lastUsedAt: Number(row.lastUsedAt ?? 0),
  }))
  mapped.sort((left, right) => right.totalTokens - left.totalTokens)

  const totals = mapped.reduce<UsageTotals>((sum, row) => ({
    inputTokens: sum.inputTokens + row.inputTokens,
    outputTokens: sum.outputTokens + row.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
    reasoningTokens: sum.reasoningTokens + row.reasoningTokens,
    totalTokens: sum.totalTokens + row.totalTokens,
    calls: sum.calls + row.calls,
  }), {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, calls: 0,
  })

  const since = rows.reduce<number | null>((oldest, row) => {
    const value = Number(row.firstUsedAt ?? 0)
    if (value === 0) return oldest
    return oldest === null || value < oldest ? value : oldest
  }, null)

  return { rows: mapped, totals, since }
}

/**
 * Forget everything recorded.
 * @param groupId - Restrict to one project; omitted clears every project.
 */
export async function clearUsage(groupId?: string): Promise<void> {
  const { db } = database()
  if (groupId === undefined || groupId === '') {
    await db.delete(schema.usageEvents).run()
    return
  }
  await db.delete(schema.usageEvents).where(eq(schema.usageEvents.groupId, groupId)).run()
}
