import { describe, expect, it } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@ai-agent-sdk/core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@ai-agent-sdk/core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@ai-agent-sdk/core'

const toolCall = (id: string, name: string, args: unknown): StreamChunk[] => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A DefinedAgent always sends an effort, so a stub has to declare one. */
abstract class StubAdapter extends ModelAdapter {
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

const isLead = (options: GenerateOptions): boolean =>
  (options.tools ?? []).some(tool => tool.name === 'spawn_agent')

function teamOf(adapter: ModelAdapter, options: { maxWorkers?: number } = {}) {
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return createManagedAgentTeam({
    registry,
    lead: defineAgent({
      id: 'lead',
      provider: 'test',
      model: 'scripted',
      instructions: 'You lead a team.',
      mode: 'basic',
      maxTurns: 6,
    }),
    leadName: 'lead',
    ...options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers },
  })
}

/** Holds a worker's model call open until the test releases it. */
class HeldWorker extends StubAdapter {
  private announce: (() => void) | undefined
  readonly workerRunning = new Promise<void>((resolve) => { this.announce = resolve })
  release: (() => void) | undefined
  private readonly held = new Promise<void>((resolve) => { this.release = resolve })
  readonly leadRequests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (isLead(options)) {
      this.leadRequests.push(options)
      yield* text('lead done')
      return
    }
    this.announce?.()
    // Honours cancellation, as a real adapter does: without that a "close"
    // could only ever be proved against a worker that had already finished.
    await new Promise<void>((resolve) => {
      void this.held.then(resolve)
      options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    options.signal?.throwIfAborted()
    yield* text('worker answer')
  }
}

describe('spawn_agent no longer waits', () => {
  it('returns while the worker is still running', async () => {
    const adapter = new HeldWorker()
    const managed = teamOf(adapter)

    // The proof: this resolves while the worker's model call is still open.
    // Awaiting the worker here is what blinded the lead — parked in its own
    // tool call it could not read the worker's messages or spawn anything else.
    const worker = await managed.spawn({ name: 'w', task: 'do it' })
    expect(worker).toMatchObject({ name: 'w', status: 'running' })
    expect(managed.workers()[0]?.status).toBe('running')

    adapter.release?.()
    await managed.awaitWorker('w')
    expect(managed.workers()[0]).toMatchObject({
      status: 'completed',
      result: { text: 'worker answer', succeeded: true },
    })
    await managed.dispose()
  }, 20_000)

  it('tells the lead what the worker concluded', async () => {
    const adapter = new HeldWorker()
    const managed = teamOf(adapter)
    await managed.spawn({ name: 'w', task: 'do it' })
    adapter.release?.()
    await managed.awaitWorker('w')

    // The completion notification replaces the result the tool used to return:
    // it lands in the lead's history, so the lead's next model round reads it.
    const leadRun = await managed.lead.run('what happened?', {})
    expect(leadRun.outcome.reason.kind).toBe('completed')
    const seen = JSON.stringify(adapter.leadRequests.at(-1))
    expect(seen).toContain('worker answer')
    expect(seen).toContain('finished')
    await managed.dispose()
  }, 20_000)

  it('records the answer on the roster, not only on the harness', async () => {
    const adapter = new HeldWorker()
    const managed = teamOf(adapter)
    await managed.spawn({ name: 'w', task: 'do it' })
    adapter.release?.()
    await managed.awaitWorker('w')
    // `list_agents` is how the lead reads a finished worker's answer.
    const member = managed.team.members().find(entry => entry.name === 'w')
    expect(member?.outcome).toEqual({ kind: 'completed', text: 'worker answer' })
    await managed.dispose()
  }, 20_000)
})

describe('the lead owns the ending', () => {
  /** A lead that tries to conclude the moment it has spawned. */
  class EagerLead extends StubAdapter {
    leadRounds = 0
    private release: (() => void) | undefined
    private readonly held = new Promise<void>((resolve) => { this.release = resolve })

    finishWorker() { this.release?.() }

    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (isLead(options)) {
        this.leadRounds++
        yield* this.leadRounds === 1
          ? toolCall('l1', 'spawn_agent', { name: 'w', task: 'do it' })
          : text('lead answer')
        return
      }
      await this.held
      yield* text('worker answer')
    }
  }

  it('will not let the lead conclude while a worker is unfinished', async () => {
    const adapter = new EagerLead()
    const managed = teamOf(adapter)
    const run = managed.lead.run('delegate and answer', {})

    // Round one spawns, round two tries to answer. A lead left to itself would
    // stop there — so a THIRD round is the signal that the turn was sent back:
    // concluding at two would answer from nothing, and once the turn is over
    // the worker's report has no turn left to be read in.
    const deadline = Date.now() + 5_000
    while (adapter.leadRounds < 3 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    expect(adapter.leadRounds).toBeGreaterThan(2)
    expect(managed.workers()[0]?.status).toBe('running')

    adapter.finishWorker()
    const response = await run
    // Once nothing is outstanding the turn is free to end — the guard must not
    // turn "wait for your workers" into "never finish".
    expect(response.outcome.reason.kind).toBe('completed')
    expect(response.text).toBe('lead answer')
    expect(await managed.awaitWorker('w')).toMatchObject({ text: 'worker answer' })
    await managed.dispose()
  }, 20_000)

  it('lets an exhausted turn end even with a worker running', async () => {
    const adapter = new HeldWorker()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const managed = createManagedAgentTeam({
      registry,
      lead: defineAgent({
        id: 'lead',
        provider: 'test',
        model: 'scripted',
        instructions: 'You lead a team.',
        mode: 'basic',
        // One turn only: the guard must not turn a spent budget into a hang.
        maxTurns: 1,
      }),
      leadName: 'lead',
    })
    await managed.spawn({ name: 'w', task: 'do it' })
    await adapter.workerRunning
    const response = await managed.lead.run('answer now', {})
    expect(response.outcome.reason.kind).not.toBe('aborted')
    adapter.release?.()
    await managed.dispose()
  }, 20_000)
})

describe('a detached worker still reports', () => {
  it('delivers its events to onWorkerEvent', async () => {
    const adapter = new HeldWorker()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const seen: { worker: string; type: string }[] = []
    const managed = createManagedAgentTeam({
      registry,
      lead: defineAgent({
        id: 'lead',
        provider: 'test',
        model: 'scripted',
        instructions: 'You lead a team.',
        mode: 'basic',
        maxTurns: 4,
      }),
      leadName: 'lead',
      onWorkerEvent: (worker, event) => { seen.push({ worker, type: event.type }) },
    })

    await managed.spawn({ name: 'w', task: 'do it' })
    adapter.release?.()
    await managed.awaitWorker('w')

    // Starting a run is not the same as reporting one. A handle nobody consumes
    // runs the worker and delivers NOTHING: no rows for the host to render, and
    // — worse — no approval requests, so a worker that asks permission waits
    // for an answer nobody was ever shown.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(entry => entry.worker === 'w')).toBe(true)
    expect(seen.map(entry => entry.type)).toContain('agent-start')
    expect(seen.map(entry => entry.type)).toContain('agent-end')
    await managed.dispose()
  }, 20_000)
})

describe('awaitWorker is bounded', () => {
  it('gives up and reports instead of waiting forever', async () => {
    const adapter = new HeldWorker()
    const managed = teamOf(adapter)
    await managed.spawn({ name: 'w', task: 'do it' })
    await adapter.workerRunning

    const started = Date.now()
    // Bounded on purpose: a caller that never regains control cannot tell a
    // slow worker from a stuck one.
    expect(await managed.awaitWorker('w', { timeoutMs: 300 })).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(managed.workers()[0]?.status).toBe('running')

    adapter.release?.()
    await managed.dispose()
  }, 20_000)
})

describe('close_agent is the stopping point', () => {
  it('stops a running worker and frees its slot', async () => {
    const adapter = new HeldWorker()
    const managed = teamOf(adapter, { maxWorkers: 1 })
    await managed.spawn({ name: 'w', task: 'do it' })
    await adapter.workerRunning

    // At the cap, so a second spawn is refused until the first is closed.
    await expect(managed.spawn({ name: 'x', task: 'other' })).rejects.toThrow(/1-worker limit/)

    expect(await managed.closeWorker('w')).toBe('running')
    expect(managed.workers()).toEqual([])
    expect(managed.team.members().some(entry => entry.name === 'w')).toBe(false)

    // The slot came back.
    adapter.release?.()
    const second = await managed.spawn({ name: 'x', task: 'other' })
    expect(second.status).toBe('running')
    await managed.dispose()
  }, 20_000)

  it('closes a finished worker that is still holding a slot', async () => {
    const adapter = new HeldWorker()
    const managed = teamOf(adapter, { maxWorkers: 1 })
    await managed.spawn({ name: 'w', task: 'do it' })
    adapter.release?.()
    await managed.awaitWorker('w')
    // Codex's rule, and the reason close_agent matters: finishing is not
    // leaving. A lead that never closes runs out of workers.
    expect(managed.workers()[0]?.status).toBe('completed')
    expect(await managed.closeWorker('w')).toBe('completed')
    expect(managed.workers()).toEqual([])
    await managed.dispose()
  }, 20_000)
})

describe('dispose ends detached work', () => {
  it('stops workers the lead left running', async () => {
    const adapter = new HeldWorker()
    const managed = teamOf(adapter)
    await managed.spawn({ name: 'w', task: 'do it' })
    await adapter.workerRunning

    // Workers outlive the lead's turn by design, so something has to end them:
    // otherwise a detached run keeps calling the model after the host moved on.
    await managed.dispose()
    expect(managed.workers()).toEqual([])
    adapter.release?.()
    await managed.team.dispose()
  }, 20_000)
})

describe('a worker still cannot coordinate', () => {
  class ToolProbe extends StubAdapter {
    readonly offered = new Map<string, readonly string[]>()
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const names = (options.tools ?? []).map(tool => tool.name)
      this.offered.set(isLead(options) ? 'lead' : 'worker', names)
      yield* isLead(options) && !this.offered.has('worker')
        ? toolCall('l1', 'spawn_agent', { name: 'w', task: 'do it' })
        : text('done')
    }
  }

  it('keeps the blocking verbs for the lead only', async () => {
    const adapter = new ToolProbe()
    const managed = teamOf(adapter)
    await managed.lead.run('delegate', {})
    await managed.awaitWorker('w')

    const lead = adapter.offered.get('lead') ?? []
    const worker = adapter.offered.get('worker') ?? []
    expect(lead).toContain('spawn_agent')
    expect(lead).toContain('close_agent')
    expect(lead).toContain('wait_agents')
    // A worker reports and finishes; the verbs that would remove its stopping
    // point stay with whoever is orchestrating.
    expect(worker).toContain('send_message')
    expect(worker).not.toContain('wait_agents')
    expect(worker).not.toContain('followup_task')
    expect(worker).not.toContain('spawn_agent')
    expect(worker).not.toContain('close_agent')
    await managed.dispose()
  }, 20_000)
})

describe('the budgets are the host set', () => {
  it('honours a spawn setup bound the host chose', async () => {
    const adapter = new HeldWorker()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const managed = createManagedAgentTeam({
      registry,
      lead: defineAgent({
        id: 'lead',
        provider: 'test',
        model: 'scripted',
        instructions: 'You lead a team.',
        mode: 'basic',
        maxTurns: 4,
      }),
      leadName: 'lead',
      // Every bound here is the host's to choose; a hard-coded one would be
      // wrong for somebody.
      spawnTimeoutMs: 5_000,
      closeTimeoutMs: 1_000,
      team: { waitTimeoutMs: 250 },
    })
    // Read, not ignored: an impossible value is refused rather than quietly
    // falling back to the built-in default.
    expect(() => createManagedAgentTeam({
      registry,
      lead: defineAgent({
        id: 'lead2',
        provider: 'test',
        model: 'scripted',
        instructions: 'You lead a team.',
        mode: 'basic',
      }),
      leadName: 'lead2',
      spawnTimeoutMs: -1,
    })).toThrow()

    await managed.spawn({ name: 'w', task: 'do it' })
    await adapter.workerRunning

    // The team's wait budget came from the same options object.
    const wait = managed.team.toolsFor('lead').find(tool => tool.name === 'wait_agents')
    const started = Date.now()
    const report = await wait?.execute(wait.parse?.({ targets: ['w'] }), {
      turn: 1,
      step: 1,
      callId: ToolCallId('wait-cfg'),
      toolName: 'wait_agents',
      signal: new AbortController().signal,
      concludeTurn() {},
      addContext() {},
    })
    expect(report).toMatchObject({ timedOut: true })
    expect(Date.now() - started).toBeLessThan(5_000)

    adapter.release?.()
    await managed.dispose()
  }, 20_000)
})
