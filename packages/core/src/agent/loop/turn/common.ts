import type { StreamChunk } from '../../../stream/index.ts'
import { utf8ByteLength } from '../../../primitives/utf8.ts'
export { messageOf, errorCodeOf } from '../../../errors/thrown-value.ts'

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('value is not JSON serializable')
  return utf8ByteLength(serialized)
}
export function modelFailureFinish(message: string, code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}
export function modelAbortedFinish(message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
}
export function codedRuntimeError(message: string, code: string, cause: unknown): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string }
  error.code = code
  return error
}
export function now(): string { return new Date().toISOString() }
