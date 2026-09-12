import { captureOutputFormat } from '../../agent/define/output-format.ts'
import { objectValue, optionalAbortSignal, ownData } from '../common/data.ts'
import { captureAdditionalInstructions } from './instructions.ts'
import { captureToolDefinitions } from '../../agent/tool/capture.ts'
import {
  captureApprovalBroker, captureInterceptors, captureRuntimeContextSections, captureSpillStore,
  captureTurnHooks, captureUsagePolicy, captureUserInputBroker,
} from './policy.ts'
import type { RuntimeAgentInvocationOptions, RuntimeAgentSessionOptions } from './types.ts'
import { ReasoningEffortId } from '../../primitives/brand.ts'
import { resolveAgentModel } from '../provider/model-selection.ts'
import type { ModelTarget, ProviderSelection } from '../provider/types.ts'
import { captureToolSources } from '../tool-source/definition.ts'
import { captureMemoryBinding } from '../memory/definition.ts'
import { captureRuntimeSkillSources } from '../skill-provider/definition.ts'

const KEYS = new Set(['signal', 'additionalInstructions', 'onEvent', 'imagePolicy', 'documentPolicy',
  'structuredOutput', 'includeTraceEvents', 'model', 'effort', 'maxTokens'])
const SESSION_KEYS = new Set(['conversationId', 'tools', 'toolSources', 'skills', 'memory', 'skillCwd',
  'userInput', 'approvals', 'spillStore', 'interceptors', 'contextSections', 'hooks', 'usagePolicy', 'historyLimits',
  'ledgerLimits',
  'eventBufferLimits', 'runtimeLimits', 'compaction'])

export interface CapturedInvocationOptions {
  /** Already resolved against the configured routes; a full target, never route-only. */
  readonly model?: ModelTarget
  readonly effort?: ReturnType<typeof ReasoningEffortId>
  readonly maxTokens?: number
  readonly structuredOutput?: NonNullable<RuntimeAgentInvocationOptions['structuredOutput']>
  readonly imagePolicy?: 'strict' | 'project'
  readonly documentPolicy?: 'strict' | 'project'
  readonly signal?: AbortSignal
  readonly additionalInstructions?: string
  readonly includeTraceEvents?: boolean
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
  const contextSections = captureRuntimeContextSections(value.contextSections)
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
    ...(contextSections === undefined ? {} : { contextSections }),
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

/**
 * Capture one invocation's options, resolving any model override eagerly.
 *
 * The resolution happens HERE, at the entry of `run`/`stream`, so an unknown
 * route or a route with no default fails before an operation lease, a history
 * append, or a single byte of provider traffic — the same guarantee the agent
 * binding gives, on the same error codes.
 * @param input - caller-supplied invocation options.
 * @param selection - configured provider routes to resolve an override against.
 */
export function captureInvocationOptions(
  input: unknown,
  selection?: ProviderSelection,
): CapturedInvocationOptions {
  if (input === undefined) return Object.freeze({})
  const source = objectValue(input)
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !KEYS.has(key))) {
    throw new TypeError('Runtime invocation options contain unsupported fields')
  }
  const structured = ownData(source, 'structuredOutput', false)
  let structuredOutput: RuntimeAgentInvocationOptions['structuredOutput']
  if (structured !== undefined) {
    const output = objectValue(structured), schema = objectValue(ownData(output, 'schema'))
    const parse = ownData(schema, 'parse')
    if (typeof parse !== 'function') throw new TypeError('structuredOutput schema requires a synchronous parser')
    const format = captureOutputFormat({ type: 'json_schema', name: ownData(output, 'name') as string,
      schema: ownData(schema, 'jsonSchema') as import('../../primitives/index.ts').JsonObject })!
    if (format.type !== 'json_schema') throw new TypeError('structuredOutput requires JSON Schema')
    structuredOutput = Object.freeze({ name: format.name, schema: Object.freeze({ jsonSchema: format.schema,
      parse: parse.bind(schema) as (value: unknown) => import('../../primitives/index.ts').JsonValue }) })
  }
  const imagePolicy = ownData(source, 'imagePolicy', false)
  if (imagePolicy !== undefined && imagePolicy !== 'strict' && imagePolicy !== 'project') throw new TypeError('imagePolicy must be strict or project')
  const documentPolicy = ownData(source, 'documentPolicy', false)
  if (documentPolicy !== undefined && documentPolicy !== 'strict' && documentPolicy !== 'project') throw new TypeError('documentPolicy must be strict or project')
  const signal = optionalAbortSignal(ownData(source, 'signal', false))
  const additionalInstructions = captureAdditionalInstructions(ownData(source, 'additionalInstructions', false))
  const onEvent = ownData(source, 'onEvent', false)
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Runtime event observer must be callable')
  const includeTraceEvents = ownData(source, 'includeTraceEvents', false)
  if (includeTraceEvents !== undefined && typeof includeTraceEvents !== 'boolean') throw new TypeError('includeTraceEvents must be boolean')
  const requested = ownData(source, 'model', false)
  if (requested !== undefined && selection === undefined) {
    throw new TypeError('Runtime invocation model override is unavailable on this session')
  }
  const model = requested === undefined ? undefined : resolveAgentModel(selection!, requested)
  const rawEffort = ownData(source, 'effort', false)
  if (rawEffort !== undefined && typeof rawEffort !== 'string') throw new TypeError('Runtime invocation effort must be a string')
  const effort = rawEffort === undefined ? undefined : ReasoningEffortId(rawEffort)
  const maxTokens = ownData(source, 'maxTokens', false)
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1)) {
    throw new TypeError('Runtime invocation maxTokens must be a positive safe integer')
  }
  return Object.freeze({ ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(maxTokens === undefined ? {} : { maxTokens: maxTokens as number }),
    ...(structuredOutput === undefined ? {} : { structuredOutput }), ...(imagePolicy === undefined ? {} : { imagePolicy }),
    ...(documentPolicy === undefined ? {} : { documentPolicy }), ...(signal === undefined ? {} : { signal }),
    ...(additionalInstructions === undefined ? {} : { additionalInstructions }),
    ...(includeTraceEvents === undefined ? {} : { includeTraceEvents }),
    ...(onEvent === undefined ? {} : { onEvent: onEvent as NonNullable<RuntimeAgentInvocationOptions['onEvent']> }) })
}
