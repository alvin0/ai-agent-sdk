import type { RuntimeAgent, RuntimeAgentSessionOptions } from '@alvin0/ai-agent-sdk-core'
import { defineActionFusion, createMemorySpillStore, createModelEvidenceReducer } from '@alvin0/ai-agent-sdk-core/tools'
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'

const fusion = defineActionFusion<{ patch: string }>({ name: 'edit_and_test', description: 'Edit then test',
  parameters: { type: 'object' }, steps: [
    { tool: 'apply_patch', arguments: args => ({ patch: args.patch }) },
    { tool: 'test', arguments: (_args, values) => ({ previous: values[0] ?? null }) },
  ] })
const optimizer = createContextOptimizer({ store: createMemorySpillStore(),
  reducer: createModelEvidenceReducer({ generate: async request => {
    request.signal.throwIfAborted(); return '{"status":"unknown","lines":[]}'
  } }) })
const options: RuntimeAgentSessionOptions = {
  hooks: optimizer.wrapHooks({ beforeStep: () => ({ kind: 'proceed' }) }), experimentalPrograms: [fusion.grant],
}
export function mount(agent: RuntimeAgent) { return agent.createSession(options) }
