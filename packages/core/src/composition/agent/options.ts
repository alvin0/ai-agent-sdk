import { captureProgramGrants } from '../../agent/tool/nested.ts'
import { captureOutputFormat } from '../../agent/define/output-format.ts'
import { objectValue, optionalAbortSignal, ownData } from '../common/data.ts'
import { captureAdditionalInstructions } from './instructions.ts'
import { captureToolDefinitions } from '../../agent/tool/capture.ts'
import {
  captureApprovalBroker, captureInterceptors, captureRuntimeContextSections, captureSpillStore,
  captureTurnHooks, captureUsagePolicy, captureUserInputBroker,
} from './policy.ts'
import type { RuntimeAgentInvocationOptions, RuntimeAgentSessionOptions } from './types.ts'
import { resolveAgentModel } from '../provider/model-selection.ts'
import type { ModelTarget, ProviderSelection } from '../provider/types.ts'
import { captureToolSources } from '../tool-source/definition.ts'
import { captureMemoryBinding } from '../memory/definition.ts'
import { captureRuntimeSkillSources } from '../skill-provider/definition.ts'

const KEYS = new Set(['signal', 'additionalInstructions', 'onEvent', 'imagePolicy', 'documentPolicy',
  'structuredOutput', 'includeTraceEvents', 'model', 'maxTokens'])
const SESSION_KEYS = new Set(['conversationId', 'tools', 'toolSources', 'skills', 'memory', 'skillCwd',
  'userInput', 'approvals', 'spillStore', 'experimentalPrograms', 'interceptors', 'contextSections', 'hooks',
    'usagePolicy', 'historyLimits',
  'ledgerLimits',
  'eventBufferLimits', 'runtimeLimits', 'compaction'])

export interface CapturedInvocationOptions {
  /** Already resolved against the configured routes; a full target, never route-only. */
  readonly model?: ModelTarget
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
  const value = Object.fromEntries([...SESSION_KEYS].map(key => [key, ownData(source, key,
    false)])) as Record<string, unknown>
  const tools = value.tools === undefined ? undefined : captureToolDefinitions(value.tools)
  const toolSources = value.toolSources === undefined ? undefined : captureToolSources(value.toolSources)
  const approvals = captureApprovalBroker(value.approvals)
  const spillStore = captureSpillStore(value.spillStore)
  const experimentalPrograms = value.experimentalPrograms === undefined
    ? undefined
    : Object.freeze([...captureProgramGrants(value.experimentalPrograms)].map(([tool,
      grant]) => Object.freeze({ tool, ...grant })))
  const userInput = captureUserInputBroker(value.userInput)
  const interceptors = captureInterceptors(value.interceptors)
  const contextSections = captureRuntimeContextSections(value.contextSections)
  const hooks = captureTurnHooks(value.hooks)
  const usagePolicy = captureUsagePolicy(value.usagePolicy)
  const memory = value.memory === false || value.memory === undefined
    ? value.memory
    : captureMemoryBinding(value.memory)
  const skills = value.skills === undefined ? undefined : captureRuntimeSkillSources(value.skills)
  return Object.freeze(definedFields({
    conversationId: value.conversationId as string, tools, toolSources, skills, memory,
    skillCwd: value.skillCwd as string, userInput, approvals, spillStore, experimentalPrograms,
    interceptors, contextSections, hooks, usagePolicy,
    historyLimits: value.historyLimits as NonNullable<RuntimeAgentSessionOptions['historyLimits']>,
    ledgerLimits: value.ledgerLimits as NonNullable<RuntimeAgentSessionOptions['ledgerLimits']>,
    eventBufferLimits: value.eventBufferLimits as NonNullable<RuntimeAgentSessionOptions['eventBufferLimits']>,
    runtimeLimits: value.runtimeLimits as NonNullable<RuntimeAgentSessionOptions['runtimeLimits']>,
    compaction: value.compaction as NonNullable<RuntimeAgentSessionOptions['compaction']>,
  }))
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
  const structuredOutput = captureStructuredOutput(structured)
  const imagePolicy = captureInputPolicy(ownData(source, 'imagePolicy', false), 'imagePolicy')
  const documentPolicy = captureInputPolicy(ownData(source, 'documentPolicy', false), 'documentPolicy')
  const signal = optionalAbortSignal(ownData(source, 'signal', false))
  const additionalInstructions = captureAdditionalInstructions(ownData(source, 'additionalInstructions', false))
  const onEvent = ownData(source, 'onEvent', false)
  if (onEvent !== undefined
    && typeof onEvent !== 'function') throw new TypeError('Runtime event observer must be callable')
  const includeTraceEvents = ownData(source, 'includeTraceEvents', false)
  if (includeTraceEvents !== undefined
    && typeof includeTraceEvents !== 'boolean') throw new TypeError('includeTraceEvents must be boolean')
  const requested = ownData(source, 'model', false)
  if (requested !== undefined && selection === undefined) {
    throw new TypeError('Runtime invocation model override is unavailable on this session')
  }
  const model = requested === undefined ? undefined : resolveAgentModel(selection!, requested)
  const maxTokens = captureMaxTokens(ownData(source, 'maxTokens', false))
  return Object.freeze(definedFields({
    model, maxTokens, structuredOutput, imagePolicy, documentPolicy, signal, additionalInstructions,
    includeTraceEvents,
    onEvent: onEvent as NonNullable<RuntimeAgentInvocationOptions['onEvent']>,
  }))
}

function captureStructuredOutput(structured: unknown): RuntimeAgentInvocationOptions['structuredOutput'] {
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
  return structuredOutput
}

function captureInputPolicy(value: unknown, field: string): 'strict' | 'project' | undefined {
  if (value !== undefined && value !== 'strict' && value !== 'project') {
    throw new TypeError(`${field} must be strict or project`)
  }
  return value
}

function captureMaxTokens(maxTokens: unknown): number | undefined {
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1)) {
    throw new TypeError('Runtime invocation maxTokens must be a positive safe integer')
  }
  return maxTokens as number | undefined
}

type DefinedFields<Value> = { [Key in keyof Value]?: Exclude<Value[Key], undefined> }

/** Preserve option presence without exposing properties whose value is undefined. */
function definedFields<const Value extends Record<string, unknown>>(value: Value): DefinedFields<Value> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as DefinedFields<Value>
}
