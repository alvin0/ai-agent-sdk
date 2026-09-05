import { safeErrorRecord, type SafeErrorRecord } from '../../observation/index.ts'

export function accountingError(message: string, code: string, cause?: unknown): SafeErrorRecord {
  return Object.freeze({
    type: 'AgentAccountingError',
    message,
    code,
    ...(cause === undefined ? {} : { causeTypes: safeErrorRecord(cause).causeTypes ?? [safeErrorRecord(cause).type] }),
  })
}
