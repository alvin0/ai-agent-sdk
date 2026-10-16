import { afterEach, vi } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeam, ManagedAgentTeamOptions } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export function answer(text: string): StreamChunk[] {
  return [{ type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } }]
}

export function calls(items: { name: string; args: unknown }[]): StreamChunk[] {
  return [...items.map((item, index): StreamChunk => ({ type: 'block-end', index,
    block: { type: 'tool-call', id: ToolCallId(`${item.name}-${index}`), name: item.name,
      arguments: JSON.stringify(item.args) } })), { type: 'finish', reason: { kind: 'tool-calls' } }]
}

export class GatedTeam extends ModelAdapter {
  readonly leadRequests: GenerateOptions[] = []
  readonly gates = new Map<string, ReturnType<typeof deferred>>()
  readonly started = new Set<string>()
  readonly rounds = new Map<string, number>()
  readonly finished = new Set<string>()
  private submitted = false
  join = false
  workerText = 'finding'

  constructor(readonly names = ['w']) {
    super()
    for (const name of names) this.gates.set(name, deferred())
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.tools?.some(tool => tool.name === 'spawn_agent')) {
      yield* this.leadTurn(options)
      return
    }
    const name = /(?:dynamically assigned|managed) worker '([^']+)'/.exec(options.system ?? '')?.[1] ?? 'w'
    this.started.add(name)
    const round = (this.rounds.get(name) ?? 0) + 1
    this.rounds.set(name, round)
    const gate = this.gates.get(name)
    await new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      const abort = () => reject(options.signal?.reason)
      options.signal?.addEventListener('abort', abort, { once: true })
      void (gate?.promise ?? Promise.resolve()).then(() => {
        options.signal?.removeEventListener('abort', abort)
        resolve()
      })
    })
    if (options.tools?.some(tool => tool.name === 'submit_result') && round === 1) {
      yield* calls([{ name: 'submit_result', args: { summary: 'Research complete', evidence: ['source checked'] } }])
    } else {
      this.finished.add(name)
      yield* answer(`${name} ${this.workerText} ${round}`)
    }
  }

  private * leadTurn(options: GenerateOptions): Iterable<StreamChunk> {
    this.leadRequests.push(options)
    if (this.leadRequests.length === 1) {
      yield* calls(this.names.map(name => ({ name: 'spawn_agent', args: { name, task: `Research ${name}` } })))
    } else if (this.join && this.leadRequests.length === 2) {
      yield* calls([{ name: 'wait_agents', args: { targets: this.names } }])
    } else if (options.tools?.some(tool => tool.name === 'submit_result')
      && this.finished.size === this.names.length && !this.submitted) {
      this.submitted = true
      yield* calls([{ name: 'submit_result', args: { summary: 'Research complete', evidence: ['worker findings'] } }])
    } else yield* answer(JSON.stringify(options.messages).includes('finding') ? 'synthesis' : 'yield')
  }
}

const teams: ManagedAgentTeam[] = []
export function create(adapter: GatedTeam, options: Partial<ManagedAgentTeamOptions> = {}) {
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const team = createManagedAgentTeam({ modelToolSurface: 'legacy', registry,
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted',
      instructions: 'Lead the research team.', mode: 'basic', maxTurns: 5 }),
    ...options })
  teams.push(team)
  return team
}

export async function tool(team: ManagedAgentTeam, name: string, args: unknown) {
  const definition = team.team.toolsFor('lead').find(tool => tool.name === name)!
  return await definition.execute!(definition.parse!(args), { signal: new AbortController().signal } as never) as any
}

afterEach(async () => {
  vi.useRealTimers()
  for (const team of teams.splice(0)) { await team.dispose(); await team.team.dispose() }
})

