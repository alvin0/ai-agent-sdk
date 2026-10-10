import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import { webLinks } from '../web-links'
import { card, requireString } from './values'

/** Read only a bounded prefix; cancel the network body instead of buffering it all. */
export async function webPrefix(
  response: Response, signal: AbortSignal,
): Promise<{ html: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { html: '', truncated: false }
  const decoder = new TextDecoder()
  let remaining = 200_000
  let html = ''
  try {
    while (remaining > 0) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) return { html: html + decoder.decode(), truncated: false }
      const kept = value.subarray(0, remaining)
      html += decoder.decode(kept, { stream: true })
      remaining -= kept.byteLength
    }
    return { html: html + decoder.decode(), truncated: true }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function fetchUrlTool(_root: string) {
  return defineTool({
    name: 'fetch_url',
    description: 'Fetch an https page and return its readable text and up to 40 source links. '
      + 'Follow relevant returned links instead of guessing endpoint paths. '
      + 'fetchedAt is the retrieval time, not the publication date or market-price timestamp; '
      + 'those must be verified from the source.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute https URL.' } },
      required: ['url'],
      additionalProperties: false,
    },
    parse: (raw) => {
      const url = new URL(requireString(raw, 'url'))
      if (url.protocol !== 'https:') throw new Error('only https URLs are allowed')
      return { url: url.toString() }
    },
    isConcurrencySafe: () => true,
    execute: async ({ url }, context) => {
      const response = await fetch(url, { redirect: 'follow', signal: context.signal })
      const fetchedAt = new Date().toISOString()
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`Source unavailable: HTTP ${response.status} for ${url}. `
          + 'Do not treat the error page as research evidence.')
      }
      const { html, truncated } = await webPrefix(response, context.signal)
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? url
      const readable = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const text = readable.slice(0, 8_000)
      return { url: response.url || url, title, status: response.status, text,
        links: webLinks(html, response.url || url),
        fetchedAt, truncated: truncated || readable.length > text.length }
    },
    meta: value => {
      const record = value as { url: string; title: string; text: string } | undefined
      return record === undefined
        ? undefined
        : card({ kind: 'web', url: record.url, title: record.title, snippet: record.text.slice(0, 400) })
    },
  })
}
