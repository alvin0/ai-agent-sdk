/** Internal compatibility exports for managed-team helpers. */
export {
  object, memberName, nonEmpty, boundedString, positiveInteger, stringArray, spawnContext, assertDependencyOffset,
} from './managed-validation.ts'
export {
  mergeTools, parseCloseTool, parseSpawnTool,
} from './managed-tool-input.ts'
export {
  completedHistoryPrefix,
} from './managed-history.ts'
export {
  abortable, combineSignals,
} from './managed-cancellation.ts'
export {
  normalizeWriteScope, scopesOverlap,
} from './managed-write-scopes.ts'
export {
  prefixWithinBytes, truncate,
} from './managed-report-text.ts'
export {
  errorMessage, asJson, SETTLED_WORKER_STATUS, failureOf, recordEvidence,
} from './managed-outcomes.ts'
export {
  managedTimeouts, managedRoles, managedControlPlane,
} from './managed-options.ts'
