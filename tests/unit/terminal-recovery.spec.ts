import { describe, expect, it } from 'vitest'
import { ModelAdapter, ModelRegistry, ToolCallId, createTextMessage, type GenerateOptions, type StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { createTerminalRecoveryMessage, History, ToolRegistry, defineTool, runAgent, type AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'

class RecoveryAdapter extends ModelAdapter {
  calls = 0
  constructor(readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of this.rounds[this.calls++] ?? []) yield chunk
  }
}
const work: StreamChunk[] = [
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('calculation'), name: 'calculate', arguments: '{}' } },
  { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const failure: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'private provider details' } } }]
async function execute(rounds: readonly (readonly StreamChunk[])[], extra: Record<string, unknown> = {}) {
  const adapter = new RecoveryAdapter(rounds), registry = new ModelRegistry(), history = new History(), tools = new ToolRegistry()
  registry.registerAdapter(['test'], adapter)
  history.append({ kind: 'user', message: createTextMessage('Calculate 17 * 23 and report the result.') })
  tools.register(defineTool({ name: 'calculate', description: 'Calculate.', parameters: { type: 'object' }, execute: () => ({ result: 391 }) }))
  const events: AgentRunEvent[] = []
  for await (const event of runAgent({ mode: 'basic', registry, history, tools, config: { provider: 'test', model: 'm' }, ...extra,
    hooks: { onTerminalRecovery: context => context.defaultText, ...(extra.hooks as object ?? {}) } })) events.push(event)
  const end = events.findLast(event => event.type === 'agent-end')
  return { adapter, history, events, outcome: end?.type === 'agent-end' ? end.outcome : undefined }
}
describe('durable terminal recovery', () => {
  it('returns the committed work when a billed round crosses the hard token wall without another model call', async () => {
    const run = await execute([
      work.map(chunk => chunk.type === 'usage' ? { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } } : chunk),
      [{ type: 'usage', usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 } }, ...failure],
    ], { bounds: { maxTotalTokens: 10 } })
    expect(run.adapter.calls).toBe(2)
    expect(run.outcome?.reason).toMatchObject({ kind: 'budget-exhausted', budget: 'tokens' })
    expect(run.outcome?.text).toContain('391')
    expect(run.outcome?.completed).toBe(false)
    expect(run.history.messages().at(-1)?.role).toBe('assistant')
    expect(run.history.messages().at(-1)?.content).toContainEqual({
      type: 'text', text: run.outcome?.text, phase: 'final-answer',
    })
  })
  it('delivers a final recovery report after a permanent provider failure, without exposing raw errors', async () => {
    const run = await execute([work, failure])
    expect(run.outcome?.reason.kind).toBe('error')
    expect(run.outcome?.text).toContain('391')
    expect(run.outcome?.text).not.toContain('private provider details')
    expect(run.events.at(-1)?.type).toBe('agent-end')
  })
  it('reports a runtime hook failure instead of ending the event stream without a final message', async () => {
    const run = await execute([work], { hooks: { beforeStep: () => { throw new Error('hook failed') } } })
    expect(run.outcome?.reason.kind).toBe('error')
    expect(run.outcome?.text.trim()).toBeTruthy()
    expect(run.adapter.calls).toBe(0)
  })
  it.each([() => { throw new Error('broken formatter') }, () => ' '])('falls back when formatting cannot deliver an answer', async format => {
    const run = await execute([work, failure], { hooks: { onTerminalRecovery: format } })
    expect(run.outcome?.text).toContain('391')
    expect(run.outcome?.text).toContain('remaining work is unverified')
  })
  it('does not manufacture a final answer after an explicit user abort', async () => {
    const controller = new AbortController()
    let delivered = false
    await expect(execute([work], { signal: controller.signal, hooks: {
      beforeStep: () => { controller.abort(); return { kind: 'proceed' } },
      onTerminalRecovery: () => { delivered = true; return 'Should not appear' },
    } })).rejects.toThrow('aborted')
    expect(delivered).toBe(false)
  })
  it('never includes results from a previous user turn in the recovery report', () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('Current task') })
    const message = createTerminalRecoveryMessage({ history, reason: { kind: 'max-tokens' }, text: 'draft'.repeat(6000) })
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text.length).toBeLessThanOrEqual(24000)
    expect(text).toContain('remaining work is unverified')
  })
  it.each(['<<deep-mode:answer-unchanged>>', '<<deep-mode:answer-un'])('keeps reserved host control text out of recovery messages', marker => {
    const message = createTerminalRecoveryMessage({ history: new History(), reason: {kind:'max-tokens'}, text: marker })
    const text = message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('')
    expect(text).not.toContain('<<deep')
    expect(text.trim()).toBeTruthy()
  })
  it('does not claim success when the provider returns an empty answer', async () => {
    const run = await execute([[{ type: 'finish', reason: { kind: 'stop' } }]])
    expect(run.outcome?.text.trim()).toBeTruthy()
    expect(run.outcome?.completed).toBe(false)
  })
})
