import { createManagedAgentTeam, defineAgent, ToolRegistry } from '../../../packages/core/src/agent/index.ts'
import type { ManagedAgentTeam, ManagedAgentTeamOptions,
  ToolRunContext } from '../../../packages/core/src/agent/index.ts'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '../../../packages/core/src/index.ts'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '../../../packages/core/src/index.ts'
import { afterEach, vi } from 'vitest'
export function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class BatchAdapter extends ModelAdapter {
  readonly leads: GenerateOptions[] = []
  readonly workers = new Map<string, GenerateOptions>()
  readonly finishes = new Map<string, ReturnType<typeof gate>>()
  join = true
  spawn = true
  fail?: string
  textFor?: (name: string) => string

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'medium' }] } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let text = 'synthesis'
    if (options.tools?.some(tool => tool.name === 'spawn_agent')) {
      this.leads.push(options)
      if (this.leads.length === 1 && this.spawn) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('batch'),
          name: 'spawn_agents', arguments: JSON.stringify({ tasks: tasks(), join: this.join }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
    } else {
      const name = /managed worker '([^']+)'/.exec(options.system ?? '')![1]!
      const finish = gate()
      this.finishes.set(name, finish)
      this.workers.set(name, options)
      const signal = options.signal!
      const aborted = gate()
      const abort = () => aborted.resolve()
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        await Promise.race([finish.promise, aborted.promise])
        signal.throwIfAborted()
      } finally { signal.removeEventListener('abort', abort) }
      if (name === this.fail) throw new Error('worker verification failed')
      text = this.textFor?.(name) ?? `evidence/${name}/complete`
    }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const teams: ManagedAgentTeam[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const team of teams.splice(0)) { await team.dispose(); await team.team.dispose() }
})

export function fixture(options: Partial<ManagedAgentTeamOptions> = {}) {
  const adapter = new BatchAdapter()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const team = createManagedAgentTeam({ registry, maxWorkers: 3, workerTimeoutMs: 2000,
    team: { minWaitTimeoutMs: 10, waitTimeoutMs: 1000 },
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve it.', maxTurns: 6 }),
    ...options })
  teams.push(team)
  return { adapter, team }
}

export function tasks() {
  return ['a', 'b', 'c'].map(name => ({ name, task: `Inspect input/${name}; return findings.` }))
}
export function tool(team: ManagedAgentTeam, name: string) {
  return (team.lead.options.tools as ToolRegistry).get(name)
    ?? team.lead.options.team!.team.toolsFor('lead').find(tool => tool.name === name)!
}
export async function execute(team: ManagedAgentTeam, name: string, raw: unknown,
  signal: AbortSignal = new AbortController().signal) {
  const definition = tool(team, name)
  return definition.execute(definition.parse!(raw), { signal } as ToolRunContext) as Promise<any>
}
export function notices(team: ManagedAgentTeam) {
  return team.team.messages().filter(message => message.target === 'lead'
    && message.content.some(block => block.type === 'text' && block.text.includes('Managed worker settlement')))
}

