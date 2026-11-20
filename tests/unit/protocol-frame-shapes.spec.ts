import { expect, it } from 'vitest'
import { translateResponsesStream } from '@alvin0/ai-agent-sdk-protocol-responses'
import { translateAnthropicStream } from '@alvin0/ai-agent-sdk-protocol-anthropic-messages'
import { translateGeminiInteractionsStream } from '@alvin0/ai-agent-sdk-protocol-gemini-interactions'
import { translateChatCompletionsStream } from '../../packages/protocol-openai-chat-completions/src/translate.ts'

const translators = [
  { name: 'responses', translate: translateResponsesStream },
  { name: 'anthropic', translate: translateAnthropicStream },
  { name: 'gemini', translate: translateGeminiInteractionsStream },
  { name: 'chat-completions', translate: translateChatCompletionsStream },
]

it.each(translators)('classifies non-object frames and closes the source through $name', async ({ translate }) => {
  for (const value of [null, [], 42, 'ordinary fixture']) {
    let closed = false
    async function* events() {
      try { yield { event: undefined, data: JSON.stringify(value) } }
      finally { closed = true }
    }
    const consume = async () => {
      for await (const _chunk of translate(events(), 'Fixture')) { /* consume */ }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(closed).toBe(true)
  }
})
