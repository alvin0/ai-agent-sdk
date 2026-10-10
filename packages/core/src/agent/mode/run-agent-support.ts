export {
  soleText,
  isMarkerPrefix,
  markerFallbackText,
  exactMarkerOutcome,
  keptAnswerOutcome,
  keptAnswerMessage,
  latestAssistantEntry,
  restoreKeptAnswer,
  taskChangedSince,
  invalidateDraftAfterSteering
} from './support/marker.ts'

export {
  completionTool,
  completionFromResult,
  parseCompletion,
  isAgentCompletionEligible
} from './support/completion.ts'

export {
  CombinedToolCatalog,
  combineTools,
  shieldControlTools
} from './support/control-catalog.ts'

export {
  validateUserResponse,
  parseUserInput,
  requestUserInputSchema
} from './support/user-input-contract.ts'

export {
  modeSystem,
  joinSystem
} from './support/instructions.ts'

export {
  record,
  requiredString,
  positiveFinite,
  validateAgentModeValue,
  validateAgentMaxTurns
} from './support/validation.ts'
