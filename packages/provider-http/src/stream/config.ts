export const DEFAULT_MAX_SSE_EVENTS = 100_000
export const DEFAULT_MAX_SSE_EVENT_CHARS = 1_048_576
/**
 * Per-event bound for a request that asks for a generated image. The finished
 * image arrives base64-encoded inside one event (a low-quality 1024px PNG is
 * already past 1 MiB), so the text default would end every such call. The
 * response-wide `maxResponseBytes` still bounds the whole stream.
 *
 * Kept below the agent history's default 16 MiB per-entry limit, with room for
 * the rest of the message, so one image the transport accepts fits a history
 * entry whole. Several that together do not are recorded without their bytes
 * (the core's `recordAssistant`); the host still receives them on the event.
 */
export const DEFAULT_MAX_SSE_IMAGE_EVENT_CHARS = 12 * 1_048_576
export const DEFAULT_SSE_TEARDOWN_TIMEOUT_MS = 30_000

export interface SseParserLimits {
  readonly maxEvents: number
  readonly maxEventChars: number
}
