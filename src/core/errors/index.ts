/** The error taxonomy: what is thrown, and its serializable twin. */

export {
  AgentSdkError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  MISSING_CREDENTIAL_CODE,
  QUOTA_EXCEEDED_CODE,
  errorChain,
  isAgentSdkError,
  isContextWindowExceededError,
  isQuotaExceededError,
} from './agent-sdk-error.ts'
export { normalizeModelFailure, type ModelFailure } from './failure.ts'
export {
  MODEL_ERROR_CODES,
  ModelError,
  REGISTRY_ERROR_CODES,
  type ModelErrorOptions,
} from './model-error.ts'
