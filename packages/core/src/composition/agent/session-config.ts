import { configureRuntimeSessionModel, type AgentSession } from '../../agent/define/session.ts'
import type { AgentTeamMemberOptions } from '../../agent/define/session/types.ts'
import type { CapturedToolSource } from '../tool-source/types.ts'
import { snapshotToolSources } from '../tool-source/snapshot.ts'
import { capabilityIdentityError } from '../identity/error.ts'
import { assertAgentIdentitySnapshot } from '../identity/agent.ts'
import { createRuntimeMemoryPersistence } from '../memory/run.ts'
import { validateMemoryResumeBinding } from '../memory/resume.ts'
import type { BoundRuntimeAgentDefinition } from './definition.ts'
import { captureRuntimeSessionOptions } from './options.ts'
import type { RuntimeAgentSessionOptions, RuntimeAgentSessionSnapshot } from './types.ts'
import type { RuntimeAgentHost } from './session-host.ts'

export interface RuntimeSessionContext {
  readonly snapshot?: RuntimeAgentSessionSnapshot
  readonly team?: AgentTeamMemberOptions
  readonly ownerSignal?: AbortSignal
}

export function createConfiguredSession(
  host: RuntimeAgentHost, definition: BoundRuntimeAgentDefinition,
  rawOptions: RuntimeAgentSessionOptions, context: RuntimeSessionContext,
) {
  const { snapshot, team } = context
  host.operations.assertActive()
  const options = captureRuntimeSessionOptions(rawOptions)
  assertSessionIdentity(definition, options)
  const memory = options.memory === false ? undefined : options.memory ?? definition.memory
  if (snapshot !== undefined) validateMemoryResumeBinding(snapshot, memory)
  const toolSources = combineToolSources(definition.toolSources, options.toolSources ?? [])
  const limits = options.runtimeLimits
  const { maxSteps: _maxSteps, maxToolCalls: _maxToolCalls, ...agentRuntimeLimits } = limits ?? {}
  const selected = selectedDefinition(definition, limits)
  const shared = { registry: host.registry, observation: host.observation, observationResource: host.resource,
    ...sessionCapabilityFields(options), ...sessionExecutionFields(options),
    ...sessionLimitFields(options, team, agentRuntimeLimits),
  }
  const session = snapshot === undefined
    ? selected.createSession({ ...shared,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }) })
    : selected.resumeSession({ ...shared, snapshot })
  configureSessionBinding(host, definition, session, {
    toolSources, memory, memoryOperationTimeoutMs: agentRuntimeLimits.memoryOperationTimeoutMs,
  })
  return { session, observerTimeoutMs: limits?.observerTimeoutMs }
}

function selectedDefinition(definition: BoundRuntimeAgentDefinition,
  limits: RuntimeAgentSessionOptions['runtimeLimits']) {
  return limits?.maxSteps === undefined && limits?.maxToolCalls === undefined
    ? definition.legacy : definition.legacy.with({
      ...(limits.maxSteps === undefined ? {} : { maxTurns: limits.maxSteps }),
      ...(limits.maxToolCalls === undefined ? {} : { maxToolCalls: limits.maxToolCalls }),
    })
}

function sessionCapabilityFields(options: RuntimeAgentSessionOptions) {
  return {
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.skills === undefined ? {} : { skills: options.skills as never }),
    ...(options.skillCwd === undefined ? {} : { skillCwd: options.skillCwd }),
    ...(options.userInput === undefined ? {} : { userInput: options.userInput }),
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    ...(options.spillStore === undefined ? {} : { spillStore: options.spillStore }),
  }
}

function sessionExecutionFields(options: RuntimeAgentSessionOptions) {
  return {
    ...(options.experimentalPrograms === undefined ? {} : { experimentalPrograms: options.experimentalPrograms }),
    ...(options.interceptors === undefined ? {} : { interceptors: options.interceptors }),
    ...(options.contextSections === undefined ? {} : { contextSections: options.contextSections }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.usagePolicy === undefined ? {} : { usagePolicy: options.usagePolicy }),
    ...(options.historyLimits === undefined ? {} : { historyLimits: options.historyLimits }),
  }
}

function sessionLimitFields(
  options: RuntimeAgentSessionOptions, team: AgentTeamMemberOptions | undefined,
  agentRuntimeLimits: Omit<NonNullable<RuntimeAgentSessionOptions['runtimeLimits']>, 'maxSteps' | 'maxToolCalls'>,
) {
  return {
    ...(options.ledgerLimits === undefined ? {} : { ledgerLimits: options.ledgerLimits }),
    ...(options.eventBufferLimits === undefined ? {} : { eventBufferLimits: options.eventBufferLimits }),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
    ...(team === undefined ? {} : { team }),
    ...(Object.keys(agentRuntimeLimits).length === 0 ? {} : { runtimeLimits: agentRuntimeLimits }),
  }
}

function configureSessionBinding(
  host: RuntimeAgentHost, definition: BoundRuntimeAgentDefinition, session: AgentSession,
  input: { readonly toolSources: readonly CapturedToolSource[];
    readonly memory: BoundRuntimeAgentDefinition['memory']; readonly memoryOperationTimeoutMs: number | undefined },
): void {
  configureRuntimeSessionModel(session, { provider: definition.model.provider, model: definition.model.id,
    ...(definition.effort === undefined ? {} : { reasoningEffort: definition.effort }),
    ...(definition.maxTokens === undefined ? {} : { maxTokens: definition.maxTokens }),
    logger: correlation => host.observation.correlatedLogger(correlation, { scope: 'sdk.agent.run' }),
    ...(input.toolSources.length === 0 ? {} : {
      prepareTools: (signal, logger, occupiedNames) => snapshotToolSources(
        input.toolSources, signal, logger, occupiedNames,
      ),
    }),
    ...(input.memory === undefined ? {} : {
      memory: createRuntimeMemoryPersistence(
        input.memory,
        definition.legacy.id,
        input.memoryOperationTimeoutMs,
      ),
    }),
  })
}

function combineToolSources(
  defined: readonly CapturedToolSource[],
  additional: readonly CapturedToolSource[],
): readonly CapturedToolSource[] {
  const all = [...defined, ...additional]
  const seen = new Map<string, number>()
  for (const [index, source] of all.entries()) {
    const first = seen.get(source.id)
    if (first !== undefined) throw capabilityIdentityError(
      'TOOL_SOURCE_ID_CONFLICT', 'tool-source-id', first, index,
    )
    seen.set(source.id, index)
  }
  return Object.freeze(all)
}


function assertSessionIdentity(definition: BoundRuntimeAgentDefinition, options: RuntimeAgentSessionOptions): void {
  assertAgentIdentitySnapshot({
    tools: [...definition.legacy.tools, ...options.tools ?? []],
    nativeTools: definition.legacy.nativeTools,
    skills: [...definition.legacy.skills, ...options.skills ?? []] as never,
    ...(definition.legacy.skillIds === undefined ? {} : { allowedSkillIds: definition.legacy.skillIds }),
  })
}
