/**
 * How a finished turn is cut into "what was asked", "how it was reached", and
 * "the answer" — the split the transcript folds on.
 *
 * Kept out of the view so it can be tested on its own: which rows count as the
 * answer is a judgement about the agent's output, not about React.
 */

import { TOOL_GROUP_MIN } from './toolDisplay'
import type { ChatNode, MemberState } from './types'

/** Project accepted delegation calls into the recipient's conversation.
 * Keep attribution separate from real user prompts, including on old transcripts. */
export function withDelegationPrompts(nodes: readonly ChatNode[]): readonly ChatNode[] {
  const result = [...nodes]
  for (const node of nodes) {
    if (node.kind !== 'tool' || node.state !== 'ok'
      || (node.name !== 'spawn_agent' && node.name !== 'followup_task')) continue
    try {
      const args = JSON.parse(node.args) as Record<string, unknown> | null
      if (args === null || typeof args !== 'object') continue
      const followup = node.name === 'followup_task'
      const output = node.output === undefined ? undefined : JSON.parse(node.output) as Record<string, unknown> | null
      const member = followup ? args.target : output?.name ?? args.name
      const task = followup ? args.message : args.task
      if (typeof member !== 'string' || member.trim() === '' || typeof task !== 'string' || task.trim() === '') continue
      const id = `assignment:${node.id}`
      if (result.some(entry => entry.id === id)) continue
      const assignment: ChatNode = { kind: 'assignment', id, text: task, member,
        from: node.member ?? 'lead', followup, ...node.at === undefined ? {} : { at: node.at },
      }
      const callIndex = result.indexOf(node)
      // A worker can stream before spawn_agent returns. Put its initial task
      // before those rows, within the current prompt, without reordering work.
      let insertion = callIndex + 1
      if (!followup) {
        let start = callIndex
        while (start > 0 && !opensTurn(result[start]!)) start--
        const first = result.findIndex((entry, index) => index >= start && index < insertion
          && 'member' in entry && entry.member === member)
        if (first >= 0) insertion = first
      }
      result.splice(insertion, 0, assignment)
    } catch { /* Malformed legacy tool data is not an accepted task prompt. */ }
  }
  return result
}

/**
 * A span in words, for a line that is read rather than measured.
 * @param ms - Wall-clock span.
 * @returns Something like `8s`, `12m 55s`, or `1h 04m`.
 */
export function formatSpan(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * How long a set of rows took, from the stamps they carry.
 * @param nodes - Rows in any order.
 * @returns The span, or undefined when fewer than two rows are stamped.
 */
export function spanOf(nodes: readonly ChatNode[]): number | undefined {
  const stamps = nodes.map(node => node.at).filter((at): at is number => typeof at === 'number')
  if (stamps.length < 2) return undefined
  return Math.max(...stamps) - Math.min(...stamps)
}

/** One prompt and everything the agent did in reply to it. */
export interface Turn {
  /** The prompt, plus any steering messages sent while it ran. */
  readonly prompt: readonly ChatNode[]
  /** How the answer was reached: tools, reasoning, members, notices. */
  readonly work: readonly ChatNode[]
  /** The answer itself — the trailing prose, or the failure that replaced it. */
  readonly result: readonly ChatNode[]
  /** How long the turn took, when its rows carry stamps. */
  readonly spanMs: number | undefined
}

/**
 * A row that opens a new turn.
 *
 * A steering message is a user row too, but it belongs INSIDE the turn it
 * redirects — splitting there would cut one piece of work into two halves,
 * neither of which has an answer under it.
 */
export function opensTurn(node: ChatNode): boolean {
  return node.kind === 'user' && !node.id.endsWith('_steer')
}

/**
 * A row that is the answer rather than the work behind it.
 *
 * Only the lead's own finished prose qualifies: a member's text is its report
 * to the lead, and commentary is the agent narrating itself on the way. A
 * failure counts, and so does a question still waiting on the user — folding
 * either one away would hide the reason the turn stopped.
 */
export function isAnswer(node: ChatNode): boolean {
  if (node.kind === 'error') return true
  if (node.kind === 'question') return !node.answered
  return node.kind === 'text' && node.member === undefined && node.phase !== 'commentary'
}

/**
 * Split the transcript into turns, each one prompt / work / answer.
 *
 * The transcript used to be a flat stream in which a two-line answer sat at the
 * same level as the forty rows of tool calls that produced it, so the one part
 * the reader came for was the hardest part to find. Separating the answer from
 * the work is what lets the work fold away behind a single line.
 * @param nodes - The transcript, in order.
 * @returns One turn per prompt, in order.
 */
export function turnsOf(nodes: readonly ChatNode[]): readonly Turn[] {
  const groups: ChatNode[][] = []
  for (const node of nodes) {
    const last = groups[groups.length - 1]
    if (last === undefined || opensTurn(node)) groups.push([node])
    else last.push(node)
  }
  return groups.map((group) => {
    let head = 0
    while (head < group.length && group[head]?.kind === 'user') head += 1
    const { resultIndexes, continued } = answerRegion(group, head)
    return {
      prompt: group.slice(0, head),
      work: group.filter((_node, index) => index >= head && !resultIndexes.has(index)),
      result: group.filter((_node, index) => resultIndexes.has(index)).map(node =>
        continued && node.kind === 'text' ? { ...node, incomplete: true as const } : node),
      spanMs: spanOf(group),
    }
  })
}

/**
 * Lead tool calls that surround an answer instead of working towards one.
 *
 * Waiting on a member, closing a settled one, self-checking, restating the
 * todo list: a team lead does all of it BETWEEN the halves of its own answer,
 * and treating any of it as work put the first half inside the process fold.
 */
const CLOSING_TOOLS: ReadonlySet<string> = new Set([
  'wait_agents', 'submit_result', 'write_todos', 'list_agents',
])

/**
 * Whether a row means the answer above it is over and done with.
 *
 * Only the LEAD's own substantive work counts. A member's rows never do — a
 * worker reporting after the lead has begun answering is the normal shape of a
 * team run, not a new piece of work — and neither does the lead's own
 * narration or thinking. What does count is the lead going back to the tools,
 * or the user speaking again.
 * @param node - The row.
 * @returns True when the answer region cannot extend past it.
 */
function endsAnswerRegion(node: ChatNode): boolean {
  if (node.kind === 'user') return true
  if ('member' in node && node.member !== undefined) return false
  if (node.kind !== 'tool') return false
  return !CLOSING_TOOLS.has(node.name) && !isSettledClosure(node)
}

/**
 * Find the rows that are the answer rather than the work behind it.
 *
 * Reported from a nine-minute team run: the lead answered with a shortlist,
 * three workers kept reporting, the lead added a supplement — and the reader
 * was shown the supplement alone, with the shortlist folded away inside the
 * process. Two things had to change. The scan runs BACKWARDS from the end, so
 * a stray reasoning row after the answer no longer ends it before it starts;
 * and it does not stop at the first gap, because in a team run the lead's
 * answer legitimately arrives in halves with waiting and worker reports
 * between them. It stops where the lead went back to real work.
 *
 * An earlier answer separated from the tail by actual work — the clarifying
 * question this run opened with, two hundred tool calls before the shortlist —
 * stays in the fold, which is where a superseded message belongs.
 * @param group - One turn's rows, prompt included.
 * @param head - Index of the first row after the prompt.
 * @returns The result rows' indexes, and whether work continued past them.
 */
function answerRegion(
  group: readonly ChatNode[],
  head: number,
): { resultIndexes: ReadonlySet<number>, continued: boolean } {
  // A provider that never classifies a block leaves every phase 'unknown';
  // demanding the label would then leave every turn with no answer at all.
  const labelled = group.some(node => node.kind === 'text' && node.member === undefined
    && node.phase === 'final-answer')
  const isResult = (node: ChatNode): boolean => {
    if (node.kind === 'error') return true
    if (node.kind === 'question') return !node.answered
    if (node.kind !== 'text' || node.member !== undefined) return false
    return labelled ? node.phase === 'final-answer' : node.phase !== 'commentary'
  }
  const resultIndexes = new Set<number>()
  // Everything after the last answer row is crossed before the region opens:
  // a run stopped mid-flight ends on a tool call, and breaking there would
  // fold away the very answer this scan exists to find. Real work down here
  // does mean the answer on screen is not the whole of what was coming.
  let continued = false
  let index = group.length - 1
  for (; index >= head; index--) {
    const node = group[index] as ChatNode
    if (isResult(node)) break
    if (endsAnswerRegion(node)) continued = true
  }
  // The region itself: answer rows, and the gaps a team run leaves between
  // them — waiting on a member, closing a settled one, a worker still
  // reporting. It ends where the lead went back to real work.
  for (; index >= head; index--) {
    const node = group[index] as ChatNode
    if (isResult(node)) resultIndexes.add(index)
    else if (endsAnswerRegion(node)) break
  }
  return { resultIndexes, continued }
}

/** Closing a settled worker is bookkeeping; abandoning live work is not. */
function isSettledClosure(node: Extract<ChatNode, { kind: 'tool' }>): boolean {
  if (node.name !== 'close_agent') return false
  try {
    const args = JSON.parse(node.args) as { cancelRunning?: unknown } | null
    return args !== null && typeof args === 'object' && args.cancelRunning !== true
  } catch { return false }
}

/**
 * Rebuild a roster from the transcript.
 *
 * The live roster belongs to the RUN: it is empty before the first member
 * event and gone after a reload, so a finished team conversation offered no
 * way to look at one agent's work — the strip that does the filtering simply
 * was not there. The transcript still knows who reported and how much, and a
 * member in it has, by definition, finished.
 * @param nodes - The transcript, in order.
 * @returns One entry per member, in order of first appearance.
 */
export function rosterOf(nodes: readonly ChatNode[]): readonly MemberState[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    if (!('member' in node) || node.member === undefined) continue
    counts.set(node.member, (counts.get(node.member) ?? 0) + (node.kind === 'tool' ? 1 : 0))
  }
  return [...counts].map(([name, toolCalls]) => ({ name, status: 'done' as const, toolCalls }))
}

/** A run of rows drawn together: one row, or a foldable run of like rows. */
export type Segment =
  | { readonly kind: 'row', readonly node: ChatNode }
  | { readonly kind: 'tools', readonly nodes: readonly ChatNode[] }
  | { readonly kind: 'reasoning', readonly nodes: readonly Extract<ChatNode, { kind: 'reasoning' }>[] }

/**
 * Fold consecutive tool calls into runs.
 *
 * An agent's work arrives as long stretches of tool calls with a sentence of
 * prose between them, and drawn flat those stretches bury the prose: a hundred
 * and nineteen rows deep, the reader is scrolling past a wall to find the four
 * lines where the agent said what it was doing. A folded run keeps the prose
 * where it is and puts the calls one click away.
 *
 * A call still RUNNING is never folded into a run: it is the one the user is
 * watching, and hiding it behind a summary is exactly backwards.
 * @param nodes - One author's rows, in order.
 * @returns Segments in the same order.
 */
export function segmentsOf(nodes: readonly ChatNode[]): readonly Segment[] {
  const segments: Segment[] = []
  let tools: ChatNode[] = []
  let thoughts: Extract<ChatNode, { kind: 'reasoning' }>[] = []
  const flushTools = (): void => {
    if (tools.length >= TOOL_GROUP_MIN) segments.push({ kind: 'tools', nodes: tools })
    else for (const node of tools) segments.push({ kind: 'row', node })
    tools = []
  }
  // Always a group, even of one, so a stretch of thinking is one control
  // whether the model emitted it as one block or as nine.
  const flushThoughts = (): void => {
    if (thoughts.length > 0) segments.push({ kind: 'reasoning', nodes: thoughts })
    thoughts = []
  }
  for (const node of nodes) {
    if (node.kind === 'tool' && node.state !== 'running') {
      flushThoughts()
      tools.push(node)
      continue
    }
    if (node.kind === 'reasoning') {
      flushTools()
      thoughts.push(node)
      continue
    }
    flushTools()
    flushThoughts()
    segments.push({ kind: 'row', node })
  }
  flushTools()
  flushThoughts()
  return segments
}

/** One author's rows, gathered. */
export interface Block {
  /** The team member who produced them; absent means the agent you talk to. */
  readonly member: string | undefined
  readonly nodes: readonly ChatNode[]
}

/**
 * Group a turn's rows by who produced them.
 *
 * A member's rows are gathered into ONE block, at the point where that member
 * first appears, rather than into a block per consecutive run. Members work in
 * parallel, so their rows arrive interleaved: a nine-minute team run produced
 * forty-three panels for four agents, which is a wall rather than a record of
 * who did what. Gathering costs the interleaving between two members — an
 * order nobody could read anyway — and keeps the one thing that is legible,
 * where each member started relative to the lead.
 *
 * The lead's rows are left where they are, so the turn still reads top to
 * bottom as the agent you talked to.
 * @param nodes - The turn's rows, in order.
 * @returns One block per author, in order of first appearance.
 */
export function blocksOf(nodes: readonly ChatNode[]): readonly Block[] {
  const blocks: { member: string | undefined, nodes: ChatNode[] }[] = []
  for (const node of nodes) {
    const member = 'member' in node ? node.member : undefined
    if (member === undefined) {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last.member === undefined) last.nodes.push(node)
      else blocks.push({ member: undefined, nodes: [node] })
      continue
    }
    const own = blocks.find(block => block.member === member)
    if (own === undefined) blocks.push({ member, nodes: [node] })
    else own.nodes.push(node)
  }
  return blocks
}
