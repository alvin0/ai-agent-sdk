import { waitForSettlement } from '../../async/index.ts'
import type { ToolDefinition, ToolExecutionResult } from '../tool/definition.ts'
import { TOOL_ERROR_CODES, ToolError } from '../tool/errors.ts'
import type { NestedToolDescriptor, ProgramGrant } from '../tool/nested.ts'
import { outputSchemaSupported } from '../tool/output-schema.ts'
import { toolFailure } from '../tool/pipeline.ts'
import { messageOf, raceWithSignal, teardownFailure } from './tool-call-support.ts'

export function validPrograms(programs: ReadonlyMap<string, ProgramGrant> | undefined): ReadonlyMap<string,
  ProgramGrant> {
  const valid = new Map<string, ProgramGrant>()
  for (const [name, grant] of programs ?? []) {
    if (!Number.isSafeInteger(grant.maxCalls) || grant.maxCalls < 1) {
      throw new RangeError(`program "${name}" maxCalls must be a positive safe integer`)
    }
    const allow = Object.freeze([...new Set(grant.allow)])
    for (const target of allow) {
      if (typeof target !== 'string'
        || target.length === 0) throw new TypeError(`program "${name}" grants an invalid tool name`)
      // No recursion and no program-in-program: nested admission is one level.
      if (programs?.has(target) === true) throw new RangeError(`program "${name}" may not call program "${target}"`)
    }
    valid.set(name, Object.freeze({ allow, maxCalls: grant.maxCalls }))
  }
  return valid
}

export function describe(definition: ToolDefinition): NestedToolDescriptor {
  const schema = definition.experimentalOutputSchema
  return Object.freeze({
    name: definition.name, description: definition.description, parameters: definition.parameters,
    output: schemaDeclarationStatus(schema),
    ...schema === undefined ? {} : { outputSchema: schema },
  })
}

export function refuse(code: string,
  message: string): { readonly ok: false; readonly code: string; readonly message: string } {
  return Object.freeze({ ok: false, code, message })
}

/** Wait for one stage; on cancellation, give it the teardown allowance to settle. */
export async function settleWithin(
  pending: Promise<ToolExecutionResult>,
  signal: AbortSignal,
  teardownTimeoutMs: number,
  context: { readonly toolName: string; readonly stage: string },
): Promise<ToolExecutionResult> {
  try {
    return await raceWithSignal(pending, signal)
  } catch (error: unknown) {
    if (!signal.aborted) throw error
    if (!await waitForSettlement(pending, teardownTimeoutMs)) throw teardownFailure(context.toolName, context.stage,
      teardownTimeoutMs, error)
    return toolFailure('the call was cancelled', TOOL_ERROR_CODES.ABORTED)
  }
}

export function programSpanStatus(signal: AbortSignal, result: ToolExecutionResult): 'aborted' | 'error' | 'success' {
  if (signal.aborted) return 'aborted'
  return result.isError ? 'error' : 'success'
}

export function checkpointFailure(error: unknown): ToolExecutionResult {
  if (error instanceof ToolError && error.code === TOOL_ERROR_CODES.TEARDOWN_TIMEOUT) throw error
  return toolFailure(`history checkpoint failed: ${messageOf(error)}`, TOOL_ERROR_CODES.CHECKPOINT_FAILED)
}

function schemaDeclarationStatus(
  schema: ToolDefinition['experimentalOutputSchema'],
): 'unknown' | 'declared' | 'unsupported' {
  if (schema === undefined) return 'unknown'
  return outputSchemaSupported(schema) ? 'declared' : 'unsupported'
}

export function assertStageSettled(
  settled: boolean, context: { readonly toolName: string; readonly stage: string;
    readonly teardownTimeoutMs: number; readonly error: unknown },
): void {
  if (!settled) throw teardownFailure(context.toolName, context.stage, context.teardownTimeoutMs, context.error)
}
