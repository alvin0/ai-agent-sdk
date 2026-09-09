import { describe, expect, it } from 'vitest'
import type { WireSpan } from '../../samples/chat-agents/backend/src/wire.ts'

const { duration, memberColors, nest, place, spanLabel, tokens } =
  await import('../../samples/chat-agents/web/src/ui/trace/spans.ts')

/**
 * The shape the trace view draws, which is NOT the shape the loop records.
 *
 * The loop hangs every tool call off the turn, beside the model round that
 * asked for it, because a call outlives the round. Read like that, a turn with
 * thirty rows says nothing about which round caused which call — so the view
 * re-parents each call onto the round that asked. That decision, and the
 * connector lines that depend on it, live here.
 */

let seq = 0

function span(
  kind: WireSpan['kind'],
  name: string,
  parentSpanId: string | null,
  extra: Partial<WireSpan> = {},
): WireSpan {
  seq += 1
  return {
    runId: 'run_1',
    traceId: 'trace_1',
    spanId: name,
    parentSpanId,
    seq,
    name,
    kind,
    startedAt: 1_000 + seq,
    durationMs: 10,
    status: 'success',
    ...extra,
  }
}

/** The rows a fully expanded tree draws, as `name` and depth. */
function layout(spans: readonly WireSpan[]): readonly { name: string; depth: number }[] {
  return place(nest(spans), new Set()).map(row => ({
    name: row.span.name,
    depth: row.guides.length,
  }))
}

describe('the tree the trace view draws', () => {
  it('puts each tool call under the model round that asked for it', () => {
    seq = 0
    const turn = span('invoke_agent', 'turn', null)
    const first = span('chat', 'round-1', 'turn')
    const search = span('execute_tool', 'search_files', 'turn')
    const read = span('execute_tool', 'read_file', 'turn')
    const second = span('chat', 'round-2', 'turn')
    const write = span('execute_tool', 'write_file', 'turn')

    // Every call is stored against the TURN, which is what the loop reports.
    expect([search, read, write].every(call => call.parentSpanId === 'turn')).toBe(true)

    expect(layout([turn, first, search, read, second, write])).toEqual([
      { name: 'turn', depth: 0 },
      { name: 'round-1', depth: 1 },
      { name: 'search_files', depth: 2 },
      { name: 'read_file', depth: 2 },
      { name: 'round-2', depth: 1 },
      { name: 'write_file', depth: 2 },
    ])
  })

  it('leaves a call that no round preceded where the loop put it', () => {
    // A run whose first span is a call — a resumed turn, a trace read back with
    // its first round missing — must not lose the row to a parent that is not
    // there. It stays at the turn's level rather than disappearing.
    seq = 0
    const turn = span('invoke_agent', 'turn', null)
    const orphan = span('execute_tool', 'read_file', 'turn')
    expect(layout([turn, orphan])).toEqual([
      { name: 'turn', depth: 0 },
      { name: 'read_file', depth: 1 },
    ])
  })

  it('draws a line past a row only while its ancestor has more to come', () => {
    seq = 0
    const turn = span('invoke_agent', 'turn', null)
    const first = span('chat', 'round-1', 'turn')
    const call = span('execute_tool', 'read_file', 'turn')
    const second = span('chat', 'round-2', 'turn')

    const rows = place(nest([turn, first, call, second]), new Set())
    const byName = new Map(rows.map(row => [row.span.name, row]))
    // The call sits two levels in. Nothing follows the turn, so its level draws
    // no line; round-1 is NOT the turn's last child, so its level draws one
    // that runs past the call down to round-2.
    expect(byName.get('read_file')?.guides).toEqual([false, true])
    expect(byName.get('read_file')?.last).toBe(true)
    // The turn's last child closes its branch instead of trailing past it.
    expect(byName.get('round-2')?.last).toBe(true)
    expect(byName.get('round-1')?.last).toBe(false)
  })

  it('hides a folded branch and keeps the rows above it', () => {
    seq = 0
    const turn = span('invoke_agent', 'turn', null)
    const round = span('chat', 'round-1', 'turn')
    const call = span('execute_tool', 'read_file', 'turn')

    const folded = place(nest([turn, round, call]), new Set(['round-1']))
    expect(folded.map(row => row.span.name)).toEqual(['turn', 'round-1'])
    // The fold is still offered: the row knows it has a child to bring back.
    expect(folded.at(-1)?.children).toBe(1)
  })

  it("keeps a team member's own run as its own branch", () => {
    // A member's spans arrive with a parent this run never recorded, so the
    // member's turn stands as a second root instead of being dropped.
    seq = 0
    const turn = span('invoke_agent', 'turn', null)
    const round = span('chat', 'round-1', 'turn')
    const member = span('invoke_agent', 'member-turn', 'span_from_another_trace', { member: 'auditor' })
    const memberRound = span('chat', 'member-round', 'member-turn', { member: 'auditor' })

    expect(layout([turn, round, member, memberRound])).toEqual([
      { name: 'turn', depth: 0 },
      { name: 'round-1', depth: 1 },
      { name: 'member-turn', depth: 0 },
      { name: 'member-round', depth: 1 },
    ])
  })

  it('gives every member a colour of its own, and reuses them in order', () => {
    const colors = memberColors(['researcher', 'auditor'])
    expect(colors.get('researcher')).not.toBe(colors.get('auditor'))
    // Seven members on one run is not a reason to have no colours at all.
    const many = memberColors(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(many.get('g')).toBe(many.get('a'))
    expect(memberColors([]).size).toBe(0)
  })

  it('names a step without repeating the badge beside it', () => {
    // The SDK's names lead with the operation and the row's badge already says
    // it, so "execute_tool read_file" would spend the width twice.
    expect(spanLabel(span('chat', 'chat gpt-reserve', null)).name).toBe('gpt-reserve')
    expect(spanLabel(span('invoke_agent', 'invoke_agent agent', null)).name).toBe('agent')
    // A name that does not carry the prefix is left exactly as it arrived.
    expect(spanLabel(span('compact', 'compact pressure', null)).name).toBe('pressure')
    expect(spanLabel(span('chat', 'gpt-reserve', null)).name).toBe('gpt-reserve')
  })

  it('says what effort a model round ran at', () => {
    // A route with a ladder charges and paces differently per level, so the
    // level is part of which call this was — not a conversation-wide setting.
    const high = spanLabel(span('chat', 'chat gpt-reserve', null, {
      attributes: { 'gen_ai.request.model': 'gpt-reserve', 'gen_ai.request.reasoning_effort': 'high' },
    }))
    expect(high).toEqual({ name: 'gpt-reserve', detail: 'high' })
    // A route with no ladder reports none, and none is shown rather than a
    // default the user never chose.
    const plain = spanLabel(span('chat', 'chat mock-scripted', null, {
      attributes: { 'gen_ai.request.model': 'mock-scripted' },
    }))
    expect(plain.detail).toBe('')
  })

  it("says whether the run read the project's instruction files", () => {
    // The question this answers is "why did it ignore our conventions", so a
    // run that found nothing has to say so — and say what it looked for.
    const loaded = spanLabel(span('context', 'context instructions', null, {
      attributes: { 'agent.instructions.files': 2, 'agent.instructions.candidates': 'AGENTS.override.md, AGENTS.md' },
      output: { files: [{ path: 'AGENTS.md' }, { path: 'web/AGENTS.md' }] },
    }))
    expect(loaded).toEqual({ name: 'instructions', detail: 'AGENTS.md, web/AGENTS.md' })

    const none = spanLabel(span('context', 'context instructions', null, {
      attributes: { 'agent.instructions.files': 0, 'agent.instructions.candidates': 'AGENTS.md' },
      output: { files: [] },
    }))
    expect(none.detail).toBe('none found · looked for AGENTS.md')
  })

  it('says how many skills the run discovered and which it was told to use', () => {
    const discovered = spanLabel(span('context', 'context skills', null, {
      attributes: { 'agent.skills.discovered': 12, 'agent.skills.named': 'code-review' },
    }))
    expect(discovered).toEqual({ name: 'skills', detail: '12 discovered · named code-review' })

    const nothingNamed = spanLabel(span('context', 'context skills', null, {
      attributes: { 'agent.skills.discovered': 0, 'agent.skills.named': '' },
    }))
    expect(nothingNamed.detail).toBe('0 discovered')
  })

  it('says which file a tool read and which query it searched', () => {
    // A trace of thirty identical "read_file" rows answers nothing. The detail
    // is the argument the transcript's own tool rows summarise.
    const read = spanLabel(span('execute_tool', 'execute_tool read_file', null, {
      attributes: { 'gen_ai.tool.name': 'read_file' },
      input: { path: 'src/app.ts' },
    }))
    expect(read).toEqual({ name: 'read_file', detail: 'src/app.ts' })

    const search = spanLabel(span('execute_tool', 'execute_tool search_files', null, {
      input: { query: 'TODO', path: '.' },
    }))
    expect(search).toEqual({ name: 'search_files', detail: 'TODO' })

    // A shell call is its command line, not the directory it ran in.
    const command = spanLabel(span('execute_tool', 'execute_tool run_command', null, {
      input: { command: 'pnpm test', cwd: '.' },
    }))
    expect(command.detail).toBe('pnpm test')

    // Nothing to say is said as nothing, not as "{}".
    const bare = spanLabel(span('execute_tool', 'execute_tool list_agents', null, { input: {} }))
    expect(bare).toEqual({ name: 'list_agents', detail: '' })
    const missing = spanLabel(span('execute_tool', 'execute_tool read_file', null))
    expect(missing.detail).toBe('')
  })

  it('writes a duration and a token count the way a reader reads them', () => {
    expect(duration(null)).toBe('…')
    expect(duration(7)).toBe('7ms')
    expect(duration(999)).toBe('999ms')
    expect(duration(1_000)).toBe('1.00s')
    expect(duration(68_450)).toBe('68.45s')
    expect(tokens(0)).toBe('0')
    expect(tokens(999)).toBe('999')
    expect(tokens(76_900)).toBe('76.9k')
  })
})
