export const DEFAULT_MAX_SSE_EVENTS = 100_000
export const DEFAULT_MAX_SSE_EVENT_CHARS = 1_048_576
export const DEFAULT_SSE_TEARDOWN_TIMEOUT_MS = 30_000

export interface SseParserLimits {
  readonly maxEvents: number
  readonly maxEventChars: number
}
