import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { arrayData, boundedText, objectValue, ownData } from '../common/data.ts'
import { capabilityIdentityError } from '../identity/error.ts'
import {
  TOOL_SOURCE_API_VERSION, TOOL_SOURCE_ERROR_CODES, TOOL_SOURCE_LIMITS,
} from './config.ts'
import type {
  CapturedToolSource, ToolCatalogSnapshot, ToolSource, ToolSourceDefinition, ToolSourceSnapshotOptions,
} from './types.ts'

/** Side-effect-free author helper; the caller's source remains mutable and borrowed. */
export function defineToolSource(definition: ToolSourceDefinition): ToolSource {
  return captureDefinition(definition, false)
}

export function captureToolSources(value: unknown): readonly CapturedToolSource[] {
  if (value === undefined) return Object.freeze([])
  const entries = arrayData(value, TOOL_SOURCE_LIMITS.sources)
  const captured = entries.map(entry => captureDefinition(entry, true))
  const seen = new Map<string, number>()
  captured.forEach((source, index) => {
    const first = seen.get(source.id)
    if (first !== undefined) throw capabilityIdentityError(
      TOOL_SOURCE_ERROR_CODES.ID_CONFLICT, 'tool-source-id', first, index,
    )
    seen.set(source.id, index)
  })
  return Object.freeze(captured)
}

function captureDefinition(value: unknown, requireMarker: boolean): CapturedToolSource {
  try {
    const source = objectValue(value)
    if (requireMarker) {
      const kind = ownData(source, 'kind')
      if (kind !== 'tool-source') throw new AgentSdkError('Tool source kind is unsupported', TOOL_SOURCE_ERROR_CODES.KIND_MISMATCH)
      const version = ownData(source, 'apiVersion')
      if (version !== TOOL_SOURCE_API_VERSION) throw new AgentSdkError('Tool source API version is unsupported', TOOL_SOURCE_ERROR_CODES.API_UNSUPPORTED)
    }
    const id = boundedText(ownData(source, 'id'), TOOL_SOURCE_LIMITS.identityBytes)
    let snapshotMethod: unknown
    try { snapshotMethod = Reflect.get(source, 'snapshot') }
    catch { throw new AgentSdkError('Tool source snapshot method could not be captured', TOOL_SOURCE_ERROR_CODES.SNAPSHOT_INVALID) }
    if (typeof snapshotMethod !== 'function') throw new AgentSdkError('Tool source snapshot method is invalid', TOOL_SOURCE_ERROR_CODES.SNAPSHOT_INVALID)
    const snapshot = (options: ToolSourceSnapshotOptions): ToolCatalogSnapshot =>
      Reflect.apply(snapshotMethod, source, [options]) as ToolCatalogSnapshot
    return Object.freeze({ kind: 'tool-source', apiVersion: TOOL_SOURCE_API_VERSION, id, snapshot })
  } catch (error) {
    if (error instanceof AgentSdkError) throw error
    throw new AgentSdkError('Tool source definition is invalid', TOOL_SOURCE_ERROR_CODES.SNAPSHOT_INVALID)
  }
}
