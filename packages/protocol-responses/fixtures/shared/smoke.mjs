import {
  openAiResponsesProtocol,
  serializeResponsesRequest,
  translateResponsesStream,
} from '@ai-agent-sdk/protocol-responses'

async function* frames() {
  yield {
    event: undefined,
    data: JSON.stringify({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 2,
          total_tokens: 12,
        },
      },
    }),
  }
}

export async function runPackedProtocolFixture() {
  const request = {
    options: { provider: 'packed', model: 'packed-model', messages: [] },
    maxTokens: 100,
  }
  const serialized = serializeResponsesRequest(request, openAiResponsesProtocol.defaultDialect)
  let usage
  for await (const chunk of translateResponsesStream(frames(), 'Packed', request)) {
    if (chunk.type === 'usage') usage = chunk.usage
  }
  return {
    protocol: openAiResponsesProtocol.id,
    model: serialized.model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
