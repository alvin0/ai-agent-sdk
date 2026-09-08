import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@ai-agent-sdk/core'
import type { GenerateOptions, StreamChunk } from '@ai-agent-sdk/core'

const home = mkdtempSync(join(tmpdir(), 'soak-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_SPILL = join(home, '.data', 'spill')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')
process.env.CHAT_AGENTS_MOCK_MODEL = '1'

const { runPrompt, forgetSession } =
  await import('../../samples/chat-agents/backend/src/session.ts')
const { updateConversation, readMessages, ensureConversation } =
  await import('../../samples/chat-agents/backend/src/conversations.ts')
const { setMockScript, resetMock } =
  await import('../../samples/chat-agents/backend/src/mock-provider.ts')

/**
 * The reported prompt, run over and over with the timing shuffled.
 *
 * "Summarize the stocks worth holding in September–October 2026; use several
 * agents to research the sectors." Every failure this sample has had came from
 * that shape — a lead that answers before its researchers, a worker that speaks
 * last, a close that does not close — and every one of them was a RACE, visible
 * only on the run where the timing lined up. One pass proves nothing; this runs
 * the same prompt many times with different delays and checks the same
 * invariants each time.
 */

const PROMPT = 'Tổng hợp cho tôi giá các cổ phiếu tăng giá tốt và có tiềm năng trong tháng 9 và 10'
  + ' 2026, có thể sử dụng multiple agent chia thành nhiều lĩnh vực để research hiệu quả hơn'

const SECTORS = ['macro_banks', 'tech_industrial', 'realestate_infra', 'consumer_retail'] as const

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body, phase: 'final-answer' } },
  { type: 'usage', usage: { inputTokens: 200, outputTokens: 60 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const calls = (batch: readonly { id: string; name: string; args: unknown }[]): StreamChunk[] => [
  ...batch.map((entry, index): StreamChunk => ({
    type: 'block-end', index,
    block: {
      type: 'tool-call', id: ToolCallId(entry.id), name: entry.name,
      arguments: JSON.stringify(entry.args),
    },
  })),
  { type: 'usage', usage: { inputTokens: 200, outputTokens: 40 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

const isLead = (request: GenerateOptions): boolean =>
  (request.tools ?? []).some(tool => tool.name === 'spawn_agent')

/** Deterministic per-iteration jitter, so a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed * 2_654_435_761 % 2_147_483_647
  return () => {
    state = state * 48_271 % 2_147_483_647
    return state / 2_147_483_647
  }
}

interface Node { readonly kind: string; readonly member?: string; readonly text?: string }

/**
 * One full research run: the lead delegates, the sectors report, it answers.
 * @param seed - Chooses the delays and which sector, if any, fails.
 * @returns The transcript the conversation was left with.
 */
async function research(seed: number): Promise<readonly Node[]> {
  const next = random(seed)
  const delays = new Map<string, number>(
    SECTORS.map(sector => [sector as string, Math.floor(next() * 80)]),
  )
  // Every third run, one sector dies on a bad source.
  const failing = seed % 3 === 0 ? SECTORS[Math.floor(next() * SECTORS.length)] : undefined
  const id = `c_soak_${String(seed)}`
  await ensureConversation(id, {
    mode: 'team-dynamic', workspaceRoot: join(home, 'sandbox'), groupId: 'default',
  })
  await updateConversation(id, {
    provider: 'mock', model: 'mock-scripted', mode: 'team-dynamic',
  })

  let leadRound = 0
  let closed = false
  let submitted = false
  const workerSubmitted = new Set<string>()
  setMockScript((request) => {
    if (isLead(request)) {
      leadRound++
      if (leadRound === 1) {
        return calls(SECTORS.map((sector, index) => ({
          id: `spawn-${String(index)}`,
          name: 'spawn_agent',
          args: { name: sector, task: `research ${sector} for Sep–Oct 2026`, context: 'fresh' },
        })))
      }
      const body = JSON.stringify(request.messages)
      const seen = SECTORS.filter(sector => body.includes(`${sector} reports`))
      const done = failing === undefined ? SECTORS.length : SECTORS.length - 1
      if (seen.length < done) return text(`still gathering (${String(seen.length)})`)
      // Everything that was going to report has. Close the slots, then submit
      // the self-check the deep loop requires, then answer.
      if (!closed) {
        closed = true
        return calls(SECTORS.map((sector, index) => ({
          id: `close-${String(index)}`, name: 'close_agent', args: { name: sector },
        })))
      }
      if (!submitted) {
        submitted = true
        return calls([{
          id: 'lead-submit', name: 'submit_result',
          args: { summary: 'Synthesised every sector.', evidence: seen.map(s => `${s} reported`) },
        }])
      }
      return text(`SYNTHESIS: ${seen.join(', ')}`)
    }

    const body = JSON.stringify(request.messages)
    const sector = SECTORS.find(name => body.includes(name)) ?? '?'
    if (sector === failing) throw new Error(`${sector} source is unreachable`)
    // A worker runs in deep mode, so it submits its self-check and then
    // answers, exactly as a real one does.
    if (!workerSubmitted.has(String(sector))) {
      workerSubmitted.add(String(sector))
      return [
        { type: 'hang', signal: request.signal, ms: delays.get(sector) ?? 10 } as unknown as StreamChunk,
        ...calls([{
          id: `${sector}-submit`, name: 'submit_result',
          args: { summary: `${sector} researched.`, evidence: [`${sector} sources read`] },
        }]),
      ]
    }
    return text(`${sector} reports: two names worth holding`)
  })

  for await (const _wire of runPrompt(id, PROMPT, 'default')) { /* the client's stream */ }
  await forgetSession(id)
  return await readMessages(id) as readonly Node[]
}

describe('the research prompt, run over and over', () => {
  it.each(Array.from({ length: 60 }, (_, index) => index + 1))('ends on the lead with timing seed %i', async (seed) => {
    const failures: string[] = []
      const nodes = await research(seed)
      resetMock()

      const said = nodes.filter(node => node.kind === 'text')
      const last = said.at(-1)
      // The whole point of delegating: the lead owns the ending.
      if (last?.member !== undefined) {
        failures.push(`seed ${String(seed)}: last word came from '${last.member}'`)
      }
      if (!(last?.text ?? '').includes('SYNTHESIS')) {
        failures.push(`seed ${String(seed)}: no synthesis, last text was ${JSON.stringify(last?.text)}`)
      }
      // A worker dying is expected on some seeds; the RUN failing is not.
      const errors = nodes.filter(node => node.kind === 'error')
      if (errors.length > 0) {
        failures.push(`seed ${String(seed)}: ${String(errors.length)} error node(s)`)
      }
      // Nobody says the same thing over and over. A model that repeats itself
      // is a model burning the user's budget, and a transcript with the same
      // answer eighteen times is unreadable.
      const counts = new Map<string, number>()
      for (const node of said) {
        const key = `${node.member ?? 'lead'}:${node.text ?? ''}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      for (const [key, times] of counts) {
        if (times > 2) failures.push(`seed ${String(seed)}: "${key.slice(0, 50)}" repeated ${String(times)}x`)
      }
      // Every sector that could report did, exactly once.
      for (const sector of SECTORS) {
        const reports = said.filter(node => node.member === sector)
        if (reports.length > 1) {
          failures.push(`seed ${String(seed)}: ${sector} spoke ${String(reports.length)} times`)
        }
      }
      // The user asked once.
      const asked = nodes.filter(node => node.kind === 'user' && (node.text ?? '').includes('Tổng hợp'))
      if (asked.length !== 1) {
        failures.push(`seed ${String(seed)}: prompt appears ${String(asked.length)} times`)
      }
    expect(failures).toEqual([])
  }, 180_000)
})
