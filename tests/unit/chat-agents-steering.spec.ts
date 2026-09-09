import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { History, ToolRegistry, defineTool } from '@ai-agent-sdk/core/agent'
import { ModelAdapter, ModelRegistry, ToolCallId, createUserInputBroker } from '@ai-agent-sdk/core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@ai-agent-sdk/core'

const home = mkdtempSync(join(tmpdir(), 'steering-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')

const { startRun } = await import('../../samples/chat-agents/backend/src/agent-runtime.ts')

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
}

const toolRound = (name: string): StreamChunk[] => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: ToolCallId('call_1'), name, arguments: '{}' },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

const textRound = (text: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('steering a run in flight', () => {
  it('reaches the model on its next round, without restarting the run', async () => {
    // Round 1 calls a tool; the user steers while that tool is running, which
    // is when a person actually notices the agent going the wrong way.
    const adapter = new ScriptedAdapter([toolRound('probe'), textRound('understood')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)

    const handles: { steer?: (text: string) => boolean } = {}
    let steerResult: boolean | undefined
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'probe',
      description: 'Stands in for slow work the user interrupts.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => {
        steerResult = handles.steer?.('actually use pnpm, not npm')
        return 'probed'
      },
    }))

    const started = await startRun('set the project up', {
      registry,
      provider: 'test',
      model: 'scripted',
      effort: undefined,
      mode: 'basic',
      workspaceRoot: home,
      groupId: 'default',
      workspaceTools: tools,
      userInput: createUserInputBroker(),
      agent: undefined,
      history: new History(),
      signal: new AbortController().signal,
    }, () => undefined)
    handles.steer = started.steer

    for await (const _event of started.events) { /* drain to completion */ }
    await started.close()

    expect(steerResult).toBe(true)
    expect(adapter.requests.length).toBe(2)
    // The point of the whole feature: the second request — the same run, the
    // next round — already carries what the user typed.
    expect(JSON.stringify(adapter.requests[0])).not.toContain('actually use pnpm')
    expect(JSON.stringify(adapter.requests[1])).toContain('actually use pnpm, not npm')
  })

  it('reports the message as the user, not as a tool result', async () => {
    const adapter = new ScriptedAdapter([toolRound('probe'), textRound('ok')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const handles: { steer?: (text: string) => boolean } = {}
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'probe',
      description: 'Stands in for slow work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => { handles.steer?.('stop and ask me first'); return 'probed' },
    }))

    const history = new History()
    const started = await startRun('go', {
      registry,
      provider: 'test',
      model: 'scripted',
      effort: undefined,
      mode: 'basic',
      workspaceRoot: home,
      groupId: 'default',
      workspaceTools: tools,
      userInput: createUserInputBroker(),
      agent: undefined,
      history,
      signal: new AbortController().signal,
    }, () => undefined)
    handles.steer = started.steer
    for await (const _event of started.events) { /* drain */ }
    await started.close()

    // It joins the conversation as the USER's turn, so the model reads it as an
    // instruction rather than as something a tool returned.
    const users = history.messages().filter(message => message.role === 'user')
    expect(users.some(message => JSON.stringify(message).includes('stop and ask me first'))).toBe(true)
  })
})
