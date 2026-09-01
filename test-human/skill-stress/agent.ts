import type { DefinedAgent } from '../../src/agent/define/definition.ts'
import { defineAgent } from '../../src/agent/define/definition.ts'
import type { AgentCompactionOptions } from '../../src/agent/memory/compaction-config.ts'
import type { AgentMode } from '../../src/agent/mode/run-agent.ts'
import { fileSystemSkills } from '../../src/agent/skill/filesystem.ts'
import { ModelRegistry } from '../../src/core/runtime/registry.ts'
import { createAgentCodeToolRegistry } from '../agentcode/tools.ts'
import type { HumanCliConfig } from '../config.ts'
import { createHumanModelRegistry } from '../providers.ts'
import type { StressObserver } from './observer.ts'
import type { ScriptedStressAdapter } from './scripted-adapter.ts'
import type { SkillStressConfig } from './types.ts'

export interface StressAgentOptions {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly mode?: AgentMode
  readonly skillRoots: readonly string[]
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly compaction?: AgentCompactionOptions | false
  readonly observer?: StressObserver
}

export function createStressAgent(options: StressAgentOptions): DefinedAgent {
  return defineAgent({
    id: options.id,
    name: `Skill stress: ${options.id}`,
    description: 'Exercises progressive skill disclosure together with the real agent tool loop.',
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode ?? 'basic',
    maxTurns: options.maxTurns,
    maxToolCalls: options.maxToolCalls,
    commentary: 'concise',
    skills: options.skillRoots.length === 0 ? [] : [fileSystemSkills({
      roots: options.skillRoots.map((path, index) => ({ path, source: `stress-root-${index + 1}` })),
      includeProjectAgents: false,
      includeProjectDsh: false,
      includeUserAgents: false,
      ...(options.observer === undefined ? {} : {
        onIo: event => options.observer?.recordSkillIo(event),
      }),
    })],
    instructions: [
      'You are running an isolated SDK stress case.',
      'Use load_skill before applying a listed skill. Never inspect a skill root through workspace file tools.',
      'Use the provided workspace tools for all project reads and writes.',
      'Inspect tool results before claiming success and keep commentary concise.',
    ].join(' '),
    memory: {
      autoCaptureObjective: true,
      maxInjectedChars: 4_000,
      seed: [{ kind: 'constraint', content: 'All workspace mutations must stay inside the isolated stress workspace.' }],
    },
    compaction: options.compaction ?? false,
  })
}

export function createOfflineRegistry(adapter: ScriptedStressAdapter): ModelRegistry {
  const registry = new ModelRegistry()
  registry.registerAdapter(['stress'], adapter)
  return registry
}

export function createLiveRegistry(config: SkillStressConfig, requestLogRoot?: string): ModelRegistry {
  const humanConfig: HumanCliConfig = {
    provider: config.provider,
    model: config.model,
    mode: 'basic',
    scenario: 'chat',
    effort: config.effort,
    maxTurns: config.maxTurns,
    showReasoning: true,
    forceTool: false,
    logs: config.logs,
    help: false,
    dryRun: false,
  }
  return createHumanModelRegistry(humanConfig, {
    ...(requestLogRoot === undefined ? {} : { requestLogRoot }),
  })
}

export function createStressSession(
  agent: DefinedAgent,
  registry: ModelRegistry,
  workspace: string,
  observer: StressObserver,
) {
  return agent.createSession({
    registry,
    tools: createAgentCodeToolRegistry(workspace),
    skillCwd: workspace,
    hooks: {
      checkpoint(context) {
        if (context.kind === 'before-model-request') observer.recordRequest(context.request)
      },
    },
  })
}
