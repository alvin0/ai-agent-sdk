/** Live Codex smoke for basic, deep, and deep human-in-loop agent modes. */
import { History } from '@ai-agent-sdk/core/agent'
import { runAgent, type AgentRunEvent, type AgentRunOutcome } from '@ai-agent-sdk/core/agent'
import { createUserInputBroker } from '@ai-agent-sdk/core/agent'
import { defineTool } from '@ai-agent-sdk/core/agent'
import { ToolRegistry } from '@ai-agent-sdk/core/agent'
import { createTextMessage } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { codexNodeAdapter as codexAdapter } from '@ai-agent-sdk/auth-node/codex'
import { createDailyJsonlRequestLogger } from '@ai-agent-sdk/observability-node/diagnostic'

type LiveModeOptions =
  | { readonly mode: 'basic' | 'deep'; readonly maxTurns: number }
  | { readonly mode: 'deep-human-in-loop'; readonly maxTurns: number; readonly userInput: ReturnType<typeof createUserInputBroker> }

const registry = new ModelRegistry()
registry.registerAdapter(['codex'], codexAdapter({ requestLogger: createDailyJsonlRequestLogger({
  content: 'full', allowWireBodies: true,
}) }))

const tools = new ToolRegistry()
tools.register(defineTool({
  name: 'calculate',
  description: 'Perform the requested multiplication. Use this instead of mental arithmetic.',
  parameters: {
    type: 'object',
    properties: { left: { type: 'number' }, right: { type: 'number' } },
    required: ['left', 'right'], additionalProperties: false,
  },
  parse: raw => {
    const value = raw as { left?: unknown; right?: unknown }
    if (typeof value.left !== 'number' || typeof value.right !== 'number') throw new Error('left and right must be numbers')
    return { left: value.left, right: value.right }
  },
  execute: ({ left, right }) => ({ product: left * right }),
}))

async function live(
  name: string,
  options: LiveModeOptions,
  prompt: string,
): Promise<AgentRunOutcome> {
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage(prompt) })
  let outcome: AgentRunOutcome | undefined
  console.log(`\n=== ${name} ===`)
  for await (const event of runAgent({
    ...options,
    config: { provider: 'codex', model: 'gpt-5.6-luna' },
    registry,
    tools,
    history,
    signal: AbortSignal.timeout(180_000),
    trace: { agentId: `live-${name}`, agentName: `Live ${name}` },
  } as Parameters<typeof runAgent>[0])) {
    print(event)
    if (event.type === 'agent-end') outcome = event.outcome
  }
  if (outcome === undefined) throw new Error(`${name} ended without an outcome`)
  console.log('outcome:', JSON.stringify(outcome, null, 2))
  return outcome
}

function print(event: AgentRunEvent): void {
  if (event.type === 'assistant-text') console.log(`[${event.phase}/${event.timing}] ${event.text}`)
  else if (event.type === 'tool-call') console.log(`[tool/call] ${event.call.toolName} ${event.call.rawArguments}`)
  else if (event.type === 'tool-result') console.log(`[tool/result] ${event.call.toolName} ${JSON.stringify(event.result.isError ? event.result.error : event.result.value)}`)
  else if (event.type === 'user-input-request') console.log(`[human/request] ${JSON.stringify(event.request.questions)}`)
  else if (event.type === 'user-input-response') console.log(`[human/response] ${JSON.stringify(event.response)}`)
}

await live(
  'basic',
  { mode: 'basic', maxTurns: 3 },
  'Use the calculate tool to compute 6 × 7, then answer with only the number.',
)

await live(
  'deep',
  { mode: 'deep', maxTurns: 5 },
  'Use the calculate tool to compute 8 × 9. Verify the tool result against the request, submit completion evidence, then answer concisely.',
)

const userInput = createUserInputBroker()
userInput.onRequest(request => {
  // Deliberately choose free-form rather than one of the suggested labels.
  userInput.resolve(request.requestId, {
    answers: Object.fromEntries(request.questions.map(question => [question.id, { answers: ['Ultra concise'] }])),
  })
})
await live(
  'deep-human-in-loop',
  { mode: 'deep-human-in-loop', userInput, maxTurns: 6 },
  'Before calculating, ask me which answer style I prefer and suggest choices. After my answer, use calculate for 11 × 12, self-check, submit completion evidence, and respond in that style.',
)
