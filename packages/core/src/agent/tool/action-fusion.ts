import type { JsonValue } from '../../primitives/index.ts'
import { defineTool, type ToolDefinition } from './definition.ts'
import { nestedToolPort, type ExperimentalProgramGrant } from './nested.ts'
import { ToolError } from './errors.ts'

/** A host-selected pipeline step. No model-generated commands are inferred. */
export interface ActionFusionStep<Args> {
  readonly tool: string
  readonly arguments: (args: Args, previous: readonly JsonValue[]) => JsonValue
  /** A successful tool can still report a failed build in its value. Stop here when false. */
  readonly accept?: (value: JsonValue) => boolean
}

/**
 * Create an exclusive fused tool and the scheduler grant it needs.
 * Register both the returned tool and its children; mount grant in experimentalPrograms.
 * Every child uses the normal policy, approval, budget, checkpoint and cancellation path.
 * Completed steps are not rolled back or automatically retried after a later failure.
 */
export function defineActionFusion<Args>(options: {
  readonly name: string
  readonly description: string
  readonly parameters: ToolDefinition<Args>['parameters']
  readonly parse?: ToolDefinition<Args>['parse']
  readonly steps: readonly ActionFusionStep<Args>[]
}): { readonly tool: ToolDefinition<Args>; readonly grant: ExperimentalProgramGrant } {
  if (!Array.isArray(options.steps) || options.steps.length < 1 || options.steps.length > 64) throw new RangeError('fusion requires 1..64 steps')
  const steps = Array.from(options.steps, step => {
    if (typeof step !== 'object' || step === null) throw new TypeError('fusion steps must be a dense list of objects')
    return Object.freeze({ ...step })
  })
  if (steps.some(step => typeof step.tool !== 'string' || !step.tool.trim() || step.tool === options.name || typeof step.arguments !== 'function'
    || step.accept !== undefined && typeof step.accept !== 'function')) {
    throw new TypeError('fusion steps require a distinct child tool and an arguments callback')
  }
  const tool = defineTool<Args>({
    name: options.name, description: options.description, parameters: options.parameters,
    ...options.parse === undefined ? {} : { parse: options.parse },
    async execute(args, context) {
      const port = nestedToolPort(context)
      if (port === undefined) throw ToolError.respondToModel('Mount the fusion grant in experimentalPrograms.', 'FUSION_GRANT_REQUIRED')
      const values: JsonValue[] = []
      const results: JsonValue[] = []
      for (const step of steps) {
        context.signal.throwIfAborted()
        let arguments_: JsonValue
        try { arguments_ = synchronous(step.arguments(args, Object.freeze([...values]))) }
        catch { return { ok: false, completedSteps: values.length, results, failedTool: step.tool,
          error: { code: 'FUSION_ARGUMENTS_FAILED', message: 'The host could not prepare this step; completed steps were not rolled back.' } } }
        const result = await port.call(step.tool, arguments_)
        if (!result.ok) return { ok: false, completedSteps: values.length, results,
          failedTool: step.tool, error: { code: result.code, message: result.message } }
        values.push(result.value)
        results.push({ tool: step.tool, value: result.value })
        let accepted = true
        try { accepted = step.accept === undefined || synchronous(step.accept(result.value)) === true }
        catch { accepted = false }
        if (!accepted) {
          return { ok: false, completedSteps: values.length, results, failedTool: step.tool, error: { code: 'FUSION_STEP_REJECTED', message: 'The step did not meet the host success condition.' } }
        }
      }
      return { ok: true, completedSteps: values.length, results }
    },
  })
  return Object.freeze({ tool, grant: Object.freeze({ tool: options.name,
    allow: Object.freeze([...new Set(steps.map(step => step.tool))]), maxCalls: steps.length }) })
}

/** Reject an async callback contract without leaving its rejection orphaned. */
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof Reflect.get(value, 'then') === 'function') {
    void Promise.resolve(value).catch(() => undefined)
    throw new TypeError('fusion arguments/accept callbacks must return synchronously')
  }
  return value
}
