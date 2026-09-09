/**
 * The execution trace of a run: what called what, and how long each step took.
 *
 * The SDK already emits OpenTelemetry-shaped span events on the same stream as
 * the text and the tool calls — `span-start` when a step opens, `span-end` when
 * it closes. The transcript throws them away, because a transcript answers
 * "what did the agent say"; this module keeps them, because the trace view
 * answers "what did the agent DO, and where did the ten seconds go".
 *
 * One row per span, written when it opens and updated when it closes, so a
 * trace opened mid-run reads the same way as one opened afterwards. The lead's
 * spans and every member's spans land in one trace: a delegation is a parent
 * span with the member's work nested under it, which is the whole reason to
 * look at a team run this way.
 */

import { asc, desc, eq } from 'drizzle-orm'
import type { AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { database, schema } from './db/client'
import { fingerprintOf } from './provider-calls'
import type { CallFingerprint } from './provider-calls'
import type { WireApiCall, WireEvent, WireSpan, WireSpanUsage } from './wire'

/** One run's trace, as the conversation's trace picker lists them. */
export interface TraceSummary {
  readonly runId: string
  readonly traceId: string
  /** Epoch milliseconds of the earliest span. */
  readonly startedAt: number
  /** First start to last end, or null while a span is still open. */
  readonly durationMs: number | null
  readonly status: WireSpan['status']
  readonly spans: number
  /**
   * The prompt the run answered, shortened.
   *
   * A collapsed run has to say which prompt it was: a run id and a timestamp
   * are not how anyone remembers "the one where it edited the wrong file".
   */
  readonly prompt: string
  /** Team members that produced spans in this run, in first-seen order. */
  readonly members: readonly string[]
  /**
   * What the whole run spent, summed from the model rounds inside it.
   *
   * Cached input is kept apart from fresh input because the two are not billed
   * the same, and a run that looks expensive is often mostly cache.
   */
  readonly usage: {
    readonly inputTokens: number
    readonly cacheReadTokens: number
    readonly outputTokens: number
  }
}

/** How much of the prompt a collapsed run row carries. */
const PROMPT_PREVIEW = 140

function promptOf(root: typeof schema.traceSpans.$inferSelect | undefined): string {
  const input = root === undefined ? undefined : parse(root.input)
  const text = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input)
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > PROMPT_PREVIEW
    ? `${flattened.slice(0, PROMPT_PREVIEW)}…`
    : flattened
}

const KINDS = new Set(['invoke_agent', 'chat', 'execute_tool', 'compact', 'context'])

function spanKind(value: string): WireSpan['kind'] {
  return KINDS.has(value) ? value as WireSpan['kind'] : 'chat'
}

function parse(value: string | null): unknown {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    // A row written by an older shape is worth less than a broken trace view.
    return undefined
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

/** Rebuild the wire shape from one stored row. */
function rowToSpan(row: typeof schema.traceSpans.$inferSelect): WireSpan {
  const attributes = object(parse(row.attributes))
  const usage = object(parse(row.usage))
  const error = object(parse(row.error))
  const input = parse(row.input)
  const apiCall = object(parse(row.apiCall))
  const output = parse(row.output)
  return {
    runId: row.runId,
    traceId: row.traceId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    seq: row.seq,
    name: row.name,
    kind: spanKind(row.kind),
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    status: row.status as WireSpan['status'],
    ...row.member === null ? {} : { member: row.member },
    ...attributes === undefined ? {} : { attributes },
    ...input === undefined ? {} : { input },
    ...output === undefined ? {} : { output },
    ...usage === undefined ? {} : { usage: usage as WireSpanUsage },
    ...apiCall === undefined ? {} : { apiCall: apiCall as unknown as WireApiCall },
    ...error === undefined ? {} : { error: error as NonNullable<WireSpan['error']> },
  }
}

/**
 * The traces a conversation has, newest run first.
 * @param conversationId - The conversation to list.
 * @param limit - How many runs to report.
 * @returns One summary per run, in reverse start order.
 */
export async function listTraces(
  conversationId: string,
  limit = 50,
): Promise<readonly TraceSummary[]> {
  const { db } = database()
  const rows = await db.select()
    .from(schema.traceSpans)
    .where(eq(schema.traceSpans.conversationId, conversationId))
    .orderBy(desc(schema.traceSpans.startedAt))
    .all()
  const byRun = new Map<string, (typeof rows)[number][]>()
  for (const row of rows) {
    const bucket = byRun.get(row.runId)
    if (bucket === undefined) byRun.set(row.runId, [row])
    else bucket.push(row)
  }
  const summaries: TraceSummary[] = []
  for (const [runId, spans] of byRun) {
    const startedAt = Math.min(...spans.map(span => span.startedAt))
    const open = spans.some(span => span.durationMs === null)
    const ends = spans
      .filter(span => span.durationMs !== null)
      .map(span => span.startedAt + (span.durationMs ?? 0))
    // The run's own span decides the status once it has closed: a tool call
    // that failed and was recovered from is not a failed run.
    const root = spans.find(span => span.parentSpanId === null)
    const status: WireSpan['status'] = open
      ? 'unknown'
      : root === undefined
        ? spans.some(span => span.status === 'error') ? 'error' : 'success'
        : root.status as WireSpan['status']
    summaries.push({
      runId,
      traceId: spans[0]?.traceId ?? '',
      startedAt,
      durationMs: open || ends.length === 0 ? null : Math.max(...ends) - startedAt,
      status,
      spans: spans.length,
      prompt: promptOf(root),
      members: [...new Set(spans
        .sort((left, right) => left.seq - right.seq)
        .flatMap(span => span.member === null ? [] : [span.member]))],
      // Model rounds only. The turn span reports the turn TOTAL, so counting
      // it alongside its own rounds would bill every run twice.
      usage: totalUsage(spans
        .filter(span => span.kind === 'chat')
        .map(span => usageOf(parse(span.usage)))),
    })
  }
  return summaries.sort((left, right) => right.startedAt - left.startedAt).slice(0, limit)
}

/**
 * Every span of one run, in the order they started.
 * @param runId - The run to read.
 * @returns The spans; empty for a run with none, which is how an unknown run
 * answers too.
 */
export async function readTrace(runId: string): Promise<readonly WireSpan[]> {
  const { db } = database()
  const rows = await db.select()
    .from(schema.traceSpans)
    .where(eq(schema.traceSpans.runId, runId))
    .orderBy(asc(schema.traceSpans.seq))
    .all()
  return rows.map(rowToSpan)
}

/** Drop a conversation's spans, for when the conversation itself goes. */
export async function deleteTraces(conversationId: string): Promise<void> {
  const { db } = database()
  await db.delete(schema.traceSpans)
    .where(eq(schema.traceSpans.conversationId, conversationId))
    .run()
}

function usageOf(value: unknown): WireSpanUsage | undefined {
  const source = object(value)
  if (source === undefined) return undefined
  const counters: Record<string, number> = {}
  for (const key of [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'reasoningTokens', 'totalTokens',
  ]) {
    const count = source[key]
    if (typeof count === 'number') counters[key] = count
  }
  return Object.keys(counters).length === 0 ? undefined : counters
}

/**
 * Add up what a run's model rounds spent.
 *
 * Model rounds ONLY: a turn span carries the turn's aggregate, so a sum over
 * every span that reports usage counts the same tokens twice.
 * @param reports - The usage of each model-round span, where it reported any.
 * @returns Fresh input, cached input, and output, summed.
 */
function totalUsage(
  reports: readonly (WireSpanUsage | undefined)[],
): TraceSummary['usage'] {
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  for (const report of reports) {
    if (report === undefined) continue
    inputTokens += report.inputTokens ?? 0
    cacheReadTokens += report.cacheReadTokens ?? 0
    outputTokens += report.outputTokens ?? 0
  }
  return { inputTokens, cacheReadTokens, outputTokens }
}

/** Parse a tool's raw arguments, or keep the string when it is not JSON. */
function toolInput(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function json(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(value) ?? null
  } catch {
    // A tool result holding something unserialisable must not take the whole
    // run's trace down with it.
    return JSON.stringify({ unserializable: true })
  }
}

/** One piece of work the harness did around a turn, for the trace. */
export interface HarnessStep {
  /** What it was: `instructions`, `skills`. */
  readonly name: string
  /** Epoch milliseconds it started. */
  readonly startedAt: number
  readonly durationMs: number
  /** What it found, shown in the details pane. */
  readonly output: unknown
  /** The short facts a row is read by, in OpenTelemetry-ish keys. */
  readonly attributes?: Readonly<Record<string, unknown>>
  /** An error means the harness could not look; the run went ahead regardless. */
  readonly error?: NonNullable<WireSpan['error']>
}

/**
 * Collect one run's spans while it happens.
 *
 * Fed the RAW SDK events, before the transcript projector sees them, because a
 * span never becomes a transcript node. Every `observe` hands back the wire
 * events to forward, so the browser draws the waterfall as the run builds it
 * rather than after the fact.
 */
export class RunTrace {
  private readonly conversationId: string
  private readonly runId: string
  /** The merged span per id: a `span-end` updates what `span-start` recorded. */
  private readonly spans = new Map<string, WireSpan>()
  /** Tool arguments by span id, for a call whose span has not opened yet. */
  private readonly pendingInputs = new Map<string, unknown>()
  private seq = 0
  /**
   * What the user asked for, as the root span's Input.
   *
   * Kept here rather than read off the event: the SDK's root span carries the
   * agent's identity and its model, not the prompt.
   */
  private readonly prompt: string
  /** The run's own span, once the loop has opened it. */
  private root: { traceId: string; spanId: string } | undefined
  /** Harness steps recorded before the run's span existed to hang them from. */
  private readonly waiting: HarnessStep[] = []
  /** Provider calls whose round has not opened its span yet. */
  private readonly waitingCalls: { call: WireApiCall; id: CallFingerprint }[] = []

  constructor(conversationId: string, runId: string, prompt: string) {
    this.conversationId = conversationId
    this.runId = runId
    this.prompt = prompt
  }

  /**
   * Record work the harness did around the turn, not inside it.
   *
   * Reading the project's `AGENTS.md` files and discovering the skill catalogue
   * decide what the model is about to see, and the loop never reports them as
   * steps: the instructions arrive as a context section it rewrites silently,
   * and the catalogue arrives as a tool schema. A run that quietly read no
   * conventions file is then indistinguishable from one that read three, which
   * is exactly the question asked when an agent ignores a project's rules.
   *
   * Held until the run's own span opens, so these hang under it rather than
   * drawing as roots of their own.
   * @param step - What was done, and what it found.
   * @returns The wire events to forward; empty while the run has no span yet.
   */
  note(step: HarnessStep): readonly WireEvent[] {
    if (this.root === undefined) {
      this.waiting.push(step)
      return []
    }
    return [this.emitNote(step, this.root)]
  }

  /**
   * Attach one recorded provider call to the round that made it.
   *
   * Matched on request identity — model, message count, last message id —
   * because two agents of a team stream at once and "whichever round was open"
   * would file one member's call under another's. A call whose round has not
   * opened yet is held: the recording finishes when the STREAM does, which for
   * a fast round can beat the span's own start through the queue.
   * @param call - The recorded call.
   * @param id - Its fingerprint.
   * @returns The wire events to forward; empty when the round is not here yet.
   */
  attachCall(call: WireApiCall, id: CallFingerprint): readonly WireEvent[] {
    for (const span of this.spans.values()) {
      if (span.kind !== 'chat' || span.apiCall !== undefined) continue
      const model = span.attributes?.['gen_ai.request.model']
      if (typeof model !== 'string') continue
      if (fingerprintOf(model, span.input) !== id) continue
      return [this.merge({ ...span, apiCall: call })]
    }
    this.waitingCalls.push({ call, id })
    return []
  }

  /**
   * Fold one raw event into the trace.
   * @param event - An SDK event, from the lead's stream or a member's callback.
   * @param member - The member that produced it; omitted for the lead.
   * @returns The wire events to forward; empty for anything that is not a span.
   */
  observe(event: AgentRunEvent, member?: string): readonly WireEvent[] {
    if (event.type === 'tool-call') return this.recordArguments(event)
    if (event.type === 'span-start') {
      const startedAt = stamp(event.at)
      const seq = this.seq
      this.seq += 1
      const captured = this.pendingInputs.get(event.trace.spanId)
      this.pendingInputs.delete(event.trace.spanId)
      const isRoot = event.kind === 'invoke_agent' && event.trace.parentSpanId === null
      // The loop supplies its own input for a step that has one — a model
      // round's request summary — and that beats anything guessed here. The
      // prompt is the run's, and a tool call's arguments arrive on their own
      // event, so both stay as fallbacks.
      const input = event.input ?? (isRoot ? this.prompt : captured)
      if (isRoot && this.root === undefined) {
        this.root = { traceId: event.trace.traceId, spanId: event.trace.spanId }
      }
      const opened = this.merge({
        runId: this.runId,
        traceId: event.trace.traceId,
        spanId: event.trace.spanId,
        parentSpanId: event.trace.parentSpanId,
        seq,
        name: event.name,
        kind: event.kind,
        startedAt,
        durationMs: null,
        status: 'unknown',
        ...member === undefined ? {} : { member },
        ...event.attributes === undefined ? {} : { attributes: event.attributes },
        ...input === undefined ? {} : { input },
      })
      // The harness's own steps ran before the loop opened this span, so they
      // are flushed the moment there is something to hang them from — right
      // after it, which is also when they happened.
      const held = this.root === undefined ? [] : this.waiting.splice(0)
      const notes = held.map(step => this.emitNote(step, this.root as { traceId: string; spanId: string }))
      // A recording that finished before its round's span arrived is claimed
      // now, by the same identity match.
      const claimed: WireEvent[] = []
      if (event.kind === 'chat') {
        const index = this.waitingCalls.findIndex(waiting => (
          waiting.id === fingerprintOf(String(event.attributes?.['gen_ai.request.model']), input)
        ))
        const waiting = index === -1 ? undefined : this.waitingCalls.splice(index, 1)[0]
        const span = this.spans.get(event.trace.spanId)
        if (waiting !== undefined && span !== undefined) {
          claimed.push(this.merge({ ...span, apiCall: waiting.call }))
        }
      }
      return [opened, ...notes, ...claimed]
    }
    if (event.type !== 'span-end') return []
    const known = this.spans.get(event.trace.spanId)
    // A span whose start never arrived cannot be placed in the tree, and a
    // parentless row would draw as a second root.
    if (known === undefined) return []
    const usage = usageOf(event.usage)
    return [this.merge({
      ...known,
      durationMs: Math.max(0, stamp(event.at) - known.startedAt),
      status: event.status,
      ...event.output === undefined ? {} : { output: event.output },
      ...usage === undefined ? {} : { usage },
      ...event.error === undefined ? {} : { error: event.error },
    })]
  }

  /**
   * Keep a call's arguments, which only the `tool-call` event carries.
   *
   * The call and the `execute_tool` span share a span id, so the arguments are
   * either folded into the span already recorded or held for the one about to
   * open.
   * @param event - The raw `tool-call` event.
   * @returns The re-sent span when there was one to update.
   */
  private recordArguments(
    event: Extract<AgentRunEvent, { type: 'tool-call' }>,
  ): readonly WireEvent[] {
    const spanId = event.trace?.spanId
    if (spanId === undefined) return []
    const input = toolInput(event.call.rawArguments)
    const known = this.spans.get(spanId)
    if (known === undefined) {
      this.pendingInputs.set(spanId, input)
      return []
    }
    return [this.merge({ ...known, input })]
  }

  /**
   * Turn one harness step into a span under the run.
   * @param step - What the harness did.
   * @param root - The run's own span, which this one hangs from.
   * @returns The wire event to forward.
   */
  private emitNote(step: HarnessStep, root: { traceId: string; spanId: string }): WireEvent {
    const seq = this.seq
    this.seq += 1
    return this.merge({
      runId: this.runId,
      traceId: root.traceId,
      // Not a span the loop ever emitted, so its id is the harness's own. The
      // prefix keeps it from ever colliding with a 16-hex SDK span id.
      spanId: `harness_${this.runId}_${step.name}_${String(seq)}`,
      parentSpanId: root.spanId,
      seq,
      name: `context ${step.name}`,
      kind: 'context',
      startedAt: step.startedAt,
      durationMs: step.durationMs,
      status: step.error === undefined ? 'success' : 'error',
      ...step.attributes === undefined ? {} : { attributes: step.attributes },
      output: step.output,
      ...step.error === undefined ? {} : { error: step.error },
    })
  }

  /** Store the merged span, write it, and wrap it as the wire event to send. */
  private merge(span: WireSpan): WireEvent {
    this.spans.set(span.spanId, span)
    void this.persist(span)
    return { t: 'span', span }
  }

  /**
   * Write one span to the database.
   *
   * Not awaited by `observe`: the run's own progress must not wait on the
   * trace, and the browser has the span from the stream either way. A failure
   * costs this row in a reloaded trace and nothing else, so it is swallowed.
   * @param span - The merged span.
   */
  private async persist(span: WireSpan): Promise<void> {
    try {
      const { db } = database()
      const values = {
        id: `${span.runId}:${span.spanId}`,
        conversationId: this.conversationId,
        runId: span.runId,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        seq: span.seq,
        member: span.member ?? null,
        name: span.name,
        kind: span.kind,
        startedAt: span.startedAt,
        durationMs: span.durationMs,
        status: span.status,
        attributes: json(span.attributes),
        input: json(span.input),
        output: json(span.output),
        usage: json(span.usage),
        apiCall: json(span.apiCall),
        error: json(span.error),
      }
      await db.insert(schema.traceSpans).values(values)
        .onConflictDoUpdate({ target: schema.traceSpans.id, set: values })
        .run()
    } catch {
      // Deliberately silent: see the doc comment.
    }
  }
}

function stamp(at: string): number {
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : Date.now()
}
