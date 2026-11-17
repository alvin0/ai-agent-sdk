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
  /**
   * Raw reasoning paragraphs (`reasoning_text` parts), in order. Open-weight
   * servers (vLLM, gpt-oss, gateways in front of DeepSeek/Qwen) return the
   * thoughts themselves instead of an encrypted blob, and expect them back the
   * same way.
   */
  content?: readonly string[]
}

