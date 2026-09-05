import {
  ModelRegistry, defineAgent, defineSkill, defineTool,
  type AgentCompactionOptions, type CapabilityIdentityConflict, type NativeToolSchema,
} from '@ai-agent-sdk/core'
import type {
  AgentInvocationOptions, AgentRuntimeLimits, AgentSessionSnapshot,
  CapabilityIdentityConflict as AgentCapabilityIdentityConflict,
  SkillResourceSummary, ToolRunContext,
} from '@ai-agent-sdk/core/agent'
import { ModelRegistry as ProviderModelRegistry } from '@ai-agent-sdk/core/provider'

const identityConflict: CapabilityIdentityConflict = {
  namespace: 'tool-name', key: '[redacted]', firstIndex: 0, secondIndex: 1,
}
const agentIdentityConflict: AgentCapabilityIdentityConflict = identityConflict
void agentIdentityConflict
const providerRegistry: InstanceType<typeof ProviderModelRegistry> = new ModelRegistry()
void providerRegistry

const resources = [{ path: 'guides/start.md', sizeChars: 12 }] satisfies readonly SkillResourceSummary[]
const skill = defineSkill({
  id: 'installed-author-skill',
  name: 'Installed author skill',
  description: 'Proves the complete skill author surface remains installed.',
  whenToUse: 'Use for the packed consumer compile.',
  instructions: 'Read the guide.',
  resources: { 'guides/start.md': 'Start here.' },
  resourceManifest: resources,
  invocation: { modelInvocable: true, userInvocable: false },
  source: 'installed-consumer',
  provider: 'inline',
  resourceBase: { kind: 'opaque', value: 'fixture' },
  path: 'skills/installed/SKILL.md',
  metadata: { audience: 'test' },
})

const tool = defineTool({
  name: 'installed_tool',
  description: 'Proves parse, execute, render, metadata, timeout and context controls.',
  parameters: { type: 'object', required: ['value'] },
  parse(raw): { value: string } {
    if (typeof raw !== 'object' || raw === null || typeof Reflect.get(raw, 'value') !== 'string') {
      throw new TypeError('value is required')
    }
    return { value: Reflect.get(raw, 'value') as string }
  },
  execute(args, context: ToolRunContext) {
    context.signal.throwIfAborted()
    context.addContext('installed context')
    context.concludeTurn()
    return { value: args.value }
  },
  render(value, args) {
    return [{ type: 'text', text: `${args.value}:${String(value !== undefined)}` }]
  },
  meta(_value, args) { return { inputLength: args.value.length } },
  timeoutMs: 1_000,
  isConcurrencySafe: () => true,
})

const nativeTools = [{
  type: 'native', name: 'web-search', searchContextSize: 'high', maxUses: 2,
}] satisfies readonly NativeToolSchema[]
const compaction = {
  auto: true, maxInputTokens: 8_000, retainTokens: 2_000, maxSummaryTokens: 512,
} satisfies AgentCompactionOptions

const definition = defineAgent({
  id: 'installed-author-agent', provider: 'fixture', model: 'fixture-model',
  instructions: 'Use the installed author surfaces.', tools: [tool], nativeTools,
  skills: [skill], compaction, maxTurns: 7, maxToolCalls: 11,
})
declare const registry: ModelRegistry
const runtimeLimits = {
  modelTimeoutMs: 2_000, maxModelRequestBytes: 32_768, maxModelStreamEvents: 128,
  maxToolDurationMs: 1_000, maxParallelToolCalls: 2, observerTimeoutMs: 1_000,
} satisfies AgentRuntimeLimits
const session = definition.createSession({ registry, runtimeLimits })
const snapshot = session.snapshot() satisfies AgentSessionSnapshot
const resumed = definition.resumeSession({ registry, snapshot, compaction: false })
const invocation = { signal: new AbortController().signal, onEvent: async () => undefined } satisfies AgentInvocationOptions

void resumed.compact(invocation)
void resumed.stream('continue', invocation)
