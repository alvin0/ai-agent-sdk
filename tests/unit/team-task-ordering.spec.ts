import { describe, expect, it } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeam } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'

/**
 * Ordering, ownership, and roles.
 *
 * The lead used to divide agents without dividing work: it spawned a UI worker,
 * a logic worker and an auditor into an empty directory in one step. The
 * auditor had nothing to review, and the other two were both given the same
 * page component to write. Prose tells a lead not to do that; these are the
 * mechanisms that stop it from mattering when the lead does it anyway.
 */

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body } },
  { type: 'finish', reason: { kind: 'stop' } },
]

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

/**
 * Workers whose runs the test opens and closes by hand.
 *
 * Holding each worker's model call open is what makes "has not started" and
 * "has started" distinguishable at all: a worker that finishes instantly would
 * look the same either way.
 */
class Workers extends StubAdapter {
  readonly started: string[] = []
  readonly requests = new Map<string, GenerateOptions>()
  private readonly gates = new Map<string, () => void>()
  private readonly waiters = new Map<string, () => void>()

  /** Resolves once the named worker's model call has actually begun. */
  runningOf(name: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.started.includes(name)) { resolve(); return }
      this.waiters.set(name, resolve)
    })
  }

  finish(name: string): void { this.gates.get(name)?.() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (isLead(options)) { yield* text('lead done'); return }
    const name = workerName(options)
    this.started.push(name)
    this.requests.set(name, options)
    this.waiters.get(name)?.()
    await new Promise<void>((resolve) => {
      this.gates.set(name, resolve)
      options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    options.signal?.throwIfAborted()
    yield* text(`${name} result`)
  }
}

/** A worker's own name, as its generated instructions state it. */
function workerName(options: GenerateOptions): string {
  return /dynamically assigned worker '([^']+)'/.exec(options.system ?? '')?.[1] ?? 'unknown'
}

function teamOf(
  adapter: ModelAdapter,
  options: Parameters<typeof createManagedAgentTeam>[0] extends never ? never : Record<string, unknown> = {},
): ManagedAgentTeam {
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return createManagedAgentTeam({
    registry,
    holdWaitMs: 20,
    lead: defineAgent({
      id: 'lead',
      provider: 'test',
      model: 'scripted',
      instructions: 'You lead a team.',
      mode: 'basic',
      maxTurns: 4,
    }),
    leadName: 'lead',
    ...options,
  } as never)
}

const statusOf = (team: ManagedAgentTeam, name: string): string | undefined =>
  team.workers().find(worker => worker.name === name)?.status

describe('holding a worker until its dependencies settle', () => {
  it('does not start a dependent while its dependency is still running', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'builder', task: 'build the app' })
    await adapter.runningOf('builder')

    const auditor = await team.spawn({
      name: 'auditor',
      task: 'review the app',
      dependsOn: ['builder'],
    })

    // The whole plan is spawned in one step — which is what a lead wants to do
    // — and the ORDER still holds. Without this the auditor reviews nothing.
    expect(auditor.status).toBe('pending')
    expect(adapter.started).toEqual(['builder'])
    await team.dispose()
  }, 20_000)

  it('starts it once the dependency finishes, and tells it what came out', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'builder', task: 'build the app' })
    await adapter.runningOf('builder')
    await team.spawn({ name: 'auditor', task: 'review the app', dependsOn: ['builder'] })

    adapter.finish('builder')
    await adapter.runningOf('auditor')

    expect(statusOf(team, 'auditor')).toBe('running')
    // Not merely released: handed the result. A dependent that has to
    // rediscover its dependency's output is only half-ordered.
    expect(bodyOf(adapter.requests.get('auditor')!)).toContain('builder result')
    adapter.finish('auditor')
    await team.dispose()
  }, 20_000)

  it('releases dependents when a dependency fails, and says it failed', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'builder', task: 'build the app' })
    await adapter.runningOf('builder')
    await team.spawn({ name: 'auditor', task: 'review the app', dependsOn: ['builder'] })

    // Waiting only for SUCCESS would leave every later step stranded on one
    // broken worker, with nothing to show for it.
    await team.closeWorker('builder', new Error('builder exploded'))
    await adapter.runningOf('auditor')
    expect(statusOf(team, 'auditor')).toBe('running')
    adapter.finish('auditor')
    await team.dispose()
  }, 20_000)

  it('releases the next step when a held worker is closed before it ever ran', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'builder', task: 'build' })
    await adapter.runningOf('builder')
    await team.spawn({ name: 'reviewer', task: 'review', dependsOn: ['builder'] })
    await team.spawn({ name: 'shipper', task: 'ship', dependsOn: ['reviewer'] })

    // The lead changes its mind about the middle step. A worker that never ran
    // has no run whose end could release what was queued behind it, so unless
    // closing says so itself, `shipper` waits for something that will never
    // happen again.
    await team.closeWorker('reviewer')
    adapter.finish('builder')
    await adapter.runningOf('shipper')
    expect(statusOf(team, 'shipper')).toBe('running')
    adapter.finish('shipper')
    await team.dispose()
  }, 20_000)

  it('reports a held worker as pending on the roster, not idle', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'builder', task: 'build the app' })
    await adapter.runningOf('builder')
    await team.spawn({ name: 'auditor', task: 'review', dependsOn: ['builder'] })

    // A never-run session is idle and not running — indistinguishable from one
    // that has finished. A lead reading `idle` here concludes the review is
    // done, and `wait_agents` would agree with it.
    const auditor = team.team.members().find(member => member.name === 'auditor')
    expect(auditor?.status).toBe('pending')
    expect(auditor?.outcome).toBeUndefined()
    await team.dispose()
  }, 20_000)

  it('makes wait_agents wait for a held worker instead of answering at once', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'builder', task: 'build' })
    await adapter.runningOf('builder')
    await team.spawn({ name: 'auditor', task: 'review', dependsOn: ['builder'] })

    const wait = team.team.toolsFor('lead').find(tool => tool.name === 'wait_agents')!
    const report = await wait.execute!(
      { targets: ['auditor'], timeoutMs: 5_000 } as never,
      { signal: new AbortController().signal } as never,
    ) as { settled: string | null; timedOut: boolean }

    expect(report).toMatchObject({ settled: null, timedOut: true })
    await team.dispose()
  }, 20_000)

  it('refuses a dependency on a worker that does not exist', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    // A dependency can only name an existing worker, which is also why the
    // graph cannot contain a cycle and needs no cycle check.
    await expect(team.spawn({ task: 'review', dependsOn: ['nobody'] }))
      .rejects.toThrow(/unknown dependency/)
    await team.dispose()
  }, 20_000)

  it('starts immediately when the dependency has already settled', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'builder', task: 'build' })
    await adapter.runningOf('builder')
    adapter.finish('builder')
    await team.awaitWorker('builder', { timeoutMs: 10_000 })

    const late = await team.spawn({ name: 'auditor', task: 'review', dependsOn: ['builder'] })
    expect(late.status).toBe('running')
    adapter.finish('auditor')
    await team.dispose()
  }, 20_000)
})

describe('who is allowed to write what', () => {
  it('refuses two concurrent workers writing the same file', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'ui', task: 'build the UI', writes: ['app/page.tsx'] })
    await adapter.runningOf('ui')

    // The exact collision from the trace: a UI worker announcing it would put
    // its logic in the very file the logic worker had been assigned. Both
    // would write it, and the later write would erase the earlier one.
    await expect(team.spawn({ name: 'logic', task: 'build the logic', writes: ['app/page.tsx'] }))
      .rejects.toThrow(/would write files another running worker writes/)
    await team.dispose()
  }, 20_000)

  it('treats a directory as covering the files under it', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'ui', task: 'build the UI', writes: ['./app/'] })
    await adapter.runningOf('ui')
    await expect(team.spawn({ name: 'logic', task: 'logic', writes: ['app/lib/store.ts'] }))
      .rejects.toThrow(/also writes app\/lib\/store\.ts/)
    await team.dispose()
  }, 20_000)

  it('allows the same files once one worker depends on the other', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'ui', task: 'build the UI', writes: ['app/page.tsx'] })
    await adapter.runningOf('ui')

    // The fix the refusal points at: ordered, they never write at once, and
    // sharing a file is ordinary sequential work.
    const polish = await team.spawn({
      name: 'polish',
      task: 'restyle the page',
      writes: ['app/page.tsx'],
      dependsOn: ['ui'],
    })
    expect(polish.status).toBe('pending')
    await team.dispose()
  }, 20_000)

  it('lets several read-only workers run together when none declares a scope', async () => {
    // The real failure this guards: a lead spawned four researchers, each
    // declaring the same placeholder scope because it read `writes` as
    // mandatory, and three were refused for colliding over a file none of them
    // would ever write. A reader declares nothing.
    const adapter = new Workers()
    const team = teamOf(adapter)
    for (const name of ['banks', 'property', 'tech', 'industrial']) {
      await team.spawn({ name, task: `research ${name}` })
    }
    expect(team.workers().map(worker => worker.status))
      .toEqual(['running', 'running', 'running', 'running'])
    await team.dispose()
  }, 20_000)

  it('points a colliding reader at dropping the scope, not at a better fake path', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'first', task: 'research banks', writes: ['/tmp/no-write'] })
    await adapter.runningOf('first')

    // Offering only dependsOn and narrowing sent a worker that writes nothing
    // looking for a different placeholder, which collides just the same.
    await expect(team.spawn({ name: 'second', task: 'research property', writes: ['/tmp/no-write'] }))
      .rejects.toThrow(/omit writes entirely if this worker only reads/)
    await team.dispose()
  }, 20_000)

  it('lets disjoint scopes run together', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    await team.spawn({ name: 'ui', task: 'UI', writes: ['app/page.tsx'] })
    await team.spawn({ name: 'logic', task: 'logic', writes: ['lib/store.ts'] })
    expect(team.workers().map(worker => worker.status)).toEqual(['running', 'running'])
    await team.dispose()
  }, 20_000)

  it('records the overlap instead of refusing it under the warn policy', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter, { writeScopePolicy: 'warn' })
    await team.spawn({ name: 'ui', task: 'UI', writes: ['app/page.tsx'] })
    await adapter.runningOf('ui')
    const logic = await team.spawn({ name: 'logic', task: 'logic', writes: ['app/page.tsx'] })
    expect(logic.status).toBe('running')
    expect(logic.warnings).toEqual(["'ui' also writes app/page.tsx"])
    await team.dispose()
  }, 20_000)

  it('will not let a worker claim the entire workspace', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter)
    // A scope of "." overlaps everything, so accepting it would make the first
    // worker the only one that could ever run.
    await expect(team.spawn({ task: 'everything', writes: ['.'] }))
      .rejects.toThrow(/not the whole workspace/)
    await team.dispose()
  }, 20_000)
})

describe('roles the host declared', () => {
  const roles = [
    { name: 'implementer', description: 'Writes code.', instructions: 'Write the code.' },
    {
      name: 'reviewer',
      description: 'Reviews code it does not write.',
      whenToUse: 'only once the code exists',
    },
  ]

  it('offers the roles to the lead with what each is for', async () => {
    class Capture extends StubAdapter {
      readonly requests: GenerateOptions[] = []
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(options)
        yield* text('done')
      }
    }
    const adapter = new Capture()
    await teamOf(adapter, { roles }).run('build something')
    const spawn = (adapter.requests[0]?.tools ?? [])
      .find(tool => tool.name === 'spawn_agent') as { parameters?: { properties?: {
        role?: { enum?: readonly string[]; description?: string }
      } } } | undefined

    expect(spawn?.parameters?.properties?.role?.enum).toEqual(['implementer', 'reviewer'])
    // `whenToUse` is the precondition the lead needs BEFORE it chooses, so it
    // has to be here rather than in documentation it never reads.
    expect(spawn?.parameters?.properties?.role?.description)
      .toContain('Use when: only once the code exists')
  })

  it('gives the worker the role it was spawned as', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter, { roles })
    const worker = await team.spawn({ name: 'dev', task: 'build', role: 'implementer' })
    await adapter.runningOf('dev')
    expect(worker.role).toBe('implementer')
    expect(adapter.requests.get('dev')?.system).toContain('Write the code.')
    await team.dispose()
  }, 20_000)

  it('refuses a role nobody declared', async () => {
    const adapter = new Workers()
    const team = teamOf(adapter, { roles })
    await expect(team.spawn({ task: 'audit', role: 'auditor' }))
      .rejects.toThrow(/unknown worker role 'auditor'; declared roles are implementer, reviewer/)
    await team.dispose()
  }, 20_000)

  it('offers no role parameter when the host declared none', async () => {
    class Capture extends StubAdapter {
      readonly requests: GenerateOptions[] = []
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(options)
        yield* text('done')
      }
    }
    const adapter = new Capture()
    await teamOf(adapter).run('build something')
    const spawn = (adapter.requests[0]?.tools ?? [])
      .find(tool => tool.name === 'spawn_agent') as { parameters?: { properties?: Record<string, unknown> } }
    // Offering an empty enum would be a parameter the lead can never satisfy.
    expect(spawn.parameters?.properties).not.toHaveProperty('role')
  })
})
