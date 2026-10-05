import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, defineTool, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { ComposableModelProviderPlugin, GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core/provider'
import { choiceQuestion, createDecisionRuntime, createDecisionTask, DecisionAdapter, defineDecisionProviderPlugin, type DecisionRequest, type DecisionResult } from '@alvin0/ai-agent-sdk-decision-adapter'

class Chat extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(input: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(input)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('route-1'), name: 'classify_ticket', arguments: '{"message":"Refund please"}' } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ticket sent to billing.' } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
class Classifier extends DecisionAdapter {
  readonly calls = vi.fn(async (_request: DecisionRequest): Promise<DecisionResult> => ({
    model: 'classifier-v1', answers: { route: { type: 'choice', choice: 'billing' } },
  }))
  override evaluate(request: DecisionRequest) { return this.calls(request) }
}
function chatPlugin(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id: 'chat', displayName: 'Chat', routes: ['chat'], defaultModel: { provider: 'chat', id: 'chat-v1' }, setup(registrar) { registrar.registerAdapter(['chat'], adapter) } }
}
const questions = { route: choiceQuestion('Which team?', { billing: 'Refunds', support: 'Technical issues' }) }
describe('decision companion integration with public core API', () => {
  it('runs a decision task inside a core agent tool and leaves companion lifecycle explicit', async () => {
    const chat = new Chat(), classifier = new Classifier()
    const decisions = createDecisionRuntime()
    decisions.registerAdapter(['decision'], classifier)
    const task = createDecisionTask(decisions.decisionModel({ provider: 'decision', model: 'classifier' }), { questions })
    const core = await createAgentRuntime({ providers: [chatPlugin(chat)] })
    let toolSignal: AbortSignal | undefined
    try {
      const tool = defineTool<{ message: string }>({
        name: 'classify_ticket', description: 'Classify a ticket',
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
        parse(raw) {
          if (raw === null || typeof raw !== 'object' || !('message' in raw) || typeof raw.message !== 'string') throw new Error('message required')
          return { message: raw.message }
        },
        async execute(args, ctx) {
          toolSignal = ctx.signal
          const result = await task.evaluate({ message: args.message }, { signal: ctx.signal }, { ...(ctx.logger ? { logger: ctx.logger } : {}) })
          return { route: result.answers.route.choice, model: result.model }
        },
      })
      const result = await core.agent({ id: 'triage', instructions: 'Use classify_ticket', tools: [tool], compaction: false }).generate('Refund please')
      expect(result.message?.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Ticket sent to billing.' }))
      expect(chat.requests).toHaveLength(2)
      expect(JSON.stringify(chat.requests[1]?.messages)).toContain('billing')
      expect(classifier.calls).toHaveBeenCalledTimes(1)
      expect(classifier.calls.mock.calls[0]![0]).toMatchObject({ state: { message: 'Refund please' }, signal: expect.any(AbortSignal) })
      // Core ends the tool signal's scope after committing the result.
      expect(toolSignal?.aborted).toBe(true)
      expect('decisionModel' in core).toBe(false)
      await core.close()
      // Core close does not own this independently-created companion.
      await expect(task.evaluate('Still independently active')).resolves.toHaveProperty('answers.route.choice', 'billing')
    } finally { await core.close(); await decisions.close() }
    await expect(task.evaluate('Closed')).rejects.toMatchObject({ code: 'DECISION_RUNTIME_CLOSED' })
  })
  it('core close aborts an active decision when the tool forwards its cancellation signal', async () => {
    const classifier = new Classifier()
    let started!: () => void
    const dispatched = new Promise<void>(resolve => { started = resolve })
    let decisionSignal: AbortSignal | undefined
    classifier.calls.mockImplementation(request => {
      decisionSignal = request.signal
      started()
      return new Promise(() => {})
    })
    const decisions = createDecisionRuntime()
    decisions.registerAdapter(['decision'], classifier)
    const task = createDecisionTask(decisions.decisionModel({ provider: 'decision', model: 'classifier' }), { questions })
    const core = await createAgentRuntime({ providers: [chatPlugin(new Chat())] })
    try {
      const tool = defineTool({ name: 'classify_ticket', description: 'Classify', parameters: { type: 'object' },
        async execute(_args, ctx) {
          const result = await task.evaluate('Refund', { signal: ctx.signal })
          return { route: result.answers.route.choice }
        },
      })
      const run = core.agent({ id: 'triage', instructions: 'Classify', tools: [tool], compaction: false }).generate('Refund')
      const settled = run.then(() => 'settled', () => 'settled')
      await dispatched
      const report = await core.close()
      expect(decisionSignal?.aborted).toBe(true)
      expect(await settled).toBe('settled')
      expect(report.unsettledRuns).toBe(0)
    } finally { await core.close(); await decisions.close() }
  })
  it('rejects decision plugins in the core provider list until native integration exists', async () => {
    const plugin = defineDecisionProviderPlugin({ id: 'decision', routes: ['decision'], setup(registrar) { registrar.registerAdapter(['decision'], new Classifier()) } })
    // @ts-expect-error Core accepts generation/embedding plugins, not decision plugins.
    await expect(createAgentRuntime({ providers: [plugin] })).rejects.toBeDefined()
  })
})
