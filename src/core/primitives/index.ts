/** Framework-free building blocks with no dependencies of their own. */

export {
  MessageId,
  ProviderRequestId,
  ReasoningEffortId,
  ToolCallId,
  type Branded,
} from './brand.ts'
export { deepFreeze } from './freeze.ts'
export { isJsonValue, type JsonObject, type JsonValue } from './json.ts'
export { assertNever } from './never.ts'
