import { describe, expect, it } from 'vitest'
import {
  AgentTeam,
  completedHistoryPrefix,
  createManagedAgentTeam,
  DEFAULT_MIN_WAIT_TIMEOUT_MS,
  defineAgent,
} from '@ai-agent-sdk/core/agent'
import type { HistorySnapshot } from '@ai-agent-sdk/core/agent'
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

const bodyOf = (options: GenerateOptions): string => JSON.stringify(options.messages ?? [])

function teamOf(
  adapter: ModelAdapter,
  options: { defaultSpawnContext?: 'fresh' | 'fork' } = {},
) {
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
    ...options.defaultSpawnContext === undefined
      ? {}
      : { defaultSpawnContext: options.defaultSpawnContext },
  })
}

describe('the delegation contract the lead is given', () => {
  /**
   * These assertions are about prose, and prose is what was missing: the lead
   * divided agents without dividing work because nothing had ever told it how.
   * Deleting a rule is a regression no mechanism test can see, which is the
   * whole reason the rules are asserted here.
   */
  class CaptureLead extends StubAdapter {
    readonly requests: GenerateOptions[] = []
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      yield* text('done')
    }
  }

  it('tells the lead to plan, keep the blocking step, and split write scopes', async () => {
    const adapter = new CaptureLead()
    await teamOf(adapter).run('build something')
    const prompt = JSON.stringify(adapter.requests[0])

    // Plan first: the trace spawned three workers before establishing that
    // there was anything to divide.
    expect(prompt).toContain('PLAN BEFORE YOU DELEGATE')
    // Keep the critical path local rather than delegating and waiting on it.
    expect(prompt).toContain('Do the blocking step yourself')
    // Two workers were given the same file to build.
    expect(prompt).toContain('DISJOINT SET OF FILES TO WRITE')
    // An auditor spawned over an empty workspace produced a checklist.
    expect(prompt).toMatch(/not delegate review, audit or verification against nothing/i)
    // Order is declared and enforced, not remembered.
    expect(prompt).toContain('EXPRESS ORDER WITH `dependsOn`, NOT BY SPAWNING LATE')
  })

  it('offers the lead a context choice on spawn_agent', async () => {
    const adapter = new CaptureLead()
    await teamOf(adapter).run('build something')
    const spawn = (adapter.requests[0]?.tools ?? [])
      .find(tool => tool.name === 'spawn_agent') as { parameters?: {
        properties?: { context?: { enum?: readonly string[] } }
      } } | undefined
    // The enum specifically, not the tool as a whole: the prose around it
    // mentions both words too, so a looser assertion would pass with the
    // parameter deleted.
    expect(spawn?.parameters?.properties?.context?.enum).toEqual(['fresh', 'fork'])
  })
})

/**
 * The smallest thing `attach` accepts, for a member that never finishes.
 *
 * Never finishing is the point: against an already-idle member the wait
 * returns at once and the budget governs nothing, so the clamp could be
 * deleted and the timing would look identical.
 */
function busySession(): unknown {
  return {
    conversationId: 'c-1',
    isRunning: true,
    definition: { id: 'a', name: 'a', description: '' },
    inject: () => undefined,
    snapshot: () => ({ version: 1, history: { version: 1, entries: [] } }),
    whenIdle: async (signal?: AbortSignal) => await new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => resolve(), { once: true })
    }),
  }
}

describe('a wait too short to be one', () => {
  it('raises a below-floor request to the floor and says so', async () => {
    const team = new AgentTeam({ minWaitTimeoutMs: 200, waitTimeoutMs: 30_000 })
    team.attach(busySession() as never, { name: 'lead', role: 'lead' })
    team.attach(busySession() as never, { name: 'peer', role: 'peer' })
    const tool = team.toolsFor('lead').find(candidate => candidate.name === 'wait_agents')!

    const started = Date.now()
    const result = await tool.execute!(
      { targets: ['peer'], timeoutMs: 1 } as never,
      { signal: new AbortController().signal } as never,
    ) as { waitedMs: number }

    // A lead that asks for a millisecond gets the roster back unchanged and has
    // spent a whole model round to learn nothing. Observed in practice as
    // `wait_agents` called with a one-second budget right after three spawns.
    expect(result.waitedMs).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('never clamps up past the host ceiling', async () => {
    // A floor above the ceiling would raise every call to a budget the host had
    // just declared too long.
    expect(DEFAULT_MIN_WAIT_TIMEOUT_MS).toBeGreaterThan(1_000)
    const team = new AgentTeam({ waitTimeoutMs: 1_000 })
    team.attach(busySession() as never, { name: 'lead', role: 'lead' })
    team.attach(busySession() as never, { name: 'peer', role: 'peer' })
    const tool = team.toolsFor('lead').find(candidate => candidate.name === 'wait_agents')!

    const result = await tool.execute!(
      { targets: ['peer'], timeoutMs: 1 } as never,
      { signal: new AbortController().signal } as never,
    ) as { waitedMs: number }
    expect(result.waitedMs).toBe(1_000)
  })
})

describe('forking the lead context into a worker', () => {
  /** Records what each worker was asked, after the lead has learned something. */
  class ForkProbe extends StubAdapter {
    readonly workerRequests: GenerateOptions[] = []
    private leadRound = 0
    private announce: (() => void) | undefined
    readonly spawned = new Promise<void>((resolve) => { this.announce = resolve })

    constructor(private readonly spawnArgs: Record<string, unknown>) { super() }

    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (!isLead(options)) {
        this.workerRequests.push(options)
        this.announce?.()
        yield* text('worker answer')
        return
      }
      this.leadRound += 1
      if (this.leadRound === 1) {
        // A finding only the lead has, for the fork to carry.
        yield* text('The workspace is empty, so I will scaffold it myself.')
        return
      }
      if (this.leadRound === 2) {
        yield* toolCall('call-1', 'spawn_agent', this.spawnArgs)
        return
      }
      yield* text('lead done')
    }
  }

  async function runSpawn(
    spawnArgs: Record<string, unknown>,
    options: { defaultSpawnContext?: 'fresh' | 'fork' } = {},
  ) {
    const adapter = new ForkProbe(spawnArgs)
    const managed = teamOf(adapter, options)
    // Two prompts: the first leaves a completed exchange in the lead's history,
    // the second spawns from inside its own turn — which is what a fork has to
    // cope with.
    await managed.run('look around')
    await managed.run('now delegate the rest')
    await adapter.spawned
    const worker = managed.workers()[0]!
    await managed.awaitWorker(worker.name, { timeoutMs: 10_000 })
    return { adapter, managed, worker }
  }

  it('gives a fork worker what the lead already found out', async () => {
    const { adapter, worker } = await runSpawn({ task: 'build the UI', context: 'fork' })
    expect(worker.context).toBe('fork')
    // The point of the option: three workers spawned into an empty directory
    // each listed it and each concluded, separately, that it was empty.
    expect(bodyOf(adapter.workerRequests[0]!)).toContain('The workspace is empty')
  })

  it('leaves a fresh worker with its task and nothing else', async () => {
    const { adapter, worker } = await runSpawn({ task: 'build the UI', context: 'fresh' })
    expect(worker.context).toBe('fresh')
    const body = bodyOf(adapter.workerRequests[0]!)
    expect(body).not.toContain('The workspace is empty')
    expect(body).toContain('build the UI')
  })

  it('never hands a worker the unanswered spawn call it was created by', async () => {
    // The lead is INSIDE the turn that calls spawn_agent, so the assistant
    // message carrying that call is already in its history while the result
    // cannot be. Copying that tail verbatim would give the worker a
    // conversation ending in an unanswered tool call — which providers reject,
    // turning a context optimisation into a spawn that fails outright.
    const { adapter } = await runSpawn({ task: 'build the UI', context: 'fork' })
    const body = bodyOf(adapter.workerRequests[0]!)
    expect(body).not.toContain('call-1')
  })

  it('applies the host default when the call does not choose', async () => {
    const { adapter, worker } = await runSpawn(
      { task: 'build the UI' },
      { defaultSpawnContext: 'fork' },
    )
    // A host whose workers always operate on the lead's workspace should not
    // have to hope the lead asks for the context every time.
    expect(worker.context).toBe('fork')
    expect(bodyOf(adapter.workerRequests[0]!)).toContain('The workspace is empty')
  })

  it('defaults to fresh, because a fork is paid for on every worker round', async () => {
    const { worker } = await runSpawn({ task: 'build the UI' })
    expect(worker.context).toBe('fresh')
  })
})

describe('completedHistoryPrefix', () => {
  /** A message always has content; only its blocks matter here. */
  const msg = (): unknown => ({ role: 'user', content: [] })

  const snapshot = (
    events: readonly { kind: string; [key: string]: unknown }[],
  ): HistorySnapshot => ({
    version: 1,
    entries: events.map((event, index) => ({
      seq: index,
      event: event as never,
      surfaceOp: 'append' as const,
    })),
  })

  const kinds = (entries: readonly { event: { kind: string } }[]): readonly string[] =>
    entries.map(entry => entry.event.kind)

  it('stops before a tool call that has no result yet', () => {
    const prefix = completedHistoryPrefix(snapshot([
      { kind: 'user', message: msg() },
      { kind: 'assistant', message: msg() },
      { kind: 'tool-call', callId: 'a', name: 'spawn_agent', rawArguments: '{}' },
    ]))
    expect(kinds(prefix)).toEqual(['user', 'assistant'])
  })

  it('includes a tool call once its result is in', () => {
    const prefix = completedHistoryPrefix(snapshot([
      { kind: 'user', message: msg() },
      { kind: 'tool-call', callId: 'a', name: 'read', rawArguments: '{}' },
      { kind: 'tool-result', callId: 'a', message: msg(), result: {} },
      { kind: 'assistant', message: msg() },
    ]))
    expect(kinds(prefix)).toEqual(['user', 'tool-call', 'tool-result', 'assistant'])
  })

  it('does not carry an interrupted assistant turn', () => {
    // A half-formed intention is not something the lead knows.
    const prefix = completedHistoryPrefix(snapshot([
      { kind: 'user', message: msg() },
      { kind: 'assistant', message: msg(), interrupted: true },
    ]))
    expect(kinds(prefix)).toEqual(['user'])
  })

  it('is empty when nothing has completed', () => {
    expect(completedHistoryPrefix(snapshot([
      { kind: 'tool-call', callId: 'a', name: 'read', rawArguments: '{}' },
    ]))).toEqual([])
  })
})
