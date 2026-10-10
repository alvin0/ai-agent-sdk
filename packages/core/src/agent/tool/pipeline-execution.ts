import type { ContentBlock } from '../../message/index.ts'
import { isJsonValue, type JsonObject, type JsonValue } from '../../primitives/index.ts'
import {
  renderJsonValue, type ToolExecutionResult, type ToolFailure, type ToolRunContext, type ToolSuccess,
} from './definition.ts'
import { TOOL_ERROR_CODES, ToolError, toolErrorDisposition } from './errors.ts'
import { bindNestedToolPort } from './nested.ts'
import type { AuthorizedToolCall } from './pipeline.ts'
import { messageOf, toolFailure } from './pipeline-support.ts'

export async function executeToolBody(call: AuthorizedToolCall, signal: AbortSignal): Promise<ToolExecutionResult> {
  const { context, tool } = call
  const extraContext: ContentBlock[] = []
  let concludes = false
  const runContext: ToolRunContext = {
    ...call.options.position,
    turn: context.turn, step: context.step, callId: context.callId,
    toolName: context.toolName, signal,
    ...(context.logger === undefined ? {} : { logger: context.logger }),
    concludeTurn: () => { concludes = true },
    addContext: content => {
      if (typeof content === 'string') extraContext.push({ type: 'text', text: content })
      else extraContext.push(...content)
    },
  }
  bindNestedToolPort(call, runContext)
  let value: JsonValue | undefined
  try {
    const returned = await tool.execute(context.args as never, runContext)
    value = returned === undefined ? undefined : returned
  } catch (error: unknown) {
    return executionFailure(error, signal, extraContext)
  }
  if (value !== undefined && !isJsonValue(value)) return toolFailure(
    `tool "${tool.name}" returned a value that is not lossless JSON; `
      + 'return plain objects, arrays, strings, finite numbers, booleans, or null',
    TOOL_ERROR_CODES.INVALID_RESULT,
  )
  return renderToolResult(call, { value, extraContext, concludes: () => concludes })
}
function renderToolResult(call: AuthorizedToolCall, state: {
  value: JsonValue | undefined
  extraContext: readonly ContentBlock[]
  concludes: () => boolean
}): ToolSuccess {
  const { tool, context } = call
  const { value, extraContext, concludes } = state
  let content: readonly ContentBlock[]
  let meta: JsonObject | undefined
  try {
    content = tool.render === undefined ? renderJsonValue(value) : tool.render(value, context.args as never)
    meta = tool.meta?.(value, context.args as never)
  } catch (error: unknown) {
    return {
      isError: false, value, content: renderJsonValue(value),
      ...extraContext.length === 0 ? {} : { additionalContext: extraContext },
      ...concludes() ? { concludesTurn: true as const } : {},
      meta: { renderError: messageOf(error) },
    } satisfies ToolSuccess
  }
  return {
    isError: false, value, content,
    ...meta === undefined ? {} : { meta },
    ...extraContext.length === 0 ? {} : { additionalContext: extraContext },
    ...concludes() ? { concludesTurn: true as const } : {},
  } satisfies ToolSuccess
}

function executionFailure(error: unknown, signal: AbortSignal, extraContext: readonly ContentBlock[]): ToolFailure {
  if (toolErrorDisposition(error) === 'fatal') throw error
  if (signal.aborted && !(error instanceof ToolError)) return toolFailure('the call was cancelled',
    TOOL_ERROR_CODES.ABORTED)
  return toolFailure(messageOf(error), error instanceof ToolError ? error.code : TOOL_ERROR_CODES.FAILED, {
    ...extraContext.length === 0 ? {} : { additionalContext: extraContext },
  })
}
