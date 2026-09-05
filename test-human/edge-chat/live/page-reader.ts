import type { ResearchEvidenceLedger, ResearchReadReceipt } from './evidence.ts'

const MAX_REDIRECTS = 3
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_RESPONSE_CHUNKS = 2_048
const MAX_EXTRACTED_CHARS = 8_000
const READ_TIMEOUT_MS = 20_000

export interface PageReadInput {
  readonly url: string
  readonly searchQuery: string
}

export interface PageReadResult {
  readonly receipt: ResearchReadReceipt
  readonly excerpt: string
}

export async function readResearchPage(
  input: PageReadInput,
  context: { readonly callId: string; readonly signal: AbortSignal },
  ledger: ResearchEvidenceLedger,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<PageReadResult> {
  validateText(input.searchQuery, 500, 'search query')
  const requested = researchUrl(input.url)
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
  let current = requested
  let response: Response | undefined
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    response = await fetchImplementation(current, {
      method: 'GET', redirect: 'manual', signal,
      headers: { accept: 'text/html, text/plain;q=0.9, application/json;q=0.5' },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null || redirects === MAX_REDIRECTS) throw new Error('page redirect policy was not satisfied')
    current = researchUrl(new URL(location, current).href)
  }
  if (response === undefined || !response.ok || response.body === null) {
    await response?.body?.cancel()
    throw new Error(`page read failed with HTTP ${response?.status ?? 0}`)
  }
  const type = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!type.includes('text/html') && !type.includes('text/plain') && !type.includes('application/json')) {
    await response.body.cancel()
    throw new Error('page content type is not readable text')
  }
  const body = await boundedBody(response.body, signal)
  const decoded = new TextDecoder().decode(body.bytes)
  const extraction = type.includes('text/html') ? 'html-text' as const : 'plain-text' as const
  const extracted = extraction === 'html-text' ? extractHtmlText(decoded) : decoded.trim()
  if (extracted.length === 0) throw new Error('page extraction produced no readable text')
  const excerpt = extracted.slice(0, MAX_EXTRACTED_CHARS)
  const finalUrl = researchUrl(response.url.length > 0 ? response.url : current.href)
  const digest = await sha256(excerpt)
  const receipt: ResearchReadReceipt = Object.freeze({
    taskId: ledger.taskId, callId: context.callId,
    receiptId: `read-${context.callId}`, requestedUrl: requested.href,
    finalUrl: finalUrl.href, canonicalSource: canonicalSource(finalUrl),
    domain: finalUrl.hostname.toLowerCase(), title: htmlTitle(decoded) ?? finalUrl.hostname,
    searchQuery: input.searchQuery.trim(), retrievedAt: new Date().toISOString(), digest,
    extraction, status: body.partial || extracted.length > MAX_EXTRACTED_CHARS ? 'partial' : 'complete',
    bytesRead: body.bytes.byteLength, charsExtracted: excerpt.length,
  })
  ledger.record(receipt)
  return Object.freeze({ receipt, excerpt })
}

async function boundedBody(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly partial: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let count = 0
  let partial = false
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      if (next.value === undefined) continue
      count++
      if (count > MAX_RESPONSE_CHUNKS) { partial = true; await reader.cancel(); break }
      const remaining = MAX_RESPONSE_BYTES - size
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.slice(0, remaining))
        size += Math.max(0, remaining)
        partial = true
        await reader.cancel()
        break
      }
      chunks.push(next.value)
      size += next.value.byteLength
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { bytes, partial }
}

function researchUrl(value: string): URL {
  validateText(value, 2_048, 'page URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new TypeError('page URL must be a credential-free default-port HTTPS URL')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || /^\d+(?:\.\d+){3}$/u.test(host) || host.includes(':')) {
    throw new TypeError('page URL host is not eligible for Internet research')
  }
  url.hash = ''
  return url
}

function canonicalSource(url: URL): string {
  const canonical = new URL(url)
  canonical.hostname = canonical.hostname.toLowerCase()
  canonical.hash = ''
  for (const name of [...canonical.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/iu.test(name)) canonical.searchParams.delete(name)
  }
  canonical.searchParams.sort()
  return canonical.href
}

function extractHtmlText(html: string): string {
  return decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/\s+/gu, ' ').trim()
}

function htmlTitle(html: string): string | undefined {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]
  if (raw === undefined) return undefined
  const value = decodeEntities(raw.replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim()
  return value.length === 0 ? undefined : value.slice(0, 300)
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/gu, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
  })[entity] ?? entity)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function validateText(value: string, max: number, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${label} is invalid`)
  }
}
