import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

export const providerId = 'openai'
export const expectedCredential = 'packed-openai-secret'
export const createPlugin = () => openAiPlugin({ apiKey: expectedCredential })
export const frames = [
  { type: 'response.created', response: { id: 'r1' } },
  { type: 'response.output_item.added', item: { id: 'i1', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'i1', delta: 'packed provider completed' },
  { type: 'response.output_item.done', item: { id: 'i1', type: 'message',
    content: [{ type: 'output_text', text: 'packed provider completed' }] } },
  { type: 'response.completed', response: { id: 'r1',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
]


// Exercise the published Decisions subpath in Node, browser and Worker consumers.
export async function verifyAdditionalCapabilities() {
  const { createDecisionRuntime, booleanQuestion } = await import('@alvin0/ai-agent-sdk-decision-adapter')
  const { openAiDecisionPlugin } = await import('@alvin0/ai-agent-sdk-provider-openai/decisions')
  const runtime = createDecisionRuntime({ providers: [openAiDecisionPlugin({ apiKey: expectedCredential,
    fetch: async (url, init) => {
      if (url !== 'https://api.openai.com/v1/decisions') throw Error('wrong Decisions endpoint')
      if (init.headers.authorization !== `Bearer ${expectedCredential}`) throw Error('missing key')
      const wire = JSON.parse(init.body)
      if (wire.input !== 'refund please' || wire.questions[0].type !== 'predicate') throw Error('wrong Decisions input')
      const payload = { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'refund', probability: 0.9 }],
        usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 } }
      return { ok: true, status: 200, headers: { get: () => null }, body: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close() },
      }) }
    },
  })] })
  try {
    const result = await runtime.decisionModel({ provider: 'openai', model: 'gpt-6-luna' }).evaluate({
      state: 'refund please', questions: { refund: booleanQuestion('Refund requested?') },
    })
    if (result.answers.refund.probabilityTrue !== 0.9 || result.usage.outputTokens !== 0) {
      throw Error('wrong Decisions result')
    }
  } finally { await runtime.close() }
}
