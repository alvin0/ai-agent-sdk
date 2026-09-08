import { objectValue, optionalAbortSignal, ownData } from '../common/data.ts'
import { captureAdditionalInstructions } from './instructions.ts'
import { captureToolDefinitions } from '../../agent/tool/capture.ts'
import {
  captureApprovalBroker, captureInterceptors, captureSpillStore, captureTurnHooks, captureUsagePolicy,
  captureUserInputBroker,
} from './policy.ts'
import type { RuntimeAgentInvocationOptions, RuntimeAgentSessionOptions } from './types.ts'
import { captureToolSources } from '../tool-source/definition.ts'
import { captureMemoryBinding } from '../memory/definition.ts'
import { captureRuntimeSkillSources } from '../skill-provider/definition.ts'

const KEYS = new Set(['signal', 'additionalInstructions', 'onEvent'])
const SESSION_KEYS = new Set(['conversationId', 'tools', 'toolSources', 'skills', 'memory', 'skillCwd',
  'userInput', 'approvals', 'spillStore', 'interceptors', 'hooks', 'usagePolicy', 'historyLimits',
  'ledgerLimits',
  'eventBufferLimits', 'runtimeLimits', 'compaction'])

export interface CapturedInvocationOptions {
  readonly signal?: AbortSignal
  readonly additionalInstructions?: string
  readonly onEvent?: NonNullable<RuntimeAgentInvocationOptions['onEvent']>
}

/** Capture all session option references before any agent or capability method can run. */
export function captureRuntimeSessionOptions(input: unknown): RuntimeAgentSessionOptions {
  if (input === undefined) return Object.freeze({})
  const source = objectValue(input)
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !SESSION_KEYS.has(key))) {
    throw new TypeError('Runtime session options contain unsupported fields')
  }
  const value = Object.fromEntries([...SESSION_KEYS].map(key => [key, ownData(source, key, false)])) as Record<string, unknown>
  const tools = value.tools === undefined ? undefined : captureToolDefinitions(value.tools)
  const toolSources = value.toolSources === undefined ? undefined : captureToolSources(value.toolSources)
  const approvals = captureApprovalBroker(value.approvals)
  const spillStore = captureSpillStore(value.spillStore)
  const userInput = captureUserInputBroker(value.userInput)
  const interceptors = captureInterceptors(value.interceptors)
  const hooks = captureTurnHooks(value.hooks)
  const usagePolicy = captureUsagePolicy(value.usagePolicy)
  const memory = value.memory === false || value.memory === undefined
    ? value.memory
    : captureMemoryBinding(value.memory)
  const skills = value.skills === undefined ? undefined : captureRuntimeSkillSources(value.skills)
  return Object.freeze({
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId as string }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolSources === undefined ? {} : { toolSources }),
    ...(skills === undefined ? {} : { skills }),
    ...(memory === undefined ? {} : { memory }),
    ...(value.skillCwd === undefined ? {} : { skillCwd: value.skillCwd as string }),
    ...(userInput === undefined ? {} : { userInput }),
    ...(approvals === undefined ? {} : { approvals }),
    ...(spillStore === undefined ? {} : { spillStore }),
    ...(interceptors === undefined ? {} : { interceptors }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(usagePolicy === undefined ? {} : { usagePolicy }),
    ...(value.historyLimits === undefined ? {} : {
      historyLimits: value.historyLimits as NonNullable<RuntimeAgentSessionOptions['historyLimits']>,
    }),
    ...(value.ledgerLimits === undefined ? {} : {
      ledgerLimits: value.ledgerLimits as NonNullable<RuntimeAgentSessionOptions['ledgerLimits']>,
    }),
    ...(value.eventBufferLimits === undefined ? {} : {
      eventBufferLimits: value.eventBufferLimits as NonNullable<RuntimeAgentSessionOptions['eventBufferLimits']>,
    }),
    ...(value.runtimeLimits === undefined ? {} : {
      runtimeLimits: value.runtimeLimits as NonNullable<RuntimeAgentSessionOptions['runtimeLimits']>,
    }),
    ...(value.compaction === undefined ? {} : {
      compaction: value.compaction as NonNullable<RuntimeAgentSessionOptions['compaction']>,
    }),
  })
}

export function captureInvocationOptions(input: unknown): CapturedInvocationOptions {
  if (input === undefined) return Object.freeze({})
  const source = objectValue(input)
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !KEYS.has(key))) {
    throw new TypeError('Runtime invocation options contain unsupported fields')
  }
  const signal = optionalAbortSignal(ownData(source, 'signal', false))
  const additionalInstructions = captureAdditionalInstructions(ownData(source, 'additionalInstructions', false))
  const onEvent = ownData(source, 'onEvent', false)
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Runtime event observer must be callable')
  return Object.freeze({ ...(signal === undefined ? {} : { signal }),
    ...(additionalInstructions === undefined ? {} : { additionalInstructions }),
    ...(onEvent === undefined ? {} : { onEvent: onEvent as NonNullable<RuntimeAgentInvocationOptions['onEvent']> }) })
}
