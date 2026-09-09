import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import type { SdkLogger } from '../../logging/types.ts'
import { captureToolDefinitions } from '../../agent/tool/capture.ts'
import type { ToolDefinition } from '../../agent/tool/definition.ts'
import { boundedText, objectValue, ownData } from '../common/data.ts'
import { capabilityIdentityError, isCapabilityIdentityError } from '../identity/error.ts'
import { TOOL_SOURCE_ERROR_CODES, TOOL_SOURCE_LIMITS } from './config.ts'
import { beginCoreCapabilityOperation } from '../logging/capability.ts'
import type { CapturedToolSource, ToolSourceRunReference, ToolSourceRunSnapshot } from './types.ts'

/** Acquire one synchronous immutable generation from every source. */
export function snapshotToolSources(
  sources: readonly CapturedToolSource[],
  signal: AbortSignal,
  logger: SdkLogger,
  occupiedNames: readonly string[] = [],
): ToolSourceRunSnapshot {
  const tools: ToolDefinition[] = []
  const references: ToolSourceRunReference[] = []
  const names = new Map(occupiedNames.map((name, index) => [name, index]))
  let catalogBytes = 0
  for (const source of sources) {
    const sourceLogger = logger.child({ toolSourceId: source.id })
    const operation = beginCoreCapabilityOperation(sourceLogger, 'core-tool-source', 'snapshot')
    if (signal.aborted) {
      operation.abort()
      throw new AgentSdkError('Tool source snapshot was aborted', TOOL_SOURCE_ERROR_CODES.ABORTED)
    }
    let raw: unknown
    try { raw = source.snapshot({ signal, logger: sourceLogger }) }
    catch (error) {
      if (signal.aborted) operation.abort(); else operation.fail(error)
      if (signal.aborted) throw new AgentSdkError('Tool source snapshot was aborted', TOOL_SOURCE_ERROR_CODES.ABORTED, { cause: error })
      throw new AgentSdkError('Tool source snapshot failed', TOOL_SOURCE_ERROR_CODES.SNAPSHOT_FAILED, { cause: error })
    }
    if (raw instanceof Promise) {
      void raw.catch(() => undefined)
      operation.fail(new AgentSdkError('Tool source snapshot must be synchronous', TOOL_SOURCE_ERROR_CODES.SNAPSHOT_INVALID))
      throw new AgentSdkError('Tool source snapshot must be synchronous', TOOL_SOURCE_ERROR_CODES.SNAPSHOT_INVALID)
    }
    try {
      const snapshot = objectValue(raw)
      const revision = boundedText(ownData(snapshot, 'revision'), TOOL_SOURCE_LIMITS.revisionBytes)
      const captured = captureToolDefinitions(ownData(snapshot, 'tools'))
      if (tools.length + captured.length > TOOL_SOURCE_LIMITS.catalogTools) throw new TypeError('Tool catalog count exceeds its bound')
      catalogBytes += publicCatalogBytes(captured)
      if (catalogBytes > TOOL_SOURCE_LIMITS.catalogBytes) throw new TypeError('Tool catalog bytes exceed their bound')
      for (const tool of captured) {
        const index = occupiedNames.length + tools.length
        const first = names.get(tool.name)
        if (first !== undefined) throw capabilityIdentityError(
          TOOL_SOURCE_ERROR_CODES.NAME_CONFLICT, 'tool-name', first, index,
        )
        names.set(tool.name, index)
        tools.push(tool)
      }
      references.push(Object.freeze({ sourceId: source.id, revision }))
      operation.success()
    } catch (error) {
      operation.fail(error)
      if (isCapabilityIdentityError(error)) throw error
      throw new AgentSdkError('Tool source snapshot is invalid', TOOL_SOURCE_ERROR_CODES.SNAPSHOT_INVALID)
    }
  }
  return Object.freeze({ tools: Object.freeze(tools), references: Object.freeze(references) })
}

function publicCatalogBytes(tools: readonly ToolDefinition[]): number {
  const value = tools.map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
  }))
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
