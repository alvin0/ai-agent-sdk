import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, type ContentBlock } from '@alvin0/ai-agent-sdk-core'
import type { ToolExecutionResult } from '@alvin0/ai-agent-sdk-core/tools'
import { codexPlugin, memoryCodexCredentialStore } from '@alvin0/ai-agent-sdk-provider-codex'
import { codexNodeImageTool } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { authFile } from './fixtures/codex-usage.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const cases = [
  { name: 'small image', status: 200, data: PNG, error: undefined },
  { name: 'large retained image', status: 200, data: PNG.slice(0, 16) + 'A'.repeat(1_850_000), error: undefined },
  { name: 'forbidden', status: 403, data: PNG, error: 'CODEX_IMAGE_FORBIDDEN' },
  { name: 'above tool retention budget', status: 200,
    data: PNG.slice(0, 16) + 'A'.repeat(2_100_000), error: 'CODEX_IMAGE_TOO_LARGE' },
]

function responseRound(round: number): Response {
  const item = round === 1
    ? { id: 'fc1', type: 'function_call', name: 'codex_generate_image', call_id: 'call1',
      arguments: JSON.stringify({ prompt: 'Draw a circle.', model: 'model-injection-is-ignored' }) }
    : { id: 'text1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished.' }] }
  const frames = [
    { type: 'response.output_item.added', item },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: `r${round}`, output: [item],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
  ]
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('Codex image host tool', () => {
  it.each(cases)('delivers image content or the Images error through tool events and history: $name',
    async ({ status, data, error }) => {
      const authStore = memoryCodexCredentialStore(authFile())
      const imagesFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'fixture-image-model' })
        return Response.json(status === 200 ? { data: [{ b64_json: data }] } : { detail: 'private-details' },
          { status })
      })
      const requests: string[] = []
      const runtime = await createAgentRuntime({ providers: [codexPlugin({ authStore,
        models: [{ id: 'gpt-6-luna', inputModalities: ['text', 'image'] }],
        fetch: async (_input, init) => {
          requests.push(String(init?.body))
          return responseRound(requests.length)
        },
      })] })
      try {
        const content: ContentBlock[] = []
        const errors: string[] = []
        const session = runtime.agent({ id: 'image-host-tool', instructions: 'Generate the requested image.',
          model: { provider: 'codex', id: 'gpt-6-luna' }, compaction: false,
          tools: [codexNodeImageTool({ authStore, model: 'fixture-image-model', fetch: imagesFetch })],
        }).createSession()
        const result = await session.run('Draw a circle.', { onEvent(event) {
          if (event.type !== 'tool-result') return
          const output = event.output as ToolExecutionResult
          content.push(...output.content)
          if (output.isError) errors.push(output.error.code)
        } })
        expect(result.completed).toBe(true)
        expect(imagesFetch).toHaveBeenCalledTimes(1)
        expect(requests).toHaveLength(2)
        if (error === undefined) {
          expect(content).toContainEqual({ type: 'image', source: {
            kind: 'base64', mediaType: 'image/png', data,
          } })
          expect(JSON.stringify(session.snapshot())).toContain(data)
          expect(requests[1]).toContain(`data:image/png;base64,${data}`)
        } else {
          expect(errors).toEqual([error])
          expect(content.some(block => block.type === 'image')).toBe(false)
          expect(requests[1]).not.toContain('private-details')
        }
      } finally { await runtime.close() }
    },
  )
})
