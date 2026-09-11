/**
 * End-to-end PDF input against the real Codex and Gemini endpoints.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Codex needs
 * `npm run provider:codex:login-device`; Gemini needs `GEMINI_KEY` and
 * `GEMINI_MODEL`.
 *
 * This is the only test that can prove the document wire contract is right. A
 * mock server would happily accept the `input_file` / `document` shapes this SDK
 * invents; only the real provider can confirm it actually READ the file, which is
 * why the assertion is on the model reporting the document's true page count
 * rather than on the serialized body.
 *
 * These requests are not cheap: the sample is 72 pages, which bills ~214k input
 * tokens on Codex and ~38k on Gemini.
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { BlockAssembler, ModelRegistry, createMessage } from '@alvin0/ai-agent-sdk-core'
import type { Message, StreamChunk, TokenUsage } from '@alvin0/ai-agent-sdk-core'
import { codexNodeAdapter, fileCodexAuthStore } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { geminiAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'

const PDF_PATH = '.temp/documents-sample-test/inquiry_202605111611.pdf'
/** Page count of the sample, verified independently by both providers. */
const PDF_PAGES = 72
const CODEX_MODEL = 'gpt-5.6-luna'

const PROMPT = 'This is a PDF. Reply with exactly one line: "PAGES: <the number of pages>".'

const pdf = await readFile(PDF_PATH).then(
  bytes => bytes.toString('base64'),
  () => undefined,
)

const codexSignedIn = await (async () => {
  const file = await fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }).read()
  return file?.tokens != null
})()

const geminiKey = process.env.GEMINI_KEY
const geminiModel = process.env.GEMINI_MODEL

/**
 * Total input cost of a call, cached portion included.
 *
 * Both providers cache large prompt prefixes implicitly, and a repeated PDF then
 * arrives mostly as `cacheReadTokens` — Gemini reported 2,065 fresh plus 36,264
 * cached for this sample on a second run. Asserting on `inputTokens` alone would
 * make the test pass or fail depending on cache state rather than on whether the
 * document was read.
 */
function billedInputTokens(usage: TokenUsage | undefined): number {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)
}

function documentMessage(data: string): Message {
  return createMessage({
    role: 'user',
    source: { kind: 'user' },
    content: [
      {
        type: 'document',
        source: { kind: 'base64', mediaType: 'application/pdf', data },
        filename: 'inquiry_202605111611.pdf',
        pages: PDF_PAGES,
      },
      { type: 'text', text: PROMPT },
    ],
  })
}

async function replyText(stream: AsyncIterable<StreamChunk>, provider: string, model: string): Promise<{
  text: string
  usage: TokenUsage | undefined
  finish: StreamChunk | undefined
}> {
  const assembler = new BlockAssembler()
  let finish: StreamChunk | undefined
  for await (const chunk of stream) {
    assembler.push(chunk)
    if (chunk.type === 'finish') finish = chunk
  }
  const message = assembler.message({ kind: 'model', provider, model })
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { text, usage: assembler.usage, finish }
}

describe.skipIf(pdf === undefined || !codexSignedIn)('codex document input (live)', () => {
  it('reads a real 72-page PDF sent as inline base64', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['codex'], codexNodeAdapter({
      authStore: fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }),
      // Codex discovery reports only `text` and `image`, so the document
      // capability has to be declared here. Without this override the registry
      // treats the omission as a negative claim and projects the PDF to text.
      models: [{ id: CODEX_MODEL, inputModalities: ['text', 'image', 'document'] }],
    }))

    const { text, usage, finish } = await replyText(registry.stream({
      provider: 'codex',
      model: CODEX_MODEL,
      messages: [documentMessage(pdf as string)],
      // Strict: fail loudly rather than silently degrade the PDF to a stand-in,
      // which would make a passing assertion meaningless.
      documentPolicy: 'strict',
      signal: AbortSignal.timeout(300_000),
    }), 'codex', CODEX_MODEL)

    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('stop')
    // Only a provider that actually rendered the file can count its pages.
    expect(text).toContain(String(PDF_PAGES))
    // ~3k tokens per page: the document was billed as pages, not as a blob.
    expect(billedInputTokens(usage)).toBeGreaterThan(100_000)
  }, 300_000)

  it('projects the PDF to text for a model that declares no document support', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['codex'], codexNodeAdapter({
      authStore: fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }),
      models: [{ id: CODEX_MODEL, inputModalities: ['text', 'image'] }],
    }))

    const { text, usage } = await replyText(registry.stream({
      provider: 'codex',
      model: CODEX_MODEL,
      messages: [documentMessage(pdf as string)],
      signal: AbortSignal.timeout(120_000),
    }), 'codex', CODEX_MODEL)

    // The stand-in names the file, so the model can say something coherent about
    // what it cannot see — and the request is a tiny fraction of the real cost.
    expect(billedInputTokens(usage)).toBeLessThan(5_000)
    expect(text.length).toBeGreaterThan(0)
  }, 120_000)
})

describe.skipIf(pdf === undefined || geminiKey === undefined || geminiModel === undefined)('gemini document input (live)', () => {
  it('reads a real 72-page PDF sent as inline base64', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['gemini'], geminiAdapter({
      apiKey: geminiKey as string,
      // Gemini ships no built-in catalog, so every capability is declared here.
      models: [{ id: geminiModel as string, inputModalities: ['text', 'image', 'document'] }],
    }))

    const { text, usage, finish } = await replyText(registry.stream({
      provider: 'gemini',
      model: geminiModel as string,
      messages: [documentMessage(pdf as string)],
      documentPolicy: 'strict',
      signal: AbortSignal.timeout(300_000),
    }), 'gemini', geminiModel as string)

    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('stop')
    expect(text).toContain(String(PDF_PAGES))
    expect(billedInputTokens(usage)).toBeGreaterThan(10_000)
  }, 300_000)
})
