import { expect, it } from 'vitest'
import { createAgentRuntime, defineTool, ModelAdapter, ToolCallId, type StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { ToolError } from '@alvin0/ai-agent-sdk-core/tools'

it('preserves a fatal browser tool code after an earlier browser operation succeeded', async () => {
  let rounds = 0
  const called: string[] = []
  class BrowserAdapter extends ModelAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      const name = ++rounds === 1 ? 'browser_open' : 'browser_read'
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId(`browser-${rounds}`), name, arguments: '{}',
      } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const runtime = await createAgentRuntime({ providers: [{
    kind: 'model-provider-plugin', apiVersion: 1, id: 'browser-fixture', displayName: 'Browser fixture',
    family: 'offline', routes: ['offline'], defaultModel: { provider: 'offline', id: 'fixture' },
    setup(registrar) { registrar.registerAdapter(['offline'], new BrowserAdapter()) },
  }] })
  const tools = ['browser_open', 'browser_read'].map(name => defineTool({
    name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute() {
      called.push(name)
      if (name === 'browser_open') return { opened: true }
      throw ToolError.fatal('Private browser failure detail', 'BROWSER_SESSION_CLOSED')
    },
  }))
  try {
    const handle = runtime.agent({ id: 'browser', instructions: 'Open and read', tools, compaction: false })
      .createSession().stream('Open and read')
    const failed = handle.result.catch(error => error as unknown)
    const events = []
    for await (const event of handle) events.push(event)
    const error = await failed
    expect(error).toMatchObject({ code: 'BROWSER_SESSION_CLOSED' })
    const report = await handle.report
    expect(report.status).toBe('error')
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'BROWSER_SESSION_CLOSED' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'browser_open',
      status: 'completed' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'browser_read',
      status: 'failed', output: expect.objectContaining({ error: expect.objectContaining({
        code: 'BROWSER_SESSION_CLOSED',
      }) }) }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'error',
      error: expect.objectContaining({ code: 'BROWSER_SESSION_CLOSED' }) }))
    expect(called).toEqual(['browser_open', 'browser_read'])
    expect(rounds).toBe(2)
    expect(JSON.stringify(report)).not.toContain('Private browser failure detail')
  } finally { await runtime.close() }
})
