/**
 * Turning a run's flat span list into the tree the trace view draws.
 *
 * Kept apart from the component because this is where the decisions are: which
 * step is drawn under which, where a connector line runs, and how a duration or
 * a token count is written. A component can be looked at; this can be tested.
 */

import type { WireSpan } from '@chat-agents/backend'
import { toolSummary } from '../chat/toolDisplay'

/** One span with its children, ready to draw. */
export interface SpanNode {
  readonly span: WireSpan
  readonly children: readonly SpanNode[]
}

/** A node placed in the tree: where it sits and which lines run past it. */
export interface SpanRow {
  readonly span: WireSpan
  readonly children: number
  /**
   * For each ancestor level, whether that ancestor has a later sibling.
   *
   * True draws a vertical line through this row, which is what keeps a deep
   * child visibly attached to the parent it belongs to.
   */
  readonly guides: readonly boolean[]
  /** Whether this node is its parent's last child, so the elbow closes. */
  readonly last: boolean
}

/** What each span kind is called in a row's badge. */
export const KIND_LABELS: Readonly<Record<WireSpan['kind'], string>> = {
  invoke_agent: 'agent',
  chat: 'model',
  execute_tool: 'tool',
  compact: 'compact',
  context: 'context',
}

/**
 * Colours for team members, in first-seen order.
 *
 * Fixed hues rather than design tokens: this is categorical colour, which the
 * token set has no scale for, and a team run reads as one agent talking to
 * itself when every row looks the same. Mid-lightness on purpose, so one value
 * works on both the light and the dark ground.
 */
export const MEMBER_COLORS: readonly string[] = [
  'hsl(207 75% 58%)',
  'hsl(268 60% 66%)',
  'hsl(158 55% 46%)',
  'hsl(24 80% 58%)',
  'hsl(340 65% 63%)',
  'hsl(48 70% 48%)',
]

/**
 * Put each tool call under the model round that asked for it.
 *
 * The loop hangs tool spans off the TURN, beside the round rather than inside
 * it, because a call outlives the round that requested it. True of the
 * lifetimes, and useless to read: a turn with thirty rows gives no clue which
 * round caused which call. So the display re-parents a tool call onto the last
 * round that started before it — the one that asked — while the stored trace
 * keeps the loop's own parent untouched.
 * @param siblings - One parent's children, in arrival order.
 * @param childrenOf - Children by span id, edited in place.
 * @returns The siblings that stay at this level.
 */
function adoptToolCalls(
  siblings: readonly WireSpan[],
  childrenOf: Map<string, WireSpan[]>,
): readonly WireSpan[] {
  const kept: WireSpan[] = []
  let round: WireSpan | undefined
  for (const span of siblings) {
    if (span.kind === 'execute_tool' && round !== undefined) {
      const bucket = childrenOf.get(round.spanId)
      if (bucket === undefined) childrenOf.set(round.spanId, [span])
      else bucket.push(span)
      continue
    }
    if (span.kind === 'chat') round = span
    kept.push(span)
  }
  return kept
}

/**
 * Nest the flat span list.
 *
 * A span whose parent is not in the list is a root: a team member runs its own
 * trace, and its spans arrive with a parent this run never recorded. Dropping
 * them would hide the member's work entirely, so they stand as their own tree.
 * @param spans - The run's spans, in any order.
 * @returns The roots, each with its children in arrival order.
 */
export function nest(spans: readonly WireSpan[]): readonly SpanNode[] {
  const ordered = [...spans].sort((left, right) => left.seq - right.seq)
  const ids = new Set(ordered.map(span => span.spanId))
  const childrenOf = new Map<string, WireSpan[]>()
  const roots: WireSpan[] = []
  for (const span of ordered) {
    const parent = span.parentSpanId
    if (parent === null || !ids.has(parent)) {
      roots.push(span)
      continue
    }
    const bucket = childrenOf.get(parent)
    if (bucket === undefined) childrenOf.set(parent, [span])
    else bucket.push(span)
  }
  const build = (span: WireSpan): SpanNode => {
    // A round's own calls were adopted while its PARENT was built, so they are
    // already here; running the adoption again over them is a no-op, because a
    // list of tool calls has no round in it to adopt them.
    const own = childrenOf.get(span.spanId) ?? []
    return { span, children: adoptToolCalls(own, childrenOf).map(build) }
  }
  return adoptToolCalls(roots, childrenOf).map(build)
}

/**
 * Flatten to the rows on screen, carrying the lines each one needs.
 * @param nodes - The roots.
 * @param collapsed - Span ids whose children are hidden.
 * @returns The visible rows, in draw order.
 */
export function place(
  nodes: readonly SpanNode[],
  collapsed: ReadonlySet<string>,
): readonly SpanRow[] {
  const rows: SpanRow[] = []
  const walk = (node: SpanNode, guides: readonly boolean[], last: boolean): void => {
    rows.push({ span: node.span, children: node.children.length, guides, last })
    if (collapsed.has(node.span.spanId)) return
    // A child's guides are this row's, plus whether THIS row continues below.
    const inherited = [...guides, !last]
    node.children.forEach((child, index) => {
      walk(child, inherited, index === node.children.length - 1)
    })
  }
  nodes.forEach((node, index) => { walk(node, [], index === nodes.length - 1) })
  return rows
}

/**
 * A duration a person can read at a glance.
 * @param ms - Milliseconds, or null while the span is open.
 * @returns Seconds for anything over a second, milliseconds below it.
 */
export function duration(ms: number | null): string {
  if (ms === null) return '…'
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * A token count, shortened once it stops being worth reading digit by digit.
 * @param count - The number of tokens.
 * @returns `1.2k` above a thousand, the number itself below it.
 */
export function tokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

/**
 * What a harness step found, in one line.
 *
 * These are the two questions a run gets asked when it behaves oddly — did it
 * read our conventions file, and did it see the skill it should have used — so
 * the answer belongs on the row rather than one click away. Zero is said out
 * loud: "no AGENTS.md" is the finding, not a missing value.
 * @param span - A `context` span.
 * @returns The line, or an empty string when the step reported nothing.
 */
function contextDetail(span: WireSpan): string {
  const files = span.attributes?.['agent.instructions.files']
  if (typeof files === 'number') {
    const names = span.attributes?.['agent.instructions.candidates']
    if (files === 0) {
      return typeof names === 'string' && names !== '' ? `none found · looked for ${names}` : 'none found'
    }
    const loaded = readPaths(span.output)
    return loaded === '' ? `${String(files)} loaded` : loaded
  }
  const discovered = span.attributes?.['agent.skills.discovered']
  if (typeof discovered === 'number') {
    const named = span.attributes?.['agent.skills.named']
    const used = typeof named === 'string' && named !== '' ? ` · named ${named}` : ''
    return `${String(discovered)} discovered${used}`
  }
  return ''
}

/** The instruction files themselves, which is what the row is really asked for. */
function readPaths(output: unknown): string {
  if (typeof output !== 'object' || output === null) return ''
  const files = (output as { files?: unknown }).files
  if (!Array.isArray(files)) return ''
  const paths = files
    .map(file => (file as { path?: unknown }).path)
    .filter((path): path is string => typeof path === 'string')
  return paths.join(', ')
}

/** How a row names a step: what it is, and what it acted on. */
export interface SpanLabel {
  /** The step itself — the tool's name, the model's id, the agent's id. */
  readonly name: string
  /** What it acted on: the file read, the query searched, the command run. */
  readonly detail: string
}

/**
 * Name one step for its row.
 *
 * The SDK's span names lead with the operation — `execute_tool read_file` — and
 * the row's own badge already says which operation it was, so the prefix is
 * dropped: it costs the width that the interesting half needs. For a tool call
 * that half is its arguments, summarised the same way the transcript's tool
 * rows summarise them, because "read_file" and "read_file src/app.ts" are not
 * the same answer to "what did the run actually do". For a model round it is
 * the reasoning effort the call ran at.
 * @param span - The step.
 * @returns Its name and its detail; the detail is empty when there is none.
 */
export function spanLabel(span: WireSpan): SpanLabel {
  const prefix = `${span.kind} `
  const name = span.name.startsWith(prefix) ? span.name.slice(prefix.length) : span.name
  if (span.kind === 'chat') {
    // The same model at minimal and at high is two different calls. A run can
    // also change effort part-way — a route with no ladder reports none — so it
    // belongs on the ROW rather than only in the conversation's settings.
    const effort = span.attributes?.['gen_ai.request.reasoning_effort']
    return { name, detail: typeof effort === 'string' ? effort : '' }
  }
  if (span.kind === 'context') return { name, detail: contextDetail(span) }
  if (span.kind !== 'execute_tool') return { name, detail: '' }
  const tool = span.attributes?.['gen_ai.tool.name']
  return {
    name: typeof tool === 'string' && tool !== '' ? tool : name,
    detail: toolSummary(name, span.input),
  }
}

/**
 * The colour each member's rows are drawn in.
 * @param members - Member names, in the order they should take colours.
 * @returns Member name to colour; empty for a run with one agent.
 */
export function memberColors(members: readonly string[]): ReadonlyMap<string, string> {
  return new Map(members.map((name, index) => [
    name,
    MEMBER_COLORS[index % MEMBER_COLORS.length] as string,
  ]))
}
