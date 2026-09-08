import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@ai-agent-sdk/core/agent'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@ai-agent-sdk/core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@ai-agent-sdk/core'

const home = mkdtempSync(join(tmpdir(), 'team-synthesis-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')

const { createDoorbell, followWorkers } =
  await import('../../samples/chat-agents/backend/src/session.ts')
const { addToTally, recordUsage, turnShortfall, usageOf, usageSummary } =
  await import('../../samples/chat-agents/backend/src/usage.ts')
const { EventProjector } = await import('../../samples/chat-agents/backend/src/event-projection.ts')

/**
 * The app's own path, not the harness API.
 *
 * The difference matters: the app drives the lead with `stream()` and then
 * hands the rest of the conversation to `followWorkers`, which decides how long
 * anyone is still listening. A managed-team test that calls `run()` proves the
 * lead is woken; it cannot prove the app was still there to hear it.
 */

const LEAD = 'lead'
const SECTORS = ['macro_banks', 'tech_industrial', 'realestate_infra', 'consumer_retail'] as const

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body, phase: 'final-answer' } },
  // A provider that reports its counters, which is what the usage page counts.
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 } },
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
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

class SectorResearch extends ModelAdapter {
  /** Lead turn on which the researchers are released, if the test wants that. */
  constructor(private readonly releaseOnTurn?: number) { super() }
  leadTurn = 0
  private release: (() => void) | undefined
  private readonly held = new Promise<void>((resolve) => { this.release = resolve })
  private started = 0
  private announce: (() => void) | undefined
  readonly allStarted = new Promise<void>((resolve) => { this.announce = resolve })

  /** Set when a lead round saw the user's mid-run correction. */
  sawSteer = false
  /** Sector whose research blows up, as a slow site or a bad page would. */
  failing: string | undefined
  /** Researchers that never come back, as a hung fetch would. */
  hangForever = false

  releaseWorkers(): void { this.release?.() }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lead = (options.tools ?? []).some(tool => tool.name === 'spawn_agent')
    if (lead) {
      this.leadTurn++
      if (this.leadTurn === 1) {
        yield* calls(SECTORS.map((sector, index) => ({
          id: `spawn-${String(index)}`,
          name: 'spawn_agent',
          args: { name: sector, task: `research ${sector}`, context: 'fresh' },
        })))
        return
      }
      if (this.leadTurn === this.releaseOnTurn) {
        // The reports land while this very round is being produced.
        this.release?.()
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (JSON.stringify(options.messages).includes('Only large caps')) this.sawSteer = true
      const seen = SECTORS.filter(sector => JSON.stringify(options.messages).includes(`${sector} says`))
      yield* text(seen.length === SECTORS.length
        ? 'SYNTHESIS: three names worth holding'
        : `holding answer (${String(seen.length)} in)`)
      return
    }
    const sector = SECTORS.find(name => JSON.stringify(options.messages).includes(name)) ?? '?'
    this.started++
    if (this.started === SECTORS.length) this.announce?.()
    // A source that will not load, which is how a research worker actually dies.
    if (sector === this.failing) throw new Error(`${sector} source is unreachable`)
    if (this.hangForever) {
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      options.signal?.throwIfAborted()
    }
    await this.held
    options.signal?.throwIfAborted()
    yield* text(`${sector} says: two names`)
  }
}

interface Persisted { readonly kind: string; readonly member?: string; readonly text?: string }
interface Wire { readonly t: string; readonly text?: string; readonly member?: string }

/** Drive one prompt the way `runPrompt` does, and report what was persisted. */
interface ConversationOptions {
  /** Let the researchers finish DURING the lead's final round. */
  readonly releaseOnLastLeadTurn?: boolean
  readonly leadTurns?: number
  /**
   * How long the lead's turn is held open waiting for news.
   *
   * Short by default so a test is not paced by a production-sized wait; the
   * spin test raises it, because that is the behaviour it measures.
   */
  readonly holdWaitMs?: number
  /** Deadline for a worker's own run. */
  readonly workerTimeoutMs?: number
  /** Researchers that never finish, however long the test waits. */
  readonly hangForever?: boolean
}

async function conversation(options: ConversationOptions = {}): Promise<{
  readonly adapter: SectorResearch
  readonly persisted: Persisted[]
  readonly wires: Wire[]
  readonly run: () => Promise<void>
  readonly dispose: () => Promise<void>
  readonly drainStarted: Promise<void>
  readonly detach: () => void
  readonly takeOver: () => void
  readonly abort: () => void
  readonly steer: (message: string) => void
  readonly reports: () => readonly string[]
  readonly settled: () => Promise<void>
  readonly group: string
}> {
  const adapter = new SectorResearch(options.releaseOnLastLeadTurn === true ? 2 : undefined)
  if (options.hangForever === true) adapter.hangForever = true
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const persisted: Persisted[] = []
  /** What the browser actually receives, in order. */
  const wires: Wire[] = []
  const queued: unknown[] = []
  const project = new EventProjector()
  const wake = createDoorbell()
  const controller = new AbortController()
  let announceDrain: (() => void) | undefined
  const drainStarted = new Promise<void>((resolve) => { announceDrain = resolve })
  let detached = false
  const closing = new EventProjector()
  // The three lines runPrompt runs for every event, against real events rather
  // than hand-written ones.
  const tally = new Map<string, Record<string, number>>() as never
  const group = `g-${String(Math.random()).slice(2)}`
  const record = async (member: string | undefined, event: AgentRunEvent): Promise<void> => {
    const context = {
      conversationId: 'c1', groupId: group, runId: 'r1',
      provider: 'test', model: 'scripted', effort: 'max',
      ...member === undefined ? {} : { member },
    }
    const streamed = usageOf(event)
    if (streamed !== undefined) {
      addToTally(tally, member, streamed)
      await recordUsage(streamed, context)
    }
    await recordUsage(turnShortfall(event, tally, member), context)
  }

  /** What the app installs: one sink for worker events and the lead's own. */
  const sink = (member: string, event: AgentRunEvent): void => {
    void record(member === LEAD ? undefined : member, event)
    if (detached) {
      // session.ts's teardown sink: one projector for the rest of the
      // conversation, and the lead still projected as the lead.
      if (member === LEAD) {
        for (const _wire of closing.forLead(event)) { /* nobody is listening */ }
      } else {
        void closing.forMember(member, event)
      }
      for (const node of closing.flush()) persisted.push(node as Persisted)
      return
    }
    if (member === LEAD) {
      for (const wire of project.forLead(event)) wires.push(wire as Wire)
    } else {
      for (const wire of project.forMember(member, event)) wires.push(wire as Wire)
    }
    for (const node of project.flush()) persisted.push(node as Persisted)
    wake.ring()
  }

  const managed = createManagedAgentTeam({
    registry,
    // The app routes worker events through its own sink AND the team's, which
    // is what makes a worker's run observable at all.
    onWorkerEvent: sink,
    lead: defineAgent({
      id: LEAD, provider: 'test', model: 'scripted',
      instructions: 'You lead a research team.', mode: 'basic',
      maxTurns: options.leadTurns ?? 3,
    }),
    leadName: LEAD,
    holdWaitMs: options.holdWaitMs ?? 50,
    ...options.workerTimeoutMs === undefined ? {} : { workerTimeoutMs: options.workerTimeoutMs },
    team: {
      id: 'research',
      onAgentEvent: sink,
    },
  })

  const live = { managed, abort: controller, outbox: [] as unknown[] }

  return {
    adapter,
    persisted,
    wires,
    drainStarted,
    detach() { detached = true },
    abort() { controller.abort(new Error('client disconnected')) },
    steer(message: string) { managed.steer(message) },
    reports: () => managed.team.messages().map(message => JSON.stringify(message.content)),
    takeOver() {
      // A newer run owns the conversation now; the old drain stops and the
      // teardown sink takes over, exactly as `runPrompt` arranges.
      live.abort = new AbortController()
      detached = true
    },
    group,
    async settled() {
      for (const sector of SECTORS) await managed.awaitWorker(sector).catch(() => undefined)
      await managed.team.whenIdle(LEAD)
    },
    async run() {
      for await (const event of managed.lead.stream('Which stocks look good? Split by sector.')) {
        await record(undefined, event)
        for (const wire of project.forLead(event)) wires.push(wire as Wire)
        for (const node of project.flush()) persisted.push(node as Persisted)
      }
      announceDrain?.()
      // `runPrompt` rings the doorbell every few seconds. The drain only
      // re-checks the roster on a ring, and the last ring of a woken turn
      // lands a moment before the roster actually goes idle — so without the
      // heartbeat the app would wait on a bell nobody is going to ring again.
      const heartbeat = setInterval(() => { wake.ring() }, 100)
      const drain = followWorkers(
        live as never, controller, wake, queued as never, project,
        async (node: unknown) => { persisted.push(node as Persisted) },
        // eslint-disable-next-line require-yield
        async function* () {} as never,
      )
      for await (const _wire of drain) { /* progress events */ }
      clearInterval(heartbeat)
      for (const node of project.flush()) persisted.push(node as Persisted)
      // What the app installs once nobody is listening any more: a detached
      // sink that only writes to the transcript.
      detached = true
    },
    async dispose() { await managed.dispose() },
  }
}

/** Wait for something the team reaches on its own schedule. */
async function until(condition: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('the app keeps listening until the lead has synthesized', () => {
  it('persists the lead synthesis as the last thing in the conversation', async () => {
    const chat = await conversation()
    // Release the researchers only once the lead's own stream has ended, which
    // is the timing the reported failure needs.
    const running = chat.run()
    await chat.adapter.allStarted
    // The real timing: the lead's stream has already ended and the app is in
    // its drain when the researchers come back.
    await chat.drainStarted
    chat.adapter.releaseWorkers()
    await running

    const said = chat.persisted.filter(node => node.kind === 'text')
    const last = said.at(-1)
    expect(last?.text).toContain('SYNTHESIS')
    // And it is the LEAD saying it: a synthesis attributed to a subagent is the
    // bug wearing the right words.
    expect(last?.member).toBeUndefined()
    await chat.dispose()
  }, 30_000)

  it('synthesizes when the report landed during the last round of its turn', async () => {
    // The other half of the gap. While the lead is running, a report is
    // delivered QUIETLY, on the assumption its next model round reads it. If
    // that turn then ends with no round left — a spent step budget, an error —
    // the report sits in history with nothing to read it, and the run ends with
    // the synthesis unwritten.
    const chat = await conversation({ releaseOnLastLeadTurn: true, leadTurns: 2 })
    const running = chat.run()
    await running
    await chat.settled()

    const said = chat.persisted.filter(node => node.kind === 'text')
    const synthesis = said.find(node => (node.text ?? '').includes('SYNTHESIS'))
    expect(synthesis).toBeDefined()
    expect(synthesis?.member).toBeUndefined()
    await chat.dispose()
  }, 30_000)

  it('keeps the earlier prompt\'s workers alive when a new prompt takes over', async () => {
    // The harness lives for the whole conversation, so a worker outlives the
    // run that spawned it. A second prompt must neither strand it nor crash on
    // it, and whatever it says still belongs in the transcript.
    const chat = await conversation()
    const running = chat.run()
    await chat.adapter.allStarted
    await chat.drainStarted
    // What `openConversation`/a new POST does: the run's abort owner changes,
    // and `followWorkers` stands down for the run that replaced it.
    chat.takeOver()
    await running

    chat.adapter.releaseWorkers()
    await chat.settled()
    await new Promise(resolve => setTimeout(resolve, 50))

    const said = chat.persisted.filter(node => node.kind === 'text')
    for (const sector of SECTORS) {
      expect(said.some(node => (node.text ?? '').includes(`${sector} says`))).toBe(true)
    }
    // Still synthesized, and still attributed to the lead.
    const synthesis = said.find(node => (node.text ?? '').includes('SYNTHESIS'))
    expect(synthesis?.member).toBeUndefined()
    await chat.dispose()
  }, 30_000)

  it('wakes the lead once per report, not in a loop', async () => {
    // Every wake costs a model call. A report that re-arms the debt it just
    // paid would have the lead answering forever over the same material.
    const chat = await conversation()
    const running = chat.run()
    await chat.adapter.allStarted
    await chat.drainStarted
    const beforeReports = chat.adapter.leadTurn
    chat.adapter.releaseWorkers()
    await running
    await chat.settled()
    await new Promise(resolve => setTimeout(resolve, 100))

    // One turn per sector at the very most, and in practice fewer because a
    // turn reads every report that has landed by the time it runs.
    expect(chat.adapter.leadTurn - beforeReports).toBeLessThanOrEqual(SECTORS.length)
    expect(chat.adapter.leadTurn - beforeReports).toBeGreaterThanOrEqual(1)
    await chat.dispose()
  }, 30_000)

  it('stops following when the client disconnects', async () => {
    // The stream cannot outlive its listener: a browser that goes away must not
    // leave the run waiting on workers nobody is watching.
    const chat = await conversation()
    const running = chat.run()
    await chat.adapter.allStarted
    await chat.drainStarted
    chat.abort()

    // Returns rather than waiting for researchers that are still held.
    await running
    chat.adapter.releaseWorkers()
    await chat.dispose()
  }, 30_000)

  it('reads a message typed while the lead waits on its workers', async () => {
    // The user watches the researchers work and adds a constraint. The lead has
    // already answered, so an injected message schedules nothing: without a
    // wake it sits in history and the correction is never answered.
    const chat = await conversation()
    const running = chat.run()
    await chat.adapter.allStarted
    await chat.drainStarted
    const before = chat.adapter.leadTurn

    chat.steer('Only large caps, please.')
    await until(() => chat.adapter.leadTurn > before)
    expect(chat.adapter.sawSteer).toBe(true)

    chat.adapter.releaseWorkers()
    await running
    await chat.dispose()
  }, 30_000)

  it('does not spin the lead while its workers are still working', async () => {
    // Measured on the reported run: the lead answered "still waiting" over and
    // over while the researchers worked, one model call each time, until its
    // budget was gone. Codex's parent blocks inside its wait tool instead of
    // re-asking; the DeepSeek harness starts a new round only when the agent is
    // idle AND there is something to do.
    const chat = await conversation({ leadTurns: 12, holdWaitMs: 1_000 })
    const running = chat.run()
    await chat.adapter.allStarted
    // Long enough that a spinning lead would burn most of its budget.
    await new Promise(resolve => setTimeout(resolve, 500))
    const spun = chat.adapter.leadTurn

    chat.adapter.releaseWorkers()
    await running
    await chat.settled()

    // One spawn round, and at most one holding answer: nothing is learned by
    // asking the model again before a worker has reported.
    expect(spun).toBeLessThanOrEqual(2)
    await chat.dispose()
  }, 30_000)

  it('tells the lead when a sector fails and still gets an answer', async () => {
    // A research worker dies on a bad source. The lead has to hear about it —
    // silence would have it either wait forever or answer as if the sector had
    // reported.
    const chat = await conversation()
    chat.adapter.failing = 'realestate_infra'
    const running = chat.run()
    await new Promise(resolve => setTimeout(resolve, 50))
    chat.adapter.releaseWorkers()
    await running
    await chat.settled()

    const reports = chat.reports()
    expect(reports.some(message => message.includes("Worker 'realestate_infra' failed"))).toBe(true)
    // The other three still reported, and the lead still owns the ending.
    const said = chat.persisted.filter(node => node.kind === 'text')
    expect(said.at(-1)?.member).toBeUndefined()
    await chat.dispose()
  }, 30_000)

  it('does not hang on a worker that never comes back', async () => {
    // A fetch that never resolves. The worker's own deadline has to end it, the
    // lead has to be told, and the stream has to close — a run whose liveness
    // is the slowest source is not a run anyone can use.
    const chat = await conversation({ hangForever: true, workerTimeoutMs: 300 })
    const running = chat.run()
    await chat.adapter.allStarted
    await running
    await chat.settled()

    const reports = chat.reports().filter(message => message.includes("Worker '"))
    expect(reports).toHaveLength(SECTORS.length)
    expect(reports.every(message => message.includes('failed'))).toBe(true)
    // Named, not "The operation was aborted due to timeout": the lead has to be
    // able to tell a deadline from a crash to decide what to do next.
    expect(reports.every(message => message.includes('deadline without finishing'))).toBe(true)
    // And the lead still owns the ending rather than the run trailing off.
    const said = chat.persisted.filter(node => node.kind === 'text')
    expect(said.at(-1)?.member).toBeUndefined()
    await chat.dispose()
  }, 30_000)

  it('counts what the lead and every worker spent', async () => {
    // A team run spends most of its tokens inside workers. Counting only the
    // lead's own calls would show a fraction of the bill.
    const chat = await conversation()
    const running = chat.run()
    await chat.adapter.allStarted
    await chat.drainStarted
    chat.adapter.releaseWorkers()
    await running
    await chat.settled()
    await new Promise(resolve => setTimeout(resolve, 50))

    const summary = await usageSummary(chat.group)
    expect(summary.totals.inputTokens).toBeGreaterThan(0)
    expect(summary.totals.outputTokens).toBeGreaterThan(0)
    expect(summary.totals.cacheReadTokens).toBeGreaterThan(0)
    // Every model call in the run, lead and workers alike: one spawn round,
    // one holding answer, one per sector, and the synthesis.
    expect(summary.totals.calls).toBeGreaterThanOrEqual(SECTORS.length + 2)
    await chat.dispose()
  }, 30_000)

  it('files a late synthesis under the lead, not under a subagent', async () => {
    // Whatever arrives after the stream has closed still has to be written
    // correctly. Attributing the lead's own woken turn to a member is what put
    // a finished report inside a worker's panel and made the run read as
    // abandoned.
    const chat = await conversation()
    const running = chat.run()
    await chat.adapter.allStarted
    await chat.drainStarted
    // Nobody is listening any more: the client disconnected, or the next prompt
    // took the conversation over.
    chat.detach()
    chat.adapter.releaseWorkers()
    await running
    await chat.settled()

    const said = chat.persisted.filter(node => node.kind === 'text')
    const synthesis = said.find(node => (node.text ?? '').includes('SYNTHESIS'))
    expect(synthesis).toBeDefined()
    expect(synthesis?.member).toBeUndefined()
    await chat.dispose()
  }, 30_000)
})
