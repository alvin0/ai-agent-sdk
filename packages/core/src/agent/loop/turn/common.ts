import type { StreamChunk } from '../../../stream/index.ts'

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('value is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
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
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
export function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined
}
export function now(): string { return new Date().toISOString() }
