/**
 * Adapter-private state kept on a {@link ReasoningBlock} so a reasoning item can
 * be echoed back byte-identically on the next request of a tool-use loop.
 */
export interface ResponsesReasoningState {
  /** Server-assigned item id. */
  id?: string
  /** Opaque encrypted chain of thought. */
  encryptedContent?: string
  /** Summary paragraphs, in order. */
  summary?: readonly string[]
}

