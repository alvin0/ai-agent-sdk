import type { Message } from '../../../message/index.ts'
import type { StepDecision } from '../events.ts'

// Session maintenance may refresh the hook's context after queue delivery or
// compaction. Keep that projection's input identity out of the public decision
// and provider payload; otherwise a deliberately filtered input can be mistaken
// for unseen late steering and reinserted by model-round.
const sources = new WeakMap<StepDecision, ReadonlySet<Message['id']>>()

export function bindStepProjectionSources<T extends StepDecision>(decision: T, messages: readonly Message[]): T {
  if (decision.kind === 'proceed' && decision.messages !== undefined) {
    // Applications may reuse a frozen decision across concurrent sessions.
    // Each preparation owns its identity baseline independently.
    const bound = { ...decision } as T
    sources.set(bound, new Set(messages.map(message => message.id)))
    return bound
  }
  return decision
}

export function stepProjectionSources(decision: StepDecision): ReadonlySet<Message['id']> | undefined {
  return sources.get(decision)
}
