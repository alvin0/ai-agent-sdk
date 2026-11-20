import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, type ContentBlock } from '@alvin0/ai-agent-sdk-core'
import type { ToolExecutionResult } from '@alvin0/ai-agent-sdk-core/tools'
import { antigravityPlugin, memoryAntigravityCredentialStore } from '@alvin0/ai-agent-sdk-provider-antigravity'
import { codexImageTool, codexPlugin, memoryCodexCredentialStore } from '@alvin0/ai-agent-sdk-provider-codex'
import { authFile } from './fixtures/codex-usage.ts'

import { largePng, PNG } from './fixtures/codex-images.ts'

const cases = [
  { name: 'small image', status: 200, data: PNG, error: undefined },
  { name: 'large retained image', status: 200, data: largePng(1_380_000), error: undefined },
  { name: 'forbidden', status: 403, data: PNG, error: 'CODEX_IMAGE_FORBIDDEN' },
  { name: 'above tool retention budget', status: 200,
    data: largePng(1_600_000), error: 'CODEX_IMAGE_TOO_LARGE' },
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
  it.each([false, true])('completes an Antigravity follow-up and restores its snapshot, prune=%s', async prune => {
    const images = vi.fn(async () => Response.json({ data: [{ b64_json: PNG }] }))
    const requests: string[] = []
    const runtime = await createAgentRuntime({ providers: [antigravityPlugin({
      authStore: memoryAntigravityCredentialStore({ version: 1, projectId: 'project', clientId: 'client',
        obtainedAt: 'initial', tokens: { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now()+3600000 } }),
      models: [{ id: 'fixture' }], fetch: async (_url, init) => {
        requests.push(String(init?.body))
        const part = requests.length === 1
          ? { functionCall: { name: 'codex_generate_image', args: { prompt: 'Draw a circle.' } }, thoughtSignature: 'signed' }
          : { text: 'Done' }
        const data = { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] }
        return new Response('data: '+ JSON.stringify(data) +'\n\n', { headers: { 'content-type': 'text/event-stream' } })
      },
    })] })
    try {
      const agent = runtime.agent({ id: 'tool-loop', instructions: 'Draw.', compaction: false,
        model: { provider: 'antigravity', id: 'fixture' },
        tools: [codexImageTool({ authStore: memoryCodexCredentialStore(authFile()), model: 'fixture', fetch: images })] })
      const options = prune ? { imageRetention: { keepLatest: 0, persist: 'drop-pruned' as const } } : {}
      const session = agent.createSession(options)
      const received: ContentBlock[] = []
      const run = await session.run('Draw.', { onEvent(event) {
        if (event.type === 'tool-result') received.push(...(event.output as ToolExecutionResult).content)
      } })
      expect(run.completed).toBe(true)
      expect(images).toHaveBeenCalledTimes(1)
      expect(requests).toHaveLength(2)
      expect(received).toContainEqual({ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } })
      const snapshot = session.snapshot()
      for (const json of [requests[1]!, JSON.stringify(snapshot), JSON.stringify(agent.resumeSession(snapshot, options).snapshot())]) {
        expect(json.includes(PNG)).toBe(!prune)
      }
      if (!prune) expect(requests[1]).toContain('"parts":[{"inlineData"')
    } finally { await runtime.close() }
  })

  it.each(['store', 'refresh', 'cancel'] as const)('sanitizes a %s failure before the next model call', async kind => {
    const requests: string[] = []
    const authStore = memoryCodexCredentialStore(authFile())
    const runtime = await createAgentRuntime({ providers: [codexPlugin({ authStore, models: [{ id: 'gpt-6-luna' }],
      fetch: async (_url, init) => { requests.push(String(init?.body)); return responseRound(requests.length) } })] })
    const brokenStore = { location: 'private-host-path', read: async () => { throw new Error('private-host-path') },
      write: async () => {} }
    const codes: string[] = []
    try {
      const tool = codexImageTool({ model: 'fixture', authStore: kind === 'store' ? brokenStore : memoryCodexCredentialStore(authFile(-60)),
        oauth: { ...(kind === 'cancel' ? { signal: AbortSignal.abort(new Error('private-host-path')) } : {}),
          fetch: async () => Response.json({ error: 'invalid_grant', detail: 'private-host-path' }, { status: 400 }) } })
      await runtime.agent({ id: 'failed-tool', instructions: 'Draw.', model: { provider: 'codex', id: 'gpt-6-luna' },
        tools: [tool] }).createSession().run('Draw.', { onEvent(event) {
        if (event.type === 'tool-result') {
          const result = event.output as ToolExecutionResult
          if (result.isError) codes.push(result.error.code)
        }
      } })
      expect(codes).toEqual([{ store: 'CODEX_IMAGE_CREDENTIAL', refresh: 'CODEX_REAUTH_REQUIRED', cancel: 'ABORTED' }[kind]])
      expect(requests).toHaveLength(2)
      expect(requests[1]).not.toContain('private-host-path')
    } finally { await runtime.close() }
  })

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
          tools: [codexImageTool({ authStore, model: 'fixture-image-model', fetch: imagesFetch })],
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
