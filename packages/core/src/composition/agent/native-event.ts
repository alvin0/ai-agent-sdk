import type { NativeToolCallBlock } from '../../message/content.ts'
import type { JsonValue } from '../../primitives/index.ts'
import { cloneJsonValue } from '../common/json-data.ts'

export interface ProjectedNativeToolEvent {
  readonly type: 'assistant-native-tool'
  readonly callId: string
  readonly provider: string
  readonly name: string
  readonly status: 'started' | 'completed' | 'failed' | 'unknown'
  readonly input?: JsonValue
  readonly output?: JsonValue
}

/** Detach optional provider payloads into the same bounded JSON envelope used by composition metadata. */
export function projectNativeToolEvent(
  call: NativeToolCallBlock,
  provider: string,
): ProjectedNativeToolEvent {
  const input = optionalPayload(call.arguments)
  const output = call.content.length === 0 ? undefined : optionalPayload(call.content)
  return {
    type: 'assistant-native-tool', callId: call.id, provider, name: call.name,
    status: nativeStatus(call.status),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  }
}

function optionalPayload(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  try { return cloneJsonValue(value) } catch { return undefined }
}

function nativeStatus(value: string | undefined): ProjectedNativeToolEvent['status'] {
  return value === 'started' || value === 'completed' || value === 'failed' ? value : 'unknown'
}
