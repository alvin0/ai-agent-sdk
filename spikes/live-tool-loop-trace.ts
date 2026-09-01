/** Live smoke for the real loop plus its Foundry-style process projection. */
import { History } from '../src/agent/history/history.ts'
import { runTurn } from '../src/agent/loop/run-turn.ts'
import type { AgentEvent } from '../src/agent/loop/types.ts'
import { defineTool } from '../src/agent/tool/definition.ts'
import { ToolRegistry } from '../src/agent/tool/registry.ts'
import { buildTraceTree, type TraceEvent } from '../src/agent/trace/trace.ts'
import { createTextMessage } from '../src/core/message/message.ts'
import { ReasoningEffortId } from '../src/core/primitives/brand.ts'
import { ModelRegistry } from '../src/core/runtime/registry.ts'
import { codexAdapter } from '../src/providers/codex/adapter.ts'
import { createDailyJsonlRequestLogger } from '../src/providers/request-logger.ts'

const models = new ModelRegistry()
models.registerAdapter(['codex'], codexAdapter({ requestLogger: createDailyJsonlRequestLogger() }))

const tools = new ToolRegistry()
tools.register(defineTool({
  name: 'add',
  description: 'Add two numbers. You must use this tool for arithmetic in this smoke test.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  parse: (raw): { a: number; b: number } => {
    const value = raw as { a?: unknown; b?: unknown }
    if (typeof value.a !== 'number' || typeof value.b !== 'number') throw new Error('a and b must be numbers')
    return { a: value.a, b: value.b }
  },
  isConcurrencySafe: () => true,
  execute: ({ a, b }) => ({ sum: a + b }),
}))

const history = new History()
history.append({ kind: 'user', message: createTextMessage('Call the add tool for 19 + 23, then answer with the result.') })

const events: AgentEvent[] = []
for await (const event of runTurn({
  registry: models,
  config: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: ReasoningEffortId('medium') },
  history,
  tools,
  commentary: 'concise',
  trace: { agentId: 'live-tool-loop-smoke', agentName: 'Live tool-loop smoke' },
  bounds: { maxSteps: 4, maxToolCalls: 2 },
  signal: AbortSignal.timeout(120_000),
})) {
  events.push(event)
  if (event.type === 'assistant-reasoning') console.log(`[reasoning/${event.timing}] ${event.text}`)
  if (event.type === 'assistant-text') console.log(`[${event.phase}/${event.timing}] ${event.text}`)
  if (event.type === 'tool-call') console.log(`[tool/call] ${event.call.toolName} ${event.call.rawArguments}`)
  if (event.type === 'tool-result') console.log(`[tool/result] ${JSON.stringify(event.result)}`)
}

const terminal = events.findLast((event): event is Extract<AgentEvent, { type: 'turn-end' }> => event.type === 'turn-end')
const traceEvents = events.filter((event): event is TraceEvent => event.type === 'span-start' || event.type === 'span-end')
console.log('\n\noutcome:', terminal?.outcome)
console.log('process:', JSON.stringify(buildTraceTree(traceEvents), null, 2))
