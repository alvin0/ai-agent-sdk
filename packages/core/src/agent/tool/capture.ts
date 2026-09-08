import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { snapshotJsonObject } from '../../primitives/json-snapshot.ts'
import type { JsonObject, JsonValue } from '../../primitives/json.ts'
import type { ContentBlock } from '../../message/content.ts'
import type { ToolRunContext, ToolDefinition } from './definition.ts'
import { TOOL_DEFINITION_LIMITS, TOOL_REGISTRY_ERROR_CODES } from './config.ts'

type ToolMethod<Args extends readonly unknown[], Result> = (...args: Args) => Result

/** Capture one stable tool generation while preserving the caller object's receiver. */
export function captureToolDefinition<Args>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  try {
    if ((typeof input !== 'object' && typeof input !== 'function') || input === null) invalid()
    const receiver = input as object
    const name = boundedOwnText(receiver, 'name', TOOL_DEFINITION_LIMITS.nameBytes)
    const description = boundedOwnText(receiver, 'description', TOOL_DEFINITION_LIMITS.descriptionBytes)
    const parameters = snapshotJsonObject(ownData(receiver, 'parameters'), {
      maxObjectFields: TOOL_DEFINITION_LIMITS.schemaFields,
      maxArrayItems: TOOL_DEFINITION_LIMITS.schemaArrayItems,
      maxDepth: TOOL_DEFINITION_LIMITS.schemaDepth,
      maxNodes: TOOL_DEFINITION_LIMITS.schemaNodes,
      maxKeyBytes: TOOL_DEFINITION_LIMITS.schemaKeyBytes,
      maxBytes: TOOL_DEFINITION_LIMITS.schemaBytes,
    })
    const execute = method<[Args, ToolRunContext], Promise<JsonValue | void> | JsonValue | void>(receiver, 'execute', true)!
    const parse = method<[unknown], Args>(receiver, 'parse', false)
    const render = method<[JsonValue | undefined, Args], readonly ContentBlock[]>(receiver, 'render', false)
    const meta = method<[JsonValue | undefined, Args], JsonObject | undefined>(receiver, 'meta', false)
    const isConcurrencySafe = method<[Args], boolean>(receiver, 'isConcurrencySafe', false)
    const timeoutMs = optionalOwnData(receiver, 'timeoutMs')
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) invalid()
    // Fail-closed like every other flag here: only an exact `true` exempts a
    // tool from the turn budget, so a truthy accident cannot quietly widen it.
    const budgetExempt = optionalOwnData(receiver, 'budgetExempt')
    if (budgetExempt !== undefined && budgetExempt !== true) invalid()
    const maxOutputTokens = optionalOwnData(receiver, 'maxOutputTokens')
    if (maxOutputTokens !== undefined
      && (!Number.isSafeInteger(maxOutputTokens) || Number(maxOutputTokens) < 1)) invalid()
    return Object.freeze({ name, description, parameters,
      ...(parse === undefined ? {} : { parse }), execute,
      ...(render === undefined ? {} : { render }),
      ...(meta === undefined ? {} : { meta }),
      ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
      ...(isConcurrencySafe === undefined ? {} : { isConcurrencySafe }),
      ...(budgetExempt === undefined ? {} : { budgetExempt: true as const }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: Number(maxOutputTokens) }),
    })
  } catch (error) {
    if (error instanceof AgentSdkError && error.code === TOOL_REGISTRY_ERROR_CODES.INVALID_TOOL) throw error
    throw new AgentSdkError('tool definition is invalid', TOOL_REGISTRY_ERROR_CODES.INVALID_TOOL, { cause: error })
  }
}

/** Capture a dense bounded tool list atomically. */
export function captureToolDefinitions(value: unknown): readonly ToolDefinition[] {
  try {
    if (!Array.isArray(value)) invalid()
    const length = ownData(value, 'length')
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > TOOL_DEFINITION_LIMITS.tools) invalid()
    const captured: ToolDefinition[] = []
    for (let index = 0; index < Number(length); index++) {
      captured.push(captureToolDefinition(ownData(value, String(index)) as ToolDefinition))
    }
    return Object.freeze(captured)
  } catch (error) {
    if (error instanceof AgentSdkError && error.code === TOOL_REGISTRY_ERROR_CODES.INVALID_TOOL) throw error
    throw new AgentSdkError('tool definition list is invalid', TOOL_REGISTRY_ERROR_CODES.INVALID_TOOL, { cause: error })
  }
}

function ownData(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined || !('value' in descriptor)) invalid()
  return descriptor.value
}

function optionalOwnData(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined) return undefined
  if (!('value' in descriptor)) invalid()
  return descriptor.value
}

function boundedOwnText(source: object, key: string, maxBytes: number): string {
  const value = ownData(source, key)
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > maxBytes) invalid()
  return value
}

function method<Args extends readonly unknown[], Result>(
  receiver: object,
  key: string,
  required: boolean,
): ToolMethod<Args, Result> | undefined {
  const value: unknown = Reflect.get(receiver, key)
  if (value === undefined && !required) return undefined
  if (typeof value !== 'function') invalid()
  return (...args: Args): Result => Reflect.apply(value, receiver, args) as Result
}

function invalid(): never {
  throw new AgentSdkError('tool definition is invalid', TOOL_REGISTRY_ERROR_CODES.INVALID_TOOL)
}
