import {
  openAiChatCompletionsProtocol,
  serializeChatCompletionsRequest,
  translateChatCompletionsStream,
} from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'
async function* frames() {
  yield {
    event: undefined,
    data: JSON.stringify({
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      usage: null,
    }),
  }
  yield {
    event: undefined,
    data: JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: null,
    }),
  }
  // Usage arrives after the terminal finish, on a chunk with no choices.
  yield {
    event: undefined,
    data: JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens: 2,
        total_tokens: 12,
      },
    }),
  }
  yield { event: undefined, data: '[DONE]' }
}
export async function runPackedProtocolFixture() {
  const request = {
    options: { provider: 'packed', model: 'packed-model', messages: [] },
    maxTokens: 100,
  }
  const serialized = serializeChatCompletionsRequest(
    request,
    openAiChatCompletionsProtocol.defaultDialect,
  )
  let usage
  for await (const chunk of translateChatCompletionsStream(frames(), 'Packed')) {
    if (chunk.type === 'usage') usage = chunk.usage
  }
  return {
    protocol: openAiChatCompletionsProtocol.id,
    model: serialized.model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
