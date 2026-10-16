import { afterEach } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeam, ManagedAgentTeamOptions } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolDefinition } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export function answer(text: string): StreamChunk[] {
  return [ { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } } ]
}

export function call(name: string, args: unknown): StreamChunk[] {
  return [ { type: 'block-end', index: 0, block: {
    type: 'tool-call', id: ToolCallId(crypto.randomUUID()), name, arguments: JSON.stringify(args),
  } }, { type: 'finish', reason: { kind: 'tool-calls' } } ]
}

type Script = (name: string, round: number, options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>

export class CollaborationAdapter extends ModelAdapter {
  readonly rounds = new Map<string, number>()
  readonly requests: { name: string; options: GenerateOptions }[] = []
  constructor(private readonly script: Script = name => answer(`${name} done`)) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const name = /agent-team member '([^']+)'/.exec(options.system ?? '')?.[1] ?? 'lead'
    const round = (this.rounds.get(name) ?? 0) + 1
    this.rounds.set(name, round)
    this.requests.push({ name, options })
    yield* await this.script(name, round, options)
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'medium' }] } })
  }
}

const teams: ManagedAgentTeam[] = []
afterEach(async () => {
  for (const team of teams.splice(0)) { await team.dispose(); await team.team.dispose() }
})

export function managed(adapter: ModelAdapter = new CollaborationAdapter(),
  options: Partial<ManagedAgentTeamOptions> = {}): ManagedAgentTeam {
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const team = createManagedAgentTeam({ modelToolSurface: 'legacy', registry,
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve the problem.',
      mode: 'basic', maxTurns: 12 }), collaboration: true,
    ...options })
  teams.push(team)
  return team
}

export function execute(team: ManagedAgentTeam, sender: string, name: string, raw: unknown) {
  const tool = team.collaboration!.toolsFor(sender).find(tool => tool.name === name)!
  return runTool(tool, raw)
}

export function runTool(tool: ToolDefinition<any>, raw: unknown) {
  return tool.execute(tool.parse?.(raw) ?? raw, {
    callId: ToolCallId('test-call'), toolName: tool.name, turn: 1, step: 1,
    signal: new AbortController().signal, concludeTurn() {}, addContext() {},
  })
}
