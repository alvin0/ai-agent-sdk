import { diagnosticErrorCode, ownErrorField } from './diagnostic-code.ts'

/** Preserve failure messages while containing throwing accessors and coercion. */
export function messageOf(error: unknown): string {
  try { return error instanceof Error ? String(error.message) : String(error) }
  catch { return '<unrenderable value>' }
}

/** Retain direct compatibility codes and recover stable codes from wrapped failures. */
export function errorCodeOf(error: unknown): string | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return undefined
  const direct = ownErrorField(error, 'code')
  return typeof direct === 'string' && direct !== 'AGENT_RUN_FAILED' ? direct : diagnosticErrorCode(error)
}
