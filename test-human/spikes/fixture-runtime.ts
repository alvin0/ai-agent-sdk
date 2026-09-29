import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import type { GenerateOptions, StreamChunk, ToolDefinition, RuntimeAgentSessionOptions, RuntimeAgentInvocationOptions } from '@alvin0/ai-agent-sdk-core'
import { randomUUID } from 'node:crypto'
export async function invoke(tools: readonly ToolDefinition[], calls: { tool: string; args: unknown }[], options: RuntimeAgentSessionOptions = {}, invocation: RuntimeAgentInvocationOptions = {}) {
  class Scripted extends ModelAdapter {
    round = 0
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 16000 } } }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (++this.round === 1) {
        for (const [index, call] of calls.entries()) yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: call.tool, arguments: JSON.stringify(call.args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else { yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    }
  }
  const plugin = defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'Spike deterministic fixture', setup(registrar) { registrar.registerAdapter(new Scripted()) } })
  const runtime = await createAgentRuntime({ providers: [plugin] })
  const events: unknown[] = []
  try {
    const agent = runtime.agent({ id: 'fixture', instructions: 'Run host test calls.', model: { provider: 'fixture', id: 'scripted' }, tools, maxTurns: 3, maxToolCalls: 24, compaction: false })
    const response = await agent.createSession(options).run('Execute host fixture.', { ...invocation, includeTraceEvents: true, onEvent(event) { events.push(event) } })
    return { events, status: response.report.status, codes: response.report.errors.map(e => e.code) }
  } catch (error) {
    const report = error instanceof Error ? Reflect.get(error, 'report') as { errors?: { code: string }[] } | undefined : undefined
    if (!report) throw error
    return { events, status: 'error', codes: report.errors?.map(e => e.code) ?? [] }
  } finally { await runtime.close() }
}
