import {
  ReasoningEffortId,
  createAgentRuntime,
  type AgentRuntime,
  type RuntimeAgentRunEvent,
  type RuntimeAgentRunHandle,
  type RuntimeAgentSession,
} from '@ai-agent-sdk/core'
import {
  CODEX_BASE_URL, codexPlugin, memoryCodexCredentialStore, type CodexAuthFile,
} from '@ai-agent-sdk/provider-codex'
import { EDGE_CHAT_HTML, edgeSecurityHeaders } from '../app.ts'
import { createLiveResearchTools } from './tools.ts'
import type { ResearchEvidenceLedger } from './evidence.ts'
import { LIVE_RESEARCH_INSTRUCTIONS } from './instructions.ts'

interface LiveEnvironment {
  readonly CODEX_AUTH_BASE64?: string
  readonly EDGE_CHAT_MODEL?: string
  readonly EDGE_CHAT_REASONING_EFFORT?: string
  readonly EDGE_CHAT_MAX_TURNS?: string
  readonly EDGE_CHAT_MAX_TOOL_CALLS?: string
  readonly EDGE_CHAT_MAX_TOTAL_TOKENS?: string
  readonly CODEX_RELAY_ORIGIN?: string
  readonly CODEX_RELAY_SECRET?: string
}

interface LiveSession {
  readonly runtime: AgentRuntime
  readonly session: RuntimeAgentSession
  readonly evidence: ResearchEvidenceLedger
  touchedAt: number
}

const sessions = new Map<string, LiveSession>()
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const MAX_PROMPT_CHARS = 32_000
const MAX_SESSIONS = 16

export default {
  async fetch(request: Request, environment: LiveEnvironment): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(EDGE_CHAT_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', ...edgeSecurityHeaders() },
      })
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, runtime: 'web-standards', provider: 'codex-live', activeSessions: sessions.size })
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') return chat(request, environment)
    if (request.method === 'POST' && url.pathname === '/api/close') return closeSession(request)
    return json({ error: 'not_found' }, 404)
  },
}

async function chat(request: Request, environment: LiveEnvironment): Promise<Response> {
  const input = await bodyObject(request)
  if (input === undefined) return json({ error: 'invalid_request' }, 400)
  const conversationId = Reflect.get(input, 'conversationId')
  const message = Reflect.get(input, 'message')
  const mode = Reflect.get(input, 'mode')
  if (typeof conversationId !== 'string' || !SESSION_ID.test(conversationId)) {
    return json({ error: 'invalid_conversation_id' }, 400)
  }
  if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_PROMPT_CHARS) {
    return json({ error: 'invalid_message', maxChars: MAX_PROMPT_CHARS }, 400)
  }
  if (mode !== 'deep-search') return json({ error: 'live_deep_search_required' }, 400)
  const principal = trustedPrincipal(request)
  if (principal === undefined) return json({ error: 'authentication_required' }, 401)
  const key = `${principal.length}:${principal}${conversationId}`
  await pruneSessions()
  let entry = sessions.get(key)
  if (entry === undefined) {
    if (sessions.size >= MAX_SESSIONS) return json({ error: 'session_capacity' }, 503)
    try { entry = await createSession(conversationId, environment) }
    catch { return json({ error: 'provider_initialization_failed' }, 503) }
    sessions.set(key, entry)
  }
  if (entry.session.isRunning) return json({ error: 'conversation_busy' }, 409)
  entry.touchedAt = Date.now()
  const handle = entry.session.stream(message.trim())
  return streamResponse(handle, entry, conversationId)
}

async function createSession(conversationId: string, environment: LiveEnvironment): Promise<LiveSession> {
  const auth = decodeAuth(environment.CODEX_AUTH_BASE64)
  const model = environment.EDGE_CHAT_MODEL?.trim() || 'gpt-5.6-luna'
  const effort = ReasoningEffortId(environment.EDGE_CHAT_REASONING_EFFORT?.trim() || 'medium')
  const limits = researchLimits(environment)
  const provider = codexPlugin({
    authStore: memoryCodexCredentialStore(auth), defaultModel: model,
    models: [{ id: model, name: model, contextWindow: 272_000, maxTokens: 32_000,
      inputModalities: ['text', 'image'], outputModalities: ['text'],
      nativeTools: ['web-search'],
      reasoning: { efforts: [{ id: effort, name: effort }], defaultEffort: effort } }],
    requestTimeoutMs: 180_000, streamIdleTimeoutMs: 45_000,
    fetch: createCodexRelayFetch(environment),
  })
  const runtime = await createAgentRuntime({
    providers: [provider], closeTimeoutMs: 5_000,
    resource: { serviceName: 'edge-chat-live-research', environment: 'human-test' },
    diagnosticMaxEvents: 256,
  })
  const research = createLiveResearchTools(`edge-${conversationId}`)
  const agent = runtime.agent({
    id: 'edge-live-research', model: { provider: 'codex', id: model }, effort,
    mode: 'deep', commentary: 'concise', instructions: LIVE_RESEARCH_INSTRUCTIONS,
    tools: research.tools,
    nativeTools: [{ type: 'native', name: 'web-search', searchContextSize: 'high' }],
    maxTurns: limits.maxTurns, maxToolCalls: limits.maxToolCalls, compaction: false,
  })
  const session = agent.createSession({
    conversationId, usagePolicy: { onMissing: 'fail' },
    runtimeLimits: { maxSteps: limits.maxTurns, maxToolCalls: limits.maxToolCalls,
      maxTotalTokens: limits.maxTotalTokens,
      observerTimeoutMs: 5_000 },
  })
  return { runtime, session, evidence: research.ledger, touchedAt: Date.now() }
}

function researchLimits(environment: LiveEnvironment): {
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly maxTotalTokens: number
} {
  return {
    maxTurns: boundedInteger(environment.EDGE_CHAT_MAX_TURNS, 28, 4, 96),
    maxToolCalls: boundedInteger(environment.EDGE_CHAT_MAX_TOOL_CALLS, 40, 4, 160),
    maxTotalTokens: boundedInteger(
      environment.EDGE_CHAT_MAX_TOTAL_TOKENS, 300_000, 32_000, 1_500_000,
    ),
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim().length === 0) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError('live research limit is invalid')
  }
  return parsed
}

function createCodexRelayFetch(environment: LiveEnvironment): typeof globalThis.fetch {
  const relayOrigin = requireRelayOrigin(environment.CODEX_RELAY_ORIGIN)
  const secret = environment.CODEX_RELAY_SECRET
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Codex relay secret is missing')
  return async (input, init) => {
    const request = new Request(input, init)
    const upstream = new URL(request.url)
    if (upstream.href !== `${CODEX_BASE_URL}/responses`) {
      return new Response('{"error":"relay_target_rejected"}', {
        status: 502, headers: { 'content-type': 'application/json' },
      })
    }
    const headers = new Headers(request.headers)
    headers.set('x-ai-agent-sdk-relay-secret', secret)
    const response = await fetch(`${relayOrigin}/responses`, {
      method: request.method, headers,
      ...(request.body === null ? {} : { body: request.body }),
      signal: request.signal, redirect: 'manual',
    })
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    })
  }
}

function requireRelayOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error('Codex relay origin is missing')
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || url.username.length > 0 || url.password.length > 0
    || url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    throw new Error('Codex relay origin is invalid')
  }
  return url.origin
}

function streamResponse(
  handle: RuntimeAgentRunHandle,
  entry: LiveSession,
  conversationId: string,
): Response {
  const encoder = new TextEncoder()
  let sequence = 0
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let terminal = false
  const send = (type: string, data: Record<string, unknown> = {}): void => {
    if (controller === undefined || terminal) return
    sequence++
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({
      schemaVersion: 1, runId: handle.runId, sequence, type, ...data,
    })}\n\n`))
  }
  const finish = (type: 'complete' | 'failed' | 'aborted', data: Record<string, unknown>): void => {
    if (terminal) return
    send(type, data)
    terminal = true
  }
  const body = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target
      send('start', { conversationId, mode: 'deep-search', provider: 'codex-live' })
      void pump(handle, entry, send, finish).finally(() => {
        controller = undefined
        try { target.close() } catch { /* client disconnected */ }
      })
    },
    async cancel() {
      controller = undefined
      handle.abort()
      await Promise.allSettled([handle.report, entry.session.whenIdle()])
    },
  })
  return new Response(body, { headers: {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } })
}

async function pump(
  handle: RuntimeAgentRunHandle,
  entry: LiveSession,
  send: (type: string, data?: Record<string, unknown>) => void,
  finish: (type: 'complete' | 'failed' | 'aborted', data: Record<string, unknown>) => void,
): Promise<void> {
  try {
    for await (const event of handle) projectEvent(event, send)
    const result = await handle.result
    finish('complete', {
      text: result.text, report: publicReport(result.report),
      evidence: { receipts: entry.evidence.snapshot(), audits: entry.evidence.auditHistory() },
    })
  } catch {
    const report = await handle.report.catch(() => undefined)
    finish(report?.status === 'aborted' ? 'aborted' : 'failed', {
      code: report?.errors.at(-1)?.code ?? 'LIVE_RESEARCH_FAILED',
      stage: report?.errors.at(-1)?.stage ?? 'agent-run',
      message: 'Live Edge research did not complete',
      ...(report === undefined ? {} : { report: publicReport(report) }),
      evidence: { receipts: entry.evidence.snapshot(), audits: entry.evidence.auditHistory() },
    })
  }
}

function projectEvent(
  event: RuntimeAgentRunEvent,
  send: (type: string, data?: Record<string, unknown>) => void,
): void {
  if (event.type === 'assistant-delta') send('delta', { text: boundedText(event.text), phase: 'final-answer' })
  else if (event.type === 'commentary-delta') send('delta', { text: boundedText(event.text), phase: 'commentary' })
  else if (event.type === 'tool-call') send('tool-call', {
    name: boundedText(event.name, 128), callId: boundedText(event.callId, 180),
    family: 'host', status: 'started', input: publicInput(event.name, event.input),
  })
  else if (event.type === 'tool-result') send('tool-result', {
    name: boundedText(event.name, 128), callId: boundedText(event.callId, 180),
    family: 'host', status: event.status, isError: event.status !== 'completed',
    meta: event.output !== null && typeof event.output === 'object'
      ? boundedJson(Reflect.get(event.output, 'meta')) : undefined,
  })
  else if (event.type === 'assistant-native-tool') send('native-tool', {
    name: boundedText(event.name, 128), callId: boundedText(event.callId, 180),
    provider: boundedText(event.provider, 128), family: 'provider-native', status: event.status,
    ...(event.input === undefined ? {} : { input: boundedJson(event.input) }),
    ...(event.output === undefined ? {} : { output: boundedJson(event.output) }),
  })
}

function publicInput(name: string, input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {}
  if (name === 'read_web_page') return {
    url: textField(input, 'url', 2_048), searchQuery: textField(input, 'searchQuery', 500),
  }
  if (name === 'audit_research_evidence') return {
    round: Reflect.get(input, 'round'), criteriaCount: arrayLength(input, 'criteria'),
    claimCount: arrayLength(input, 'claims'), contradictionCount: arrayLength(input, 'contradictions'),
    unresolvedGapCount: arrayLength(input, 'unresolvedGaps'),
  }
  return {}
}

function publicReport(report: Awaited<RuntimeAgentRunHandle['report']>): Record<string, unknown> {
  return { status: report.status, usage: report.usage, operationCounts: report.operationCounts,
    delivery: report.delivery, errors: report.errors.slice(0, 8).map(error => ({
      code: error.code, stage: error.stage, message: error.message,
      usageCoverage: error.usageCoverage,
      possiblyBilledAttemptsWithoutUsage: error.possiblyBilledAttemptsWithoutUsage,
    })) }
}

async function closeSession(request: Request): Promise<Response> {
  const input = await bodyObject(request)
  const conversationId = input === undefined ? undefined : Reflect.get(input, 'conversationId')
  const principal = trustedPrincipal(request)
  if (typeof conversationId !== 'string' || !SESSION_ID.test(conversationId) || principal === undefined) {
    return json({ error: 'invalid_request' }, 400)
  }
  const key = `${principal.length}:${principal}${conversationId}`
  const entry = sessions.get(key)
  if (entry === undefined) return json({ closed: false })
  sessions.delete(key)
  const report = await entry.runtime.close()
  return json({ closed: true, state: report.state, unsettledRuns: report.unsettledRuns,
    observationState: report.observationHealth.state })
}

async function pruneSessions(): Promise<void> {
  const cutoff = Date.now() - 30 * 60_000
  for (const [key, entry] of sessions) {
    if (entry.session.isRunning || entry.touchedAt >= cutoff) continue
    sessions.delete(key)
    await entry.runtime.close()
  }
}

async function bodyObject(request: Request): Promise<object | undefined> {
  try {
    const value: unknown = await request.json()
    return value !== null && typeof value === 'object' ? value : undefined
  } catch { return undefined }
}

function decodeAuth(value: string | undefined): CodexAuthFile {
  if (value === undefined || value.length === 0) throw new TypeError('Codex credential binding is missing')
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (parsed === null || typeof parsed !== 'object') throw new TypeError('credential is not an object')
    return parsed as CodexAuthFile
  } catch { throw new TypeError('Codex credential binding is invalid') }
}

function trustedPrincipal(request: Request): string | undefined {
  const asserted = request.headers.get('cf-access-authenticated-user-email')
  if (asserted !== null && asserted.length > 0 && asserted.length <= 320) return asserted
  const host = new URL(request.url).hostname
  return host === '127.0.0.1' || host === 'localhost' ? 'human-test-principal' : undefined
}

function textField(value: object, key: string, max: number): string | undefined {
  const selected = Reflect.get(value, key)
  return typeof selected === 'string' ? boundedText(selected, max) : undefined
}
function arrayLength(value: object, key: string): number {
  const selected = Reflect.get(value, key)
  return Array.isArray(selected) ? selected.length : 0
}
function boundedText(value: string, max = 2_048): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
function boundedJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return boundedText(value)
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 32).map(item => boundedJson(item, depth + 1))
  if (typeof value !== 'object') return undefined
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 32)) output[boundedText(key, 128)] = boundedJson(item, depth + 1)
  return JSON.stringify(output).length <= 16_384 ? output : { truncated: true }
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...edgeSecurityHeaders() } })
}
