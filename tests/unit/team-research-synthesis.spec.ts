import { describe, expect, it } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@ai-agent-sdk/core/agent'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@ai-agent-sdk/core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@ai-agent-sdk/core'

/**
 * The reported run, reduced to its mechanism.
 *
 * "Summarize the stocks worth holding in September–October, use several agents
 * to research the sectors in parallel." The lead split the work by sector,
 * answered while the researchers were still going, and the conversation ended
 * on a worker's own self-check with nothing synthesizing it. Everything here is
 * about WHO SPEAKS LAST: a delegated run is only finished when the lead has
 * read what came back.
 */

const SECTORS = ['macro_banks', 'tech_industrial', 'realestate_infra', 'consumer_retail'] as const

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const calls = (batch: readonly { id: string; name: string; args: unknown }[]): StreamChunk[] => [
  ...batch.map((call, index): StreamChunk => ({
    type: 'block-end', index,
    block: {
      type: 'tool-call', id: ToolCallId(call.id), name: call.name,
      arguments: JSON.stringify(call.args),
    },
  })),
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

abstract class StubAdapter extends ModelAdapter {
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

const isLead = (options: GenerateOptions): boolean =>
  (options.tools ?? []).some(tool => tool.name === 'spawn_agent')

/** What the whole conversation said, in order, and who said it. */
interface Transcript {
  readonly turns: { readonly who: string; readonly text: string }[]
}

/**
 * A lead that delegates by sector and a set of researchers that outlive it.
 *
 * The researchers are held until the test releases them, which is the timing
 * the failure needs: the lead has to run out of things to do while they are
 * still working.
 */
class SectorResearch extends StubAdapter {
  readonly transcript: Transcript = { turns: [] }
  readonly leadRequests: GenerateOptions[] = []
  private leadTurn = 0
  private release: (() => void) | undefined
  private readonly held = new Promise<void>((resolve) => { this.release = resolve })
  private started = 0
  private announce: (() => void) | undefined
  readonly allStarted = new Promise<void>((resolve) => { this.announce = resolve })
  /** Set by a worker that produced output after it was supposed to be stopped. */
  spokeAfterClose = false
  closed = false
  /** Sector runs that were asked a follow-up question and are still on it. */
  private followUpAnnounce: (() => void) | undefined
  readonly followUpStarted = new Promise<void>((resolve) => { this.followUpAnnounce = resolve })
  private readonly rounds = new Map<string, number>()

  releaseWorkers(): void { this.release?.() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (isLead(options)) {
      this.leadRequests.push(options)
      this.leadTurn++
      if (this.leadTurn === 1) {
        yield* calls(SECTORS.map((sector, index) => ({
          id: `spawn-${String(index)}`,
          name: 'spawn_agent',
          args: { name: sector, task: `research ${sector} for Sep–Oct`, context: 'fresh' },
        })))
        return
      }
      // Every later turn answers. Before the reports arrive it can only be a
      // holding answer; after them it is the synthesis.
      const seen = SECTORS.filter(sector => JSON.stringify(options.messages).includes(`${sector} says`))
      const body = seen.length === SECTORS.length
        ? `synthesis of ${seen.join(', ')}`
        : `still waiting (${String(seen.length)}/${String(SECTORS.length)})`
      this.transcript.turns.push({ who: 'lead', text: body })
      yield* text(body)
      return
    }

    const sector = SECTORS.find(name => JSON.stringify(options.messages).includes(name)) ?? 'unknown'
    const round = (this.rounds.get(sector) ?? 0) + 1
    this.rounds.set(sector, round)
    if (round === 1) {
      this.started++
      if (this.started === SECTORS.length) this.announce?.()
    } else {
      // A follow-up the lead sent after the first report: this run belongs to
      // the TEAM's scheduler, not to the harness that spawned the worker.
      this.followUpAnnounce?.()
    }
    await new Promise<void>((resolve) => {
      if (round === 1) void this.held.then(resolve)
      options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      // A follow-up round ends on cancellation, or shortly after on its own —
      // long enough that a close which failed to stop it is plainly visible.
      if (round > 1) setTimeout(resolve, 200)
    })
    options.signal?.throwIfAborted()
    if (this.closed) this.spokeAfterClose = true
    const body = round === 1
      ? `${sector} says: three names worth holding`
      : `${sector} follow-up nobody is listening to`
    this.transcript.turns.push({ who: sector, text: body })
    yield* text(body)
  }
}

function research(adapter: ModelAdapter, onAgentEvent?: (member: string, event: AgentRunEvent) => void) {
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return createManagedAgentTeam({
    registry,
    // Tests are not paced by a production-sized wait for worker news.
    holdWaitMs: 20,
    lead: defineAgent({
      id: 'lead', provider: 'test', model: 'scripted',
      instructions: 'You lead a research team.', mode: 'basic', maxTurns: 4,
    }),
    leadName: 'lead',
    maxWorkers: 6,
    team: { id: 'research', ...onAgentEvent === undefined ? {} : { onAgentEvent } },
  })
}

/** Wait for a condition the team reaches on its own schedule. */
async function until(condition: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('a delegated research run ends on the lead', () => {
  it('synthesizes after every sector reports, even though the lead answered first', async () => {
    const adapter = new SectorResearch()
    const managed = research(adapter)

    const first = await managed.run('Which stocks look good for Sep–Oct? Split it by sector.')
    // The lead ran out of turns while its researchers were still working. This
    // is the moment the conversation used to be abandoned.
    expect(first.text).toContain('still waiting')
    expect(managed.lead.isRunning).toBe(false)
    expect(adapter.transcript.turns.at(-1)?.who).toBe('lead')

    await adapter.allStarted
    adapter.releaseWorkers()
    for (const sector of SECTORS) await managed.awaitWorker(sector)

    // Each report wakes the lead; the last one gives it everything.
    await until(() => adapter.transcript.turns.some(turn => turn.text.startsWith('synthesis of')))

    const last = adapter.transcript.turns.at(-1)
    expect(last?.who).toBe('lead')
    expect(last?.text).toBe(`synthesis of ${SECTORS.join(', ')}`)
    // Every sector's answer is in front of the lead when it writes that.
    const finalRequest = JSON.stringify(adapter.leadRequests.at(-1))
    for (const sector of SECTORS) expect(finalRequest).toContain(`${sector} says`)

    await managed.dispose()
  }, 30_000)

  it('never leaves a worker speaking after the lead has closed it', async () => {
    const adapter = new SectorResearch()
    const managed = research(adapter)
    await managed.run('Which stocks look good for Sep–Oct? Split it by sector.')
    await adapter.allStarted

    // What the lead does when it decides it has enough and wants its slots back.
    adapter.closed = true
    await Promise.all(SECTORS.map(sector => managed.closeWorker(sector)))
    adapter.releaseWorkers()
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(adapter.spokeAfterClose).toBe(false)
    expect(managed.workers()).toEqual([])
    // A close is not a failure, so the lead is neither told one happened nor
    // woken to discuss it.
    const reports = managed.team.messages()
      .filter(message => JSON.stringify(message.content).includes('failed'))
    expect(reports).toEqual([])
    expect(adapter.transcript.turns.at(-1)?.who).toBe('lead')

    await managed.dispose()
  }, 30_000)

  it('stops a sector the lead had asked a follow-up question', async () => {
    // Straight from the trace: the lead used followup_task, so that run belongs
    // to the team's scheduler. `close_agent` aborted only the run the harness
    // had started, and the worker carried on for another fourteen seconds and
    // submitted after the lead had answered.
    const adapter = new SectorResearch()
    const managed = research(adapter)
    await managed.run('Which stocks look good for Sep–Oct? Split it by sector.')
    await adapter.allStarted
    adapter.releaseWorkers()
    await managed.awaitWorker('consumer_retail')

    const followUp = managed.team.sendMessage({
      from: 'lead', target: 'consumer_retail',
      message: 'one more thing: check the retail margins', delivery: 'wakeup',
    })
    await adapter.followUpStarted

    adapter.closed = true
    await managed.closeWorker('consumer_retail')
    await followUp
    // Past the point where the uncancelled follow-up would have spoken.
    await new Promise(resolve => setTimeout(resolve, 600))

    expect(adapter.spokeAfterClose).toBe(false)
    expect(adapter.transcript.turns.some(turn => turn.text.includes('nobody is listening'))).toBe(false)
    await managed.dispose()
  }, 30_000)

  it('reports every sector to the lead exactly once', async () => {
    // Two sources report the same completion — the report itself and the turn
    // the lead is woken for — and a duplicate would have the lead synthesize
    // twice over the same material.
    const adapter = new SectorResearch()
    const seen: string[] = []
    const managed = research(adapter, (member, event) => {
      if (event.type === 'turn-end') seen.push(member)
    })
    await managed.run('Which stocks look good for Sep–Oct? Split it by sector.')
    await adapter.allStarted
    adapter.releaseWorkers()
    for (const sector of SECTORS) await managed.awaitWorker(sector)
    await until(() => adapter.transcript.turns.some(turn => turn.text.startsWith('synthesis of')))

    for (const sector of SECTORS) {
      expect(managed.team.messages().filter(message =>
        JSON.stringify(message.content).includes(`Worker '${sector}' finished`))).toHaveLength(1)
    }
    await managed.dispose()
  }, 30_000)
})
