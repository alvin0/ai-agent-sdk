import type { TrackedOperationKind } from './report.ts'

export const OPERATION_KINDS = Object.freeze([
  'turn', 'model-call', 'provider-attempt', 'tool', 'compaction', 'hook',
  'user-input', 'skill', 'memory', 'credential', 'integration',
] as const satisfies readonly TrackedOperationKind[])
