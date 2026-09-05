/** Live smoke for provider-native web search through the real Codex Responses route. */
import { History } from '@ai-agent-sdk/core/agent'
import { runTurn } from '@ai-agent-sdk/core/agent'
import type { AgentEvent } from '@ai-agent-sdk/core/agent'
import { createTextMessage } from '@ai-agent-sdk/core'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { codexNodeAdapter as codexAdapter } from '@ai-agent-sdk/auth-node/codex'
import { createDailyJsonlRequestLogger } from '@ai-agent-sdk/observability-node/diagnostic'

const registry = new ModelRegistry()
registry.registerAdapter(['codex'], codexAdapter({
  requestLogger: createDailyJsonlRequestLogger({ content: 'full', allowWireBodies: true }),
}))

const history = new History()
history.append({
  kind: 'user',
  message: createTextMessage(
    'Search the web for the official OpenAI developer page for GPT-5.6 and reply with its page title and URL.',
  ),
})

const events: AgentEvent[] = []
for await (const event of runTurn({
  registry,
  config: {
    provider: 'codex', model: 'gpt-5.6-luna',
    reasoningEffort: ReasoningEffortId('medium'),
  },
  history,
  nativeTools: [{ type: 'native', name: 'web-search', allowedDomains: ['openai.com'] }],
  toolChoice: { type: 'native', name: 'web-search' },
  commentary: 'concise',
  trace: { agentId: 'live-native-search', agentName: 'Live native search' },
  signal: AbortSignal.timeout(120_000),
})) {
  events.push(event)
  if (event.type === 'assistant-native-tool') {
    console.log(`[native] ${event.call.id} ${event.call.name} ${event.call.status ?? ''}`)
  }
  if (event.type === 'assistant-text') {
    console.log(`[${event.phase}] ${event.text}`)
    for (const annotation of history.messages().at(-1)?.content
      .flatMap(block => block.type === 'text' ? block.annotations ?? [] : []) ?? []) {
      if (annotation.type === 'url-citation') console.log(`[citation] ${annotation.title ?? ''} ${annotation.url}`)
    }
  }
}

const native = events.find(event => event.type === 'assistant-native-tool')
const terminal = events.findLast((event): event is Extract<AgentEvent, { type: 'turn-end' }> =>
  event.type === 'turn-end')
if (native === undefined) throw new Error('provider returned no native web-search node')
if (terminal?.outcome.reason.kind !== 'completed') {
  throw new Error(`native search did not complete: ${JSON.stringify(terminal?.outcome.reason)}`)
}
