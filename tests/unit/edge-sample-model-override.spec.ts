/**
 * The Edge sample's own request path, driven end to end.
 *
 * This is the sample's real handler — `POST /api/chat` — not a reconstruction
 * of it, with the provider replaced by a scripted endpoint. That is the only way
 * to see what the sample actually sends after a visitor changes model mid
 * conversation, which is the thing a unit test of the SDK cannot tell you.
 *
 * Before per-call model selection the sample had to DROP the warm session when
 * the visitor picked a different model, taking the conversation's history with
 * it. The assertions below are about the behaviour that replaced it: same
 * session, same history, different model on the wire.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const MODEL_A = 'gpt-test-alpha'
const MODEL_B = 'gpt-test-beta'
const CATALOG = [
  { id: MODEL_A, contextWindow: 128_000, maxOutputTokens: 4_096, efforts: ['low', 'high'] },
  { id: MODEL_B, contextWindow: 200_000, maxOutputTokens: 8_192, efforts: ['medium', 'high'] },
]

/** The deployment credential; warm sessions are keyed by a digest of it. */
const API_KEY = 'sk-edge-sample-test'
process.env.OPENAI_API_KEY = API_KEY
process.env.EDGE_CHAT_MODEL = MODEL_A
delete process.env.EDGE_CHAT_EFFORT
delete process.env.EDGE_CHAT_MODE

const { createEdgeChatApp } = await import('../../samples/edge-runtime-chat-agents/web/src/server/app.ts')
const { activeSessions, dropSession, findSession } = await import('../../samples/edge-runtime-chat-agents/web/src/server/sessions.ts')

/** One provider request, as the scripted endpoint received it. */
interface Captured {
  readonly model: string
  readonly effort: string | undefined
  /** Every piece of text the request replayed, flattened. */
  readonly text: string
}

const captured: Captured[] = []
let realFetch: typeof globalThis.fetch

/** A Responses-shaped stream: enough frames for the translator to finish a turn. */
function scriptedBody(answer: string): ReadableStream<Uint8Array> {
  const frames = [
    'data: {"type":"response.created","response":{"id":"r1"}}',
    'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
    `data: {"type":"response.output_text.delta","item_id":"i1","delta":${JSON.stringify(answer)}}`,
    'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":'
      + `[{"type":"output_text","text":${JSON.stringify(answer)}}]}}`,
    'data: {"type":"response.completed","response":{"id":"r1","usage":'
      + '{"input_tokens":11,"output_tokens":5,"total_tokens":16}}}',
  ]
  const payload = new TextEncoder().encode(frames.map(frame => `${frame}\n\n`).join(''))
  return new ReadableStream({
    start(controller) { controller.enqueue(payload); controller.close() },
  })
}

/** Flatten whatever the request carried as input text, at any nesting depth. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value)
      .flatMap(([key, child]) => key === 'text' || key === 'content' || key === 'input' ? [textOf(child)] : [])
      .join(' ')
  }
  return ''
}

beforeEach(() => {
  captured.length = 0
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    const body = JSON.parse(raw) as Record<string, unknown>
    const reasoning = body.reasoning as { effort?: string } | undefined
    captured.push({
      model: String(body.model),
      effort: reasoning?.effort,
      text: textOf(body.input ?? body.messages ?? ''),
    })
    if (!url.includes('/responses') && !url.includes('/chat/completions')) {
      throw new Error(`unexpected provider path: ${url}`)
    }
    return new Response(scriptedBody('ok'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await dropSession('edge-override', API_KEY)
})

async function chat(app: ReturnType<typeof createEdgeChatApp>, body: Record<string, unknown>): Promise<string> {
  const response = await app.fetch(new Request('https://edge.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'edge-override', catalog: CATALOG, ...body }),
  }))
  expect(response.status).toBe(200)
  return await response.text()
}

describe('Edge sample: changing model between turns', () => {
  it('keeps the session and its history, and sends the new model', async () => {
    const app = createEdgeChatApp()

    await chat(app, { message: 'remember the codeword garnet', model: MODEL_A })
    const first = (await findSession('edge-override', API_KEY))?.session
    await chat(app, { message: 'what was the codeword', model: MODEL_B })
    const second = (await findSession('edge-override', API_KEY))?.session

    expect(captured.map(request => request.model)).toEqual([MODEL_A, MODEL_B])
    // The SAME session object answered both turns. A count would not show this:
    // discarding one session and building another also leaves exactly one warm.
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(activeSessions()).toBe(1)
    // The second request replayed the first turn, so the conversation survived
    // the switch rather than being rebuilt empty.
    expect(captured[1]!.text).toContain('garnet')
    expect(captured[1]!.text).toContain('what was the codeword')
  })

  it('returns to the configured model when a turn names none', async () => {
    const app = createEdgeChatApp()
    await chat(app, { message: 'one', model: MODEL_B })
    await chat(app, { message: 'two' })
    expect(captured.map(request => request.model)).toEqual([MODEL_B, MODEL_A])
  })

  it('applies the effort of the turn that asked for it, on the model of that turn', async () => {
    const app = createEdgeChatApp()
    await chat(app, { message: 'one', model: MODEL_A, effort: 'high' })
    await chat(app, { message: 'two', model: MODEL_B, effort: 'medium' })
    await chat(app, { message: 'three', model: MODEL_A })

    expect(captured.map(request => [request.model, request.effort])).toEqual([
      [MODEL_A, 'high'],
      [MODEL_B, 'medium'],
      // No effort asked for and none configured: the route decides, and nothing
      // carries 'medium' over from the previous turn's model.
      [MODEL_A, undefined],
    ])
  })

  it('rejects an effort the selected model does not declare, before any provider call', async () => {
    const app = createEdgeChatApp()
    const response = await app.fetch(new Request('https://edge.test/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'edge-override', message: 'one', model: MODEL_B, effort: 'low', catalog: CATALOG,
      }),
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_effort', model: MODEL_B })
    expect(captured).toHaveLength(0)
  })
})
