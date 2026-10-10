/** Runtime agent identity and team ownership binding. */
import type {
  RuntimeAgentHost,
} from './session-host.ts'
import type {
  AgentInput,
} from '../../agent/define/session/types.ts'

import {
  AgentSdkError,
} from '../../errors/agent-sdk-error.ts'

import type {
  BoundRuntimeAgentDefinition,
} from './definition.ts'

import type {
  RuntimeAgent, RuntimeAgentInvocationOptions, RuntimeAgentSession,
  RuntimeAgentSessionOptions, RuntimeAgentSessionSnapshot,
} from './types.ts'

import type {
  AgentTeamMemberOptions,
} from '../../agent/define/session/types.ts'
import type {
  TeamSessionPort,
} from '../../agent/team/contracts.ts'
import {
  assertAgentIdentitySnapshot,
} from '../identity/agent.ts'
import {
  createRuntimeSession,
} from './session-value.ts'

interface RuntimeAgentBinding {
  readonly host: RuntimeAgentHost
  readonly definition: BoundRuntimeAgentDefinition
}

const runtimeAgentBindings = new WeakMap<RuntimeAgent, RuntimeAgentBinding>()

export function createRuntimeAgent(host: RuntimeAgentHost, definition: BoundRuntimeAgentDefinition): RuntimeAgent {
  const agent = Object.freeze({
    model: definition.model,
    generate(input: AgentInput, options?: RuntimeAgentInvocationOptions) { return createRuntimeSession(host,
      definition).run(input, options) },
    stream(input: AgentInput, options?: RuntimeAgentInvocationOptions) { return createRuntimeSession(host,
      definition).stream(input, options) },
    createSession(options?: RuntimeAgentSessionOptions) { return createRuntimeSession(host, definition, options) },
    resumeSession(snapshot: RuntimeAgentSessionSnapshot, options?: RuntimeAgentSessionOptions) {
      return createRuntimeSession(host, definition, options, { snapshot })
    },
  })
  runtimeAgentBindings.set(agent, Object.freeze({ host, definition }))
  return agent
}

export function createRuntimeTeamMemberSession(
  host: RuntimeAgentHost,
  agent: RuntimeAgent,
  options: RuntimeAgentSessionOptions,
  attachment: { readonly team: AgentTeamMemberOptions; readonly ownerSignal: AbortSignal },
): { readonly view: RuntimeAgentSession; readonly port: TeamSessionPort } {
  const binding = runtimeAgentBindings.get(agent)
  if (binding?.host !== host) throw new AgentSdkError(
    'Runtime team members must be agents from the same runtime', 'TEAM_AGENT_OWNERSHIP_INVALID',
  )
  const view = createRuntimeSession(host, binding.definition, options, {
    team: attachment.team, ownerSignal: attachment.ownerSignal,
  })
  return Object.freeze({ view, port: view.teamPort })
}

export function preflightRuntimeTeamMember(
  host: RuntimeAgentHost,
  agent: RuntimeAgent,
  options: RuntimeAgentSessionOptions,
  additionalToolNames: readonly string[],
): void {
  const binding = runtimeAgentBindings.get(agent)
  if (binding?.host !== host) throw new AgentSdkError(
    'Runtime team members must be agents from the same runtime', 'TEAM_AGENT_OWNERSHIP_INVALID',
  )
  assertAgentIdentitySnapshot({
    tools: [...binding.definition.legacy.tools, ...options.tools ?? []],
    nativeTools: binding.definition.legacy.nativeTools,
    skills: [...binding.definition.legacy.skills, ...options.skills ?? []] as never,
    ...(binding.definition.legacy.skillIds === undefined ? {} : {
      allowedSkillIds: binding.definition.legacy.skillIds,
    }),
    additionalToolNames,
  })
}

export function runtimeOwnsAgent(host: RuntimeAgentHost, agent: unknown): agent is RuntimeAgent {
  return typeof agent === 'object' && agent !== null && runtimeAgentBindings.get(agent as RuntimeAgent)?.host === host
}
