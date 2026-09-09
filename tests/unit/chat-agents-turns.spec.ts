import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../../samples/chat-agents/web/src/ui/chat/types.ts'

const { blocksOf, formatSpan, rosterOf, segmentsOf, turnsOf, withDelegationPrompts } =
  await import('../../samples/chat-agents/web/src/ui/chat/turns.ts')
const { toolGroupSummary } =
  await import('../../samples/chat-agents/web/src/ui/chat/toolDisplay.ts')

/**
 * Where a turn ends and its answer begins.
 *
 * Reported from the running app: a conversation read as one undifferentiated
 * stream, so the two paragraphs the user asked for were indistinguishable from
 * the forty tool rows that produced them. Folding the work away only helps if
 * the fold lands in the right place — everything below is about that line.
 */

function user(id: string, at?: number): ChatNode {
  return { kind: 'user', id, text: 'do the thing', ...at === undefined ? {} : { at } }
}

function tool(id: string, at?: number, member?: string): Extract<ChatNode, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    name: 'read_file',
    args: '{}',
    state: 'ok',
    ...at === undefined ? {} : { at },
    ...member === undefined ? {} : { member },
  }
}

function text(
  id: string,
  phase: 'commentary' | 'final-answer' | 'unknown',
  at?: number,
  member?: string,
): ChatNode {
  return {
    kind: 'text',
    id,
    text: 'here is what I found',
    phase,
    streaming: false,
    ...at === undefined ? {} : { at },
    ...member === undefined ? {} : { member },
  }
}

describe('subagent task prompts', () => {
  const spawn: ChatNode = { kind: 'tool', id: 'spawn-1', name: 'spawn_agent',
    args: JSON.stringify({ task: 'Compare dated bank reports.' }),
    output: JSON.stringify({ name: 'worker_1', status: 'running' }), state: 'ok',
  }

  it('shows the accepted task before worker output even if the worker streamed first', () => {
    const original = [user('u'), text('worker-text', 'commentary', undefined, 'worker_1'), spawn]
    const nodes = withDelegationPrompts(original)
    const own = blocksOf(nodes).find(b => b.member === 'worker_1')
    expect(own?.nodes[0]).toMatchObject({ kind: 'assignment', text: 'Compare dated bank reports.', from: 'lead' })
    expect(turnsOf(nodes)).toHaveLength(1)
    expect(original).toHaveLength(3)
    expect(withDelegationPrompts(nodes)).toEqual(nodes)
  })

  it('keeps a follow-up after the initial report and attributes the sender', () => {
    const followup: ChatNode = { kind: 'tool', id: 'followup', name: 'followup_task', state: 'ok', member: 'coordinator',
      args: JSON.stringify({ target: 'worker_1', message: 'Check the observation dates again.' }),
    }
    const nodes = withDelegationPrompts([user('u'), spawn, text('report', 'final-answer', undefined, 'worker_1'), followup])
    const own = nodes.filter(n => 'member' in n && n.member === 'worker_1')
    expect(own.map(n => n.kind)).toEqual(['assignment', 'text', 'assignment'])
    expect(own.at(-1)).toMatchObject({ from: 'coordinator', followup: true, text: 'Check the observation dates again.' })
  })

  it.each(['running', 'error', 'declined'] as const)('does not invent a delivered task for a %s call', state => {
    expect(withDelegationPrompts([{ ...spawn, state }])).toHaveLength(1)
  })

  it('does not move a new assignment into an older user turn that reused the member name', () => {
    const nodes = withDelegationPrompts([user('old'), text('old-report', 'final-answer', undefined, 'worker_1'), user('new'), spawn])
    expect(nodes.at(-1)).toMatchObject({ kind: 'assignment' })
    expect(turnsOf(nodes)).toHaveLength(2)
  })
})

describe('splitting a transcript into turns', () => {
  it('marks an earlier answer partial when the lead resumed work without another answer', () => {
    const original = text(':1.2.t0', 'final-answer')
    const [turn] = turnsOf([user('u'), original, tool('read-after-answer')])
    expect(turn?.result[0]).toMatchObject({ id: original.id, incomplete: true })
    expect(original).not.toHaveProperty('incomplete')
  })

  it('does not mark an answer partial just because a worker or todo update follows it', () => {
    const [turn] = turnsOf([user('u'), text(':1.2.t0', 'final-answer'),
      tool('worker-read', undefined, 'worker'), { ...tool('plan'), name: 'write_todos' }])
    expect(turn?.result[0]).not.toHaveProperty('incomplete')
  })

  it('marks an old answer partial after unread steering', () => {
    const [turn] = turnsOf([user('u'), text(':1.2.t0', 'final-answer'), user('u_steer')])
    expect(turn?.result[0]).toMatchObject({ incomplete: true })
  })

  it.each([false, true])('distinguishes cleanup from cancellation after an answer (cancelRunning=%s)', cancelRunning => {
    const [turn] = turnsOf([user('u'), text(':1.2.t0', 'final-answer'), {
      ...tool('close'), name: 'close_agent', args: JSON.stringify({ name: 'worker', cancelRunning }),
    }])
    expect(turn?.result[0]?.kind === 'text' && turn.result[0].incomplete === true).toBe(cancelRunning)
  })
  it('keeps both halves of an answer a worker report was delivered between', () => {
    // This expected only the LAST block, and a real run showed why it cannot:
    // a lead answered with its shortlist, three workers went on reporting, and
    // the lead added a supplement. Keeping the last block alone put the
    // shortlist — the answer — inside the process fold, which is what was
    // reported from the running app.
    const [turn] = turnsOf([
      user('u'), text(':1.15.t1', 'final-answer'),
      text('worker:1.16.t1', 'final-answer', undefined, 'worker'),
      text(':1.16.t1', 'final-answer'),
      { kind: 'reasoning', id: ':1.16.r0', text: 'summary' },
      text('worker:1.17.t1', 'final-answer', undefined, 'worker'),
    ])
    expect(turn?.result.map(n => n.id)).toEqual([':1.15.t1', ':1.16.t1'])
    expect(turn?.work).toHaveLength(3)
  })

  it('folds an answer the lead superseded by going back to work', () => {
    // The clarifying question this run opened with, two hundred tool calls
    // before the shortlist. Separated from the tail by real work, it is a
    // message that was overtaken — and a superseded message belongs in the
    // fold, not next to the answer.
    const [turn] = turnsOf([
      user('u'),
      text(':1.1.t1', 'final-answer'),
      tool('t_2'), tool('t_3'),
      text(':1.17.t1', 'final-answer'),
    ])
    expect(turn?.result.map(n => n.id)).toEqual([':1.17.t1'])
  })

  it('reaches across the bookkeeping a team lead does between the halves', () => {
    // wait_agents, submit_result, close_agent, write_todos: a lead does all of
    // it BETWEEN the halves of its own answer. Treated as work, each one cut
    // the answer in two and folded the first half away.
    const bookkeeping = ['wait_agents', 'submit_result', 'write_todos'].map((name, index) => ({
      ...tool(`k_${String(index)}`), name,
    }))
    const [turn] = turnsOf([
      user('u'),
      text(':1.17.t1', 'final-answer'),
      ...bookkeeping,
      text(':1.20.t1', 'final-answer'),
    ])
    expect(turn?.result.map(n => n.id)).toEqual([':1.17.t1', ':1.20.t1'])
  })

  it('keeps all final text blocks from the last lead round together', () => {
    const [turn] = turnsOf([user('u'), text(':1.2.t1', 'final-answer'),
      text(':1.2.t3', 'final-answer'), { kind: 'reasoning', id: ':1.2.r0', text: 'summary' }])
    expect(turn?.result.map(n => n.id)).toEqual([':1.2.t1', ':1.2.t3'])
  })

  it('puts the trailing answer outside the work that produced it', () => {
    const [turn] = turnsOf([
      user('u_0', 1_000),
      tool('t_1', 2_000),
      text('a_2', 'final-answer', 3_000),
    ])
    expect(turn?.prompt.map(node => node.id)).toEqual(['u_0'])
    expect(turn?.work.map(node => node.id)).toEqual(['t_1'])
    expect(turn?.result.map(node => node.id)).toEqual(['a_2'])
  })

  it('reads the span from the rows, because nothing else records it', () => {
    const [turn] = turnsOf([user('u_0', 1_000), tool('t_1', 2_000), text('a_2', 'final-answer', 776_000)])
    expect(turn?.spanMs).toBe(775_000)
    expect(formatSpan(turn?.spanMs ?? 0)).toBe('12m 55s')
  })

  it('leaves the span unknown on a transcript stored before rows were stamped', () => {
    const [turn] = turnsOf([user('u_0'), tool('t_1'), text('a_2', 'final-answer')])
    expect(turn?.spanMs).toBeUndefined()
  })

  it('keeps commentary and a member report inside the work', () => {
    // Commentary is the agent narrating itself, and a member's text is its
    // report to the lead. Neither is what the user asked for, so neither may
    // take the answer's place at the bottom of the turn.
    const [turn] = turnsOf([
      user('u_0'),
      text('c_1', 'commentary'),
      text('m_2', 'final-answer', undefined, 'researcher'),
    ])
    expect(turn?.work.map(node => node.id)).toEqual(['c_1', 'm_2'])
    expect(turn?.result).toEqual([])
  })

  it('treats a failure as the answer, so a fold never hides why a turn stopped', () => {
    const [turn] = turnsOf([
      user('u_0'),
      tool('t_1'),
      { kind: 'error', id: 'e_2', message: 'the provider refused' },
    ])
    expect(turn?.result.map(node => node.id)).toEqual(['e_2'])
  })

  it('keeps an unanswered question out of the fold, and a settled one in it', () => {
    const open = turnsOf([
      user('u_0'),
      tool('t_1'),
      { kind: 'question', id: 'q_2', requestId: 'q_2', questions: [], answered: false },
    ])
    expect(open[0]?.result.map(node => node.id)).toEqual(['q_2'])

    const settled = turnsOf([
      user('u_0'),
      { kind: 'question', id: 'q_1', requestId: 'q_1', questions: [], answered: true },
      text('a_2', 'final-answer'),
    ])
    expect(settled[0]?.work.map(node => node.id)).toEqual(['q_1'])
  })

  it('keeps a steering message inside the turn it redirects', () => {
    // Splitting on it would cut one piece of work into two halves, and the
    // first half would show a summary line with no answer under it.
    const turns = turnsOf([
      user('u_0'),
      tool('t_1'),
      user('u_2_steer'),
      tool('t_3'),
      text('a_4', 'final-answer'),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.work.map(node => node.id)).toEqual(['t_1', 'u_2_steer', 't_3'])
  })

  it('starts a new turn at each fresh prompt', () => {
    const turns = turnsOf([
      user('u_0'),
      text('a_1', 'final-answer'),
      user('u_2'),
      text('a_3', 'final-answer'),
    ])
    expect(turns.map(turn => turn.prompt.map(node => node.id))).toEqual([['u_0'], ['u_2']])
  })
})

/**
 * Who did what, in a run with more than one agent.
 *
 * Reported from the running app: a nine-minute team run drew forty-three
 * panels for three agents, because members work in parallel and their rows
 * arrive interleaved. Nobody can read that as a record of who did what.
 */
describe('gathering a turn by author', () => {
  it('gives each member one block, however often its rows are interrupted', () => {
    const blocks = blocksOf([
      tool('t_1', undefined, 'banks'),
      tool('t_2', undefined, 'industrial'),
      tool('t_3', undefined, 'banks'),
      tool('t_4', undefined, 'industrial'),
    ])
    expect(blocks.map(block => block.member)).toEqual(['banks', 'industrial'])
    expect(blocks[0]?.nodes.map(node => node.id)).toEqual(['t_1', 't_3'])
    expect(blocks[1]?.nodes.map(node => node.id)).toEqual(['t_2', 't_4'])
  })

  it('places a member where it first appears, so the lead still reads in order', () => {
    // Where a member STARTED relative to the lead is the one piece of ordering
    // that survives gathering, and it is the piece that means something: it is
    // the lead's own spawn_agent call that put it there.
    const blocks = blocksOf([
      tool('lead_1'),
      tool('t_2', undefined, 'banks'),
      tool('lead_3'),
      tool('t_4', undefined, 'banks'),
    ])
    expect(blocks.map(block => block.member)).toEqual([undefined, 'banks', undefined])
    expect(blocks[2]?.nodes.map(node => node.id)).toEqual(['lead_3'])
  })

  it("keeps the lead's consecutive rows in one block", () => {
    const blocks = blocksOf([tool('lead_1'), text('lead_2', 'commentary'), tool('lead_3')])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.member).toBeUndefined()
  })
})

/**
 * The roster after the run that made it is gone.
 *
 * The live roster belongs to the run, so a reloaded team conversation had no
 * strip at all — and the strip is the only way to read one agent's work on its
 * own.
 */
describe('rebuilding a roster from the transcript', () => {
  it('lists every member that reported, in order of first appearance', () => {
    const roster = rosterOf([
      user('u_0'),
      tool('t_1', undefined, 'banks'),
      tool('t_2', undefined, 'industrial'),
      tool('t_3', undefined, 'banks'),
    ])
    expect(roster.map(entry => entry.name)).toEqual(['banks', 'industrial'])
  })

  it('counts tool calls, and calls a member in a stored transcript finished', () => {
    // It reported and the run is over; there is no third possibility, and
    // "idle" would paint a finished agent as though it were still waiting.
    const roster = rosterOf([
      tool('t_1', undefined, 'banks'),
      text('m_2', 'final-answer', undefined, 'banks'),
      tool('t_3', undefined, 'banks'),
    ])
    expect(roster).toEqual([{ name: 'banks', status: 'done', toolCalls: 2 }])
  })

  it('is empty for a conversation with no members', () => {
    expect(rosterOf([user('u_0'), tool('t_1'), text('a_2', 'final-answer')])).toEqual([])
  })
})

/**
 * The middle level of the fold.
 *
 * The turn folds, and every tool row folds its own output, but between them sat
 * a flat list of every call the agent made — a hundred and nineteen rows with
 * four sentences of prose buried in them.
 */
describe('folding runs of tool calls', () => {
  it('folds three or more consecutive calls, and leaves two alone', () => {
    const three = segmentsOf([tool('t_1'), tool('t_2'), tool('t_3')])
    expect(three).toHaveLength(1)
    expect(three[0]?.kind).toBe('tools')

    // Two rows are not a wall; hiding them costs a click to learn less than
    // the rows already said.
    expect(segmentsOf([tool('t_1'), tool('t_2')]).map(part => part.kind)).toEqual(['row', 'row'])
  })

  it('breaks a run at the prose between calls, which is the point', () => {
    const segments = segmentsOf([
      tool('t_1'), tool('t_2'), tool('t_3'),
      text('c_4', 'commentary'),
      tool('t_5'), tool('t_6'), tool('t_7'),
    ])
    expect(segments.map(part => part.kind)).toEqual(['tools', 'row', 'tools'])
  })

  it('never folds a call that is still running', () => {
    // It is the row the user is watching; hiding it behind a summary is
    // exactly backwards.
    const live: ChatNode = {
      kind: 'tool', id: 't_3', name: 'run_command', args: '{}', state: 'running',
    }
    const segments = segmentsOf([tool('t_1'), tool('t_2'), live, tool('t_4')])
    expect(segments.map(part => part.kind)).toEqual(['row', 'row', 'row', 'row'])
  })
})

describe('what a folded run of calls says about itself', () => {
  it('names the tools rather than counting anonymous steps', () => {
    expect(toolGroupSummary(['Run', 'Run', 'Run'])).toBe('Run · 3 steps')
    expect(toolGroupSummary(['Fetch', 'Run', 'Fetch'])).toBe('Fetch, Run · 3 steps')
  })

  it('caps the names, because the count is what grows', () => {
    expect(toolGroupSummary(['Run', 'Fetch', 'Read', 'Edit', 'Search']))
      .toBe('Run, Fetch, Read +2 more · 5 steps')
  })
})

describe('how a span is written', () => {
  it('rounds to whole seconds under a minute, and never says 0s', () => {
    expect(formatSpan(8_400)).toBe('8s')
    expect(formatSpan(120)).toBe('1s')
  })

  it('switches to minutes and then to hours', () => {
    expect(formatSpan(61_000)).toBe('1m 1s')
    expect(formatSpan(3_840_000)).toBe('1h 04m')
  })
})
