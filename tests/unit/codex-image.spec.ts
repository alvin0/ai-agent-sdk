import { describe, expect, it, vi } from 'vitest'
import {
  CodexImageError, codexImageUrl, generateCodexImage, getCodexTokens, memoryCodexCredentialStore,
} from '@alvin0/ai-agent-sdk-provider-codex'
import { generateCodexNodeImage } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { authFile, hangingFetch, jwt, NOW_SECONDS, usageFetch } from './fixtures/codex-usage.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const body = () => ({ created: 1, data: [{ b64_json: PNG, generation_id: 'generation-test' }] })
const defaults = () => ({
  authStore: memoryCodexCredentialStore(authFile()), model: 'fixture-image-model', prompt: 'Draw a circle.',
})

describe('standalone Codex Images transport', () => {
  it('uses the Images route, selected image model and account credentials and returns an ImageBlock', async () => {
    const fetch = usageFetch(() => Response.json(body()))
    const result = await generateCodexImage({ ...defaults(), fetch })
    expect(result.images).toEqual([{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } }])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(init?.headers).toMatchObject({ 'chatgpt-account-id': 'acct-private-1', originator: 'codex_cli_rs',
      'content-type': 'application/json', 'x-codex-image-turn-id': expect.any(String) })
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'fixture-image-model', prompt: 'Draw a circle.',
      n: 1, quality: 'auto', size: 'auto', background: 'opaque' })
    expect(JSON.stringify(result)).not.toContain('acct-private-1')
  })

  it('uses revision-safe refresh before sending and keeps explicit image settings', async () => {
    const authStore = memoryCodexCredentialStore(authFile(-60))
    const token = jwt({ exp: NOW_SECONDS + 3600 })
    const refreshFetch = usageFetch(() => Response.json({
      id_token: jwt({}), access_token: token, refresh_token: 'rotated-refresh',
    }))
    const fetch = usageFetch(() => Response.json(body()))
    await generateCodexImage({ ...defaults(), authStore, fetch, oauth: { fetch: refreshFetch },
      quality: 'low', background: 'transparent', size: '1024x1024' })
    expect(refreshFetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ authorization: `Bearer ${token}` })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      quality: 'low', background: 'transparent', size: '1024x1024',
    })
    const tokens = await getCodexTokens(authStore, { refreshIfNeeded: false })
    expect(tokens.refresh_token).toBe('rotated-refresh')
  })

  it.each([[401, 'CODEX_IMAGE_UNAUTHORIZED'], [403, 'CODEX_IMAGE_FORBIDDEN'],
    [404, 'CODEX_IMAGE_HTTP'], [429, 'CODEX_IMAGE_HTTP'], [500, 'CODEX_IMAGE_HTTP']])(
    'preserves HTTP %i as %s, omits the raw body and never retries', async (status, code) => {
      const fetch = usageFetch(() => new Response('secret-token-and-prompt', { status: Number(status) }))
      const error = await generateCodexImage({ ...defaults(), fetch }).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(CodexImageError)
      expect(error).toMatchObject({ code, status })
      expect(JSON.stringify(error)).not.toContain('secret-token-and-prompt')
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each([{}, [], { data: [] }, { data: [{ url: 'https://untrusted.test/image' }] },
    { data: [{ b64_json: 'invalid!' }] }, { data: [{ b64_json: btoa('plain text') }] },
    { data: [{ b64_json: PNG }, { b64_json: PNG }] }].map(data => ({ data })))(
    'rejects malformed output $data', async ({ data }) => {
    await expect(generateCodexImage({ ...defaults(), fetch: usageFetch(() => Response.json(data)) }))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_MALFORMED' })
    },
  )

  it('rejects non-JSON and non-object responses', async () => {
    await expect(generateCodexImage({ ...defaults(), fetch: usageFetch(() => new Response('<html>')) }))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_MALFORMED' })
  })

  it('refuses redirects without forwarding credentials', async () => {
    const fetch = usageFetch(() => new Response(null, { status: 307, headers: { location: 'https://evil.test' } }))
    await expect(generateCodexImage({ ...defaults(), fetch })).rejects.toMatchObject({ code: 'CODEX_IMAGE_REDIRECT' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('bounds declared and streamed response sizes (declared=%s)', async declared => {
    const fetch = usageFetch(() => new Response(JSON.stringify(body()), {
      headers: declared ? { 'content-length': '5000' } : {},
    }))
    await expect(generateCodexImage({ ...defaults(), fetch, maxBytes: 32 }))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_TOO_LARGE' })
  })

  it('distinguishes network and timeout errors', async () => {
    await expect(generateCodexImage({ ...defaults(), fetch: hangingFetch, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_TIMEOUT' })
    await expect(generateCodexImage({ ...defaults(), fetch: async () => { throw new Error('private details') } }))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_NETWORK' })
  })

  it('enforces the deadline while oversized-body cancellation is still settling', async () => {
    let release!: () => void
    const fetch = usageFetch(() => new Response(new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(resolve => { release = resolve }),
    }), { headers: { 'content-length': '5000' } }))
    try {
      await expect(generateCodexImage({ ...defaults(), fetch, maxBytes: 32, timeoutMs: 20 }))
        .rejects.toMatchObject({ code: 'CODEX_IMAGE_TIMEOUT' })
    } finally { release?.() }
  })

  it('rejects an overflowing timer and preserves a pre-aborted signal without fetching', async () => {
    const fetch = usageFetch(() => Response.json(body()))
    await expect(generateCodexImage({ ...defaults(), fetch, timeoutMs: 2_147_483_648 })).rejects.toThrow(RangeError)
    const controller = new AbortController()
    const reason = new Error('already stopped')
    controller.abort(reason)
    await expect(generateCodexImage({ ...defaults(), fetch, signal: controller.signal })).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels a stalled body and preserves caller cancellation', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const fetch = usageFetch(() => new Response(new ReadableStream<Uint8Array>({ cancel })))
    const pending = generateCodexImage({ ...defaults(), fetch, signal: controller.signal })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    const reason = new Error('caller stopped')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('releases a response arriving after cancellation', async () => {
    let deliver!: (response: Response) => void
    const cancel = vi.fn()
    const fetch = vi.fn(() => new Promise<Response>(resolve => { deliver = resolve }))
    const controller = new AbortController()
    const pending = generateCodexImage({ ...defaults(), fetch, signal: controller.signal })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
    deliver(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
  })

  it('bounds credential resolution even if the store ignores cancellation', async () => {
    const authStore = { location: 'fixture', read: () => new Promise<undefined>(() => {}), write: async () => {} }
    await expect(generateCodexImage({ ...defaults(), authStore, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_TIMEOUT' })
  })

  it('keeps missing-credential errors and rejects invalid input before fetching', async () => {
    const fetch = usageFetch(() => Response.json(body()))
    await expect(generateCodexImage({ ...defaults(), authStore: memoryCodexCredentialStore(), fetch }))
      .rejects.toThrow(/no Codex credentials/)
    await expect(generateCodexImage({ ...defaults(), model: '', fetch })).rejects.toThrow(/model/)
    await expect(generateCodexImage({ ...defaults(), prompt: ' ', fetch })).rejects.toThrow(/prompt/)
    await expect(generateCodexImage({ ...defaults(), maxBytes: 0, fetch })).rejects.toThrow(RangeError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('works through the Node entry with injected credentials', async () => {
    const result = await generateCodexNodeImage({ ...defaults(), fetch: usageFetch(() => Response.json(body())) })
    expect(result.images[0]?.type).toBe('image')
  })

  it('handles a multi-megabyte image without a recursive base64 regex', async () => {
    const data = PNG.slice(0, 16) + 'A'.repeat(4 * 1024 * 1024)
    const result = await generateCodexImage({ ...defaults(), fetch: usageFetch(() => Response.json({
      data: [{ b64_json: data }],
    })) })
    expect(result.images[0]?.source).toMatchObject({ mediaType: 'image/png', data })
  })
})

describe('codexImageUrl', () => {
  it('preserves a custom API path and clears query and fragment', () => {
    expect(codexImageUrl('https://trusted.test/v1/?a=1#fragment')).toBe('https://trusted.test/v1/images/generations')
    expect(() => codexImageUrl('http://trusted.test')).toThrow(/https/)
    expect(() => codexImageUrl('https://user:pass@trusted.test')).toThrow(/credentials/)
  })
})
