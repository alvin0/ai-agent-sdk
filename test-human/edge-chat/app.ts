import {
  createAgentRuntime,
  defineObservationExporter,
  type AgentRuntime,
  type RuntimeAgentRunEvent,
  type RuntimeAgentRunHandle,
  type RuntimeAgentSession,
} from '@alvin0/ai-agent-sdk-core'
import {
  DEEP_SEARCH_INSTRUCTIONS,
  STANDARD_INSTRUCTIONS,
  auditResearch,
  calculate,
  edgeDemoProvider,
  readWebPage,
  resetScriptedFixture,
  resolveChatMode,
  webSearch,
  type ChatMode,
} from './scripted-fixture.ts'

const MAX_PROMPT_CHARS = 32_000
const MAX_SESSIONS = 128
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
interface EdgeSessionEntry {
  readonly runtime: AgentRuntime
  readonly session: RuntimeAgentSession
  readonly lifetime: AbortController
  touchedAt: number
}
const sessions = new Map<string, EdgeSessionEntry>()

// The scripted model/search scheduler is isolated as hermetic fixture evidence.

export const edgeChatWorker = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(EDGE_CHAT_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...edgeSecurityHeaders() } })
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, runtime: 'web-standards', activeSessions: sessions.size })
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') return chat(request)
    return json({ error: 'not_found' }, 404)
  },
}

export default edgeChatWorker

export async function resetEdgeChatForTests(): Promise<void> {
  const closing = [...sessions.values()].map(async entry => {
    entry.lifetime.abort('test reset')
    await entry.runtime.close()
  })
  sessions.clear()
  resetScriptedFixture()
  await Promise.allSettled(closing)
}

async function chat(request: Request): Promise<Response> {
  let input: unknown
  try { input = await request.json() }
  catch { return json({ error: 'invalid_json' }, 400) }
  if (input === null || typeof input !== 'object') return json({ error: 'invalid_request' }, 400)
  const conversationId = Reflect.get(input, 'conversationId')
  const message = Reflect.get(input, 'message')
  const requestedMode = Reflect.get(input, 'mode')
  if (typeof conversationId !== 'string' || !SESSION_ID.test(conversationId)) {
    return json({ error: 'invalid_conversation_id' }, 400)
  }
  if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_PROMPT_CHARS) {
    return json({ error: 'invalid_message', maxChars: MAX_PROMPT_CHARS }, 400)
  }
  if (requestedMode !== undefined && requestedMode !== 'auto' && requestedMode !== 'deep-search') {
    return json({ error: 'invalid_mode' }, 400)
  }
  const principalId = trustedPrincipal(request)
  if (principalId === undefined) return json({ error: 'authentication_required' }, 401)
  const mode = resolveChatMode(requestedMode as ChatMode | undefined, message)
  const sessionKey = `${principalId.length}:${principalId}${conversationId}`
  await pruneSessions()
  let entry = sessions.get(sessionKey)
  if (entry === undefined) {
    if (sessions.size >= MAX_SESSIONS) return json({ error: 'session_capacity' }, 503)
    entry = await createEdgeSession(conversationId)
    sessions.set(sessionKey, entry)
  }
  if (entry.session.isRunning) return json({ error: 'conversation_busy' }, 409)
  entry.touchedAt = Date.now()
  const runController = new AbortController()
  const abortRun = (): void => runController.abort('request disconnected')
  if (request.signal.aborted) abortRun()
  else request.signal.addEventListener('abort', abortRun, { once: true })
  entry.lifetime.signal.addEventListener('abort', abortRun, { once: true })
  const handle = entry.session.stream(message.trim(), {
    signal: runController.signal,
    ...(mode === 'deep-search' ? { additionalInstructions: DEEP_SEARCH_INSTRUCTIONS } : {}),
  })
  const encoder = new TextEncoder()
  let sequence = 0
  let terminalSent = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const send = (type: string, data: Record<string, unknown> = {}): void => {
    if (streamController === undefined || terminalSent) return
    sequence += 1
    try {
      streamController.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({
        schemaVersion: 1, runId: handle.runId, sequence, type, ...data,
      })}\n\n`))
    } catch { streamController = undefined }
  }
  const terminal = (type: 'complete' | 'failed' | 'aborted', data: Record<string, unknown>): void => {
    if (terminalSent) return
    send(type, data)
    terminalSent = true
  }
  const settleCancellation = async (reason: unknown): Promise<void> => {
    runController.abort(reason)
    handle.abort(reason)
    await waitForIdle(entry!.session, 2_000)
    await Promise.allSettled([handle.report])
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      send('start', { conversationId, mode })
      void pumpRun(handle, entry!.runtime, send, terminal).finally(() => {
        request.signal.removeEventListener('abort', abortRun)
        streamController = undefined
        try { controller.close() } catch { /* response was cancelled */ }
      })
    },
    cancel(reason) { streamController = undefined; return settleCancellation(reason) },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function createEdgeSession(conversationId: string): Promise<EdgeSessionEntry> {
  const lifetime = new AbortController()
  const runtime = await createAgentRuntime({
    providers: [edgeDemoProvider], signal: lifetime.signal, closeTimeoutMs: 2_000,
    ...(conversationId.startsWith('degraded-') ? {
      observability: {
        mode: 'reliable' as const, flushTimeoutMs: 25,
        exporters: [{
          exporter: defineObservationExporter({
            id: 'edge-rejecting-exporter', supportedBoundaries: ['remote-acknowledged'],
            stage() { throw new Error('PRIVATE/EDGE_EXPORTER_FAILURE') },
            async export(batch) { return { batchId: batch.id, acceptedEventIds: [], acceptedRunIds: [] } },
          }),
          ownership: 'owned' as const, requirement: 'required' as const,
          boundary: 'remote-acknowledged' as const,
        }],
      },
    } : {}),
  })
  const agent = runtime.agent({
    id: 'edge-chat', model: { provider: 'edge-demo', id: 'edge-demo-v1' }, effort: 'low',
    mode: 'basic', instructions: STANDARD_INSTRUCTIONS,
    tools: [calculate, webSearch, readWebPage, auditResearch],
    nativeTools: [{ type: 'native', name: 'web-search', searchContextSize: 'high', maxUses: 3 }],
    maxTurns: 12, maxToolCalls: 12, compaction: false,
  })
  const session = agent.createSession({
    conversationId,
    runtimeLimits: { maxSteps: 12, maxToolCalls: 12, maxTotalTokens: 8_000, observerTimeoutMs: 2_000 },
    usagePolicy: { onMissing: 'fail' },
  })
  return { runtime, session, lifetime, touchedAt: Date.now() }
}

async function pumpRun(
  handle: RuntimeAgentRunHandle,
  runtime: AgentRuntime,
  send: (type: string, data?: Record<string, unknown>) => void,
  terminal: (type: 'complete' | 'failed' | 'aborted', data: Record<string, unknown>) => void,
): Promise<void> {
  try {
    for await (const event of handle) projectRunEvent(event, send)
    const result = await handle.result
    if (!result.report.delivery.complete) {
      terminal('failed', {
        code: 'OBSERVATION_DEGRADED', stage: 'observation-delivery',
        message: 'Required observation delivery did not complete',
        report: publicRunReport(result.report),
      })
    } else terminal('complete', { text: result.text, report: publicRunReport(result.report) })
  } catch {
    const report = await handle.report.catch(() => undefined)
    const aborted = report?.status === 'aborted'
    const health = runtime.diagnostics().observationHealth
    const degraded = (report !== undefined && !report.delivery.complete)
      || health.state === 'degraded' || health.state === 'failed'
    terminal(aborted ? 'aborted' : 'failed', {
      code: aborted ? 'RUN_ABORTED' : degraded ? 'OBSERVATION_DEGRADED'
        : report?.errors.at(-1)?.code ?? 'AGENT_RUN_FAILED',
      stage: degraded ? 'observation-delivery' : report?.errors.at(-1)?.stage ?? 'agent-run',
      message: aborted ? 'The run was cancelled' : degraded
        ? 'Required observation delivery did not complete' : 'The agent run did not complete',
      ...(report === undefined ? {} : { report: publicRunReport(report) }),
    })
  }
}

function projectRunEvent(
  event: RuntimeAgentRunEvent,
  send: (type: string, data?: Record<string, unknown>) => void,
): void {
  if (event.type === 'assistant-delta') send('delta', { text: boundedText(event.text), phase: 'final-answer' })
  else if (event.type === 'commentary-delta') send('delta', { text: boundedText(event.text), phase: 'commentary' })
  else if (event.type === 'tool-call') send('tool-call', {
    name: boundedText(event.name, 128), callId: boundedText(event.callId, 128),
    input: publicToolInput(event.name, event.input), family: 'host', status: 'started',
  })
  else if (event.type === 'tool-result') send('tool-result', {
    name: boundedText(event.name, 128), callId: boundedText(event.callId, 128), family: 'host',
    status: event.status, isError: event.status !== 'completed',
    ...publicToolResult(event.output),
  })
  else if (event.type === 'assistant-native-tool') send('native-tool', {
    name: boundedText(event.name, 128), callId: boundedText(event.callId, 128),
    provider: boundedText(event.provider, 128), family: 'provider-native', status: event.status,
    ...(event.input === undefined ? {} : { input: boundedJson(event.input) }),
    ...(event.output === undefined ? {} : { output: boundedJson(event.output) }),
  })
}

function publicRunReport(report: Awaited<RuntimeAgentRunHandle['report']>): Record<string, unknown> {
  return {
    status: report.status,
    usage: report.usage,
    operationCounts: report.operationCounts,
    delivery: {
      mode: report.delivery.mode,
      requiredBoundary: report.delivery.requiredBoundary,
      reachedBoundary: report.delivery.reachedBoundary,
      complete: report.delivery.complete,
    },
    errors: report.errors.map(error => ({
      code: error.code, stage: error.stage, message: error.message,
      usageCoverage: error.usageCoverage,
      possiblyBilledAttemptsWithoutUsage: error.possiblyBilledAttemptsWithoutUsage,
    })).slice(0, 8),
  }
}

async function waitForIdle(session: RuntimeAgentSession, timeoutMs: number): Promise<void> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort('idle deadline'), timeoutMs)
  try { await session.whenIdle(deadline.signal) } catch { /* bounded cancellation evidence remains in the report */ }
  finally { clearTimeout(timer) }
}

function trustedPrincipal(request: Request): string | undefined {
  const asserted = request.headers.get('cf-access-authenticated-user-email')
  if (asserted !== null && asserted.length > 0 && asserted.length <= 320) return asserted
  const host = new URL(request.url).hostname
  return host === 'edge.test' || host === '127.0.0.1' || host === 'localhost'
    ? 'human-test-principal'
    : undefined
}


async function pruneSessions(): Promise<void> {
  const cutoff = Date.now() - 30 * 60_000
  const closing: Promise<unknown>[] = []
  for (const [id, entry] of sessions) {
    if (entry.session.isRunning || entry.touchedAt >= cutoff) continue
    sessions.delete(id)
    entry.lifetime.abort('session expired')
    closing.push(entry.runtime.close())
  }
  await Promise.allSettled(closing)
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...edgeSecurityHeaders() },
  })
}

function publicToolInput(name: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {}
  const input = value as Record<string, unknown>
  if (name === 'web_search' && typeof input.query === 'string') return { query: input.query }
  if (name === 'read_web_page' && typeof input.url === 'string') return { url: input.url }
  if (name === 'audit_research') {
    return {
      ...(typeof input.round === 'number' ? { round: input.round } : {}),
      sourceCount: Array.isArray(input.sourceUrls) ? input.sourceUrls.length : 0,
      requiredTopics: Array.isArray(input.requiredTopics)
        ? input.requiredTopics.filter(topic => typeof topic === 'string').slice(0, 10)
        : [],
    }
  }
  if (name === 'calculate') {
    return {
      ...(typeof input.left === 'number' ? { left: input.left } : {}),
      ...(typeof input.right === 'number' ? { right: input.right } : {}),
    }
  }
  return {}
}

function publicToolResult(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {}
  const meta = Reflect.get(value, 'meta')
  return meta === undefined ? {} : { meta: boundedJson(meta) }
}

function boundedJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return boundedText(value)
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 32).map(item => boundedJson(item, depth + 1))
  if (typeof value !== 'object') return undefined
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    const projected = boundedJson(item, depth + 1)
    if (projected !== undefined) output[boundedText(key, 128)] = projected
  }
  return JSON.stringify(output).length <= 8_192 ? output : { truncated: true }
}

function boundedText(value: string, max = 1_024): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export function edgeSecurityHeaders(): Record<string, string> {
  return {
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

export const EDGE_CHAT_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Edge Chat · AI Agent SDK</title><style>
:root{color-scheme:dark;--bg:#0b0d10;--panel:#14171c;--line:#292e37;--text:#f5f7fa;--muted:#9ba5b4;--accent:#63e6be;--warn:#f7c66b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 60% 0,#19252b 0,var(--bg) 40%);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}.shell{display:grid;grid-template-columns:250px 1fr;min-height:100dvh}.sidebar{padding:20px;border-right:1px solid var(--line);background:#0e1115}.brand{font-weight:750;letter-spacing:.02em}.runtime{color:var(--accent);font-size:12px;margin-top:4px}.new{width:100%;margin-top:24px;padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:inherit;cursor:pointer}.main{display:grid;grid-template-rows:auto 1fr auto;min-width:0}.top{padding:16px 24px;border-bottom:1px solid var(--line);color:var(--muted)}.messages{width:min(820px,100%);margin:0 auto;padding:30px 22px 120px}.message{display:grid;grid-template-columns:34px 1fr;gap:12px;margin:0 0 26px}.avatar{height:34px;border-radius:9px;display:grid;place-items:center;background:#232933}.assistant .avatar{background:var(--accent);color:#06251d}.body{white-space:pre-wrap;overflow-wrap:anywhere}.meta{font-size:12px;color:var(--muted);margin-top:6px}.tools{display:grid;gap:7px;margin:10px 0 12px;padding-left:2px}.tool-item{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:#11151a}.tool-head{display:flex;align-items:center;gap:8px;font-size:13px}.tool-dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.tool-item[data-status=running] .tool-dot{background:var(--warn);box-shadow:0 0 0 4px #f7c66b20}.tool-item[data-status=done] .tool-dot{background:var(--accent)}.tool-item[data-status=error] .tool-dot{background:#ff7b7b}.tool-detail{color:var(--muted);font-size:12px;margin:3px 0 0 16px;overflow-wrap:anywhere}.tool-sources{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0 16px}.tool-sources a{color:#8ecbff;font-size:12px;text-decoration:none;border-bottom:1px dotted #8ecbff80}.audit-missing{color:var(--warn)}.empty{padding-top:18vh;text-align:center}.empty h1{font-size:clamp(30px,5vw,52px);margin:0}.empty p{color:var(--muted)}.composer-wrap{position:fixed;bottom:0;left:250px;right:0;padding:18px;background:linear-gradient(transparent,var(--bg) 25%)}form{display:flex;gap:10px;width:min(820px,100%);margin:auto;padding:10px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 15px 50px #0008}textarea{resize:none;flex:1;border:0;outline:0;background:transparent;color:inherit;font:inherit;max-height:160px;padding:8px}button[type=submit]{width:42px;height:42px;border:0;border-radius:11px;background:var(--accent);font-size:20px;cursor:pointer}button:disabled{opacity:.45}.status{font-size:12px;color:var(--muted);text-align:center;margin-top:8px}@media(max-width:700px){.shell{grid-template-columns:1fr}.sidebar{display:none}.composer-wrap{left:0}.top{padding:12px 16px}.messages{padding-inline:16px}}
.top{display:flex;justify-content:space-between;gap:16px}.top-note{font-size:12px;color:#737f90}.composer-box{width:min(820px,100%);margin:auto;border:1px solid var(--line);border-radius:17px;background:var(--panel);box-shadow:0 15px 50px #0008}.composer-box form{width:100%;border:0;box-shadow:none;margin:0}.mode-row{display:flex;align-items:center;gap:10px;padding:8px 12px 0;color:var(--muted);font-size:12px}.mode-row button{border:1px solid var(--line);border-radius:999px;background:#10141a;color:var(--muted);padding:6px 10px;cursor:pointer}.mode-row button[aria-pressed=true]{border-color:#63e6be80;background:#123027;color:var(--accent)}.agent-progress{margin:4px 0 12px;border-left:2px solid #38414d;padding:2px 0 2px 14px}.agent-progress-title{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.agent-progress-item{position:relative;color:#b8c1cd;font-size:13px;margin:7px 0}.agent-progress-item:before{content:'';position:absolute;width:6px;height:6px;border-radius:50%;background:#657080;left:-18px;top:7px}.agent-progress-item:first-of-type{color:#e3e8ef}.agent-progress-item:first-of-type:before{background:var(--accent)}.markdown{white-space:normal;line-height:1.65}.markdown h1,.markdown h2,.markdown h3{line-height:1.25;margin:1.15em 0 .55em}.markdown h2{font-size:1.45rem}.markdown h3{font-size:1.1rem;color:#dbe2eb}.markdown p{margin:.55em 0}.markdown ul,.markdown ol{padding-left:1.45rem}.markdown li{margin:.3em 0}.markdown blockquote{margin:.8em 0;padding:.45em .8em;border-left:3px solid #5d6a79;color:var(--muted);background:#11151a}.markdown code{padding:.12em .35em;border-radius:5px;background:#222933;color:#a8e8d6}.markdown pre{padding:12px;border:1px solid var(--line);border-radius:10px;background:#090b0e;overflow:auto}.markdown pre code{padding:0;background:transparent}.markdown a{color:#8ecbff;text-decoration:none;border-bottom:1px dotted #8ecbff80}@media(max-width:700px){.top-note{display:none}.composer-wrap{padding-inline:10px}.mode-row{padding-top:7px}}
.main{height:100dvh;overflow:hidden}.messages{overflow-y:auto;padding-bottom:32px}.composer-wrap{position:static;left:auto;right:auto}
</style></head><body><div class="shell"><aside class="sidebar"><div class="brand">AI Agent SDK</div><div class="runtime">● Edge / Web Standards</div><button class="new" id="new-chat" data-testid="new-chat">＋ Cuộc trò chuyện mới</button></aside><main class="main"><header class="top"><span>Edge research assistant</span><span class="top-note">Agentic plan · audited evidence · Markdown report</span></header><section class="messages" id="messages" aria-live="polite"><div class="empty" id="empty"><h1>Edge Chat</h1><p>Streaming, adaptive research, tool trace và local persistence.</p></div></section><div class="composer-wrap"><div class="composer-box"><div class="mode-row"><button type="button" id="deep-search-toggle" data-testid="deep-search-toggle" aria-pressed="false"><span>✦</span> Deep search</button><span id="mode-hint">Tự nhận diện từ yêu cầu</span></div><form id="composer"><textarea id="prompt" data-testid="prompt" rows="1" maxlength="32000" placeholder="Nhắn tin cho Edge Chat…" aria-label="Tin nhắn"></textarea><button data-testid="send" type="submit" aria-label="Gửi">↑</button></form></div><div class="status" id="status">Sẵn sàng</div></div></main></div><script>
const key='ai-agent-sdk-edge-chat-v3';
const testEvents=[];Object.defineProperty(globalThis,'__EDGE_CHAT_EVENTS__',{value:testEvents,writable:false,configurable:false});
const el={messages:document.querySelector('#messages'),empty:document.querySelector('#empty'),form:document.querySelector('#composer'),prompt:document.querySelector('#prompt'),send:document.querySelector('[data-testid=send]'),status:document.querySelector('#status'),mode:document.querySelector('#deep-search-toggle'),modeHint:document.querySelector('#mode-hint')};
let state=load();let active;
function fresh(deepSearch){return{conversationId:crypto.randomUUID(),deepSearch:deepSearch===true,messages:[]}}
function load(){try{const value=JSON.parse(localStorage.getItem(key));if(!value||!Array.isArray(value.messages))return fresh(false);value.deepSearch=value.deepSearch===true;return value}catch{return fresh(false)}}
function save(){localStorage.setItem(key,JSON.stringify(state))}
function syncMode(){el.mode.setAttribute('aria-pressed',String(state.deepSearch));el.modeHint.textContent=state.deepSearch?'Agent sẽ tự lập plan và audit đến khi đủ':'Tự nhận diện từ yêu cầu'}
function render(){el.messages.querySelectorAll('.message').forEach(node=>node.remove());el.empty.hidden=state.messages.length>0;state.messages.forEach(add);syncMode();scrollMessages()}
function add(message){const row=document.createElement('article');row.className='message '+message.role;row.dataset.role=message.role;const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=message.role==='user'?'U':'A';const wrap=document.createElement('div');const body=document.createElement('div');body.className='body'+(message.role==='assistant'?' markdown':'');if(message.role==='assistant'&&message.done)renderMarkdown(message.text,body);else body.textContent=message.text;wrap.append(body);if(message.role==='assistant'){renderProgress(message,wrap);renderTools(message,wrap)}if(message.meta){const meta=document.createElement('div');meta.className='meta';meta.textContent=message.meta;wrap.append(meta)}row.append(avatar,wrap);el.messages.append(row);return{row,body,wrap}}
function scrollMessages(){el.messages.scrollTop=el.messages.scrollHeight}
function appendProgress(message,wrap,text){const progress=message.progress||(message.progress=[]);if(message.progressOpen!==true||!progress.length){progress.push('');message.progressOpen=true;if(progress.length>40)progress.shift();renderProgress(message,wrap)}progress[progress.length-1]+=text;const items=wrap.querySelectorAll('.agent-progress-item'),item=items[items.length-1];if(item)item.textContent=progress[progress.length-1];scrollMessages()}
function closeProgress(message){message.progressOpen=false}
function renderProgress(message,wrap){wrap.querySelector('.agent-progress')?.remove();const progress=message.progress||[];if(!progress.length)return;const panel=document.createElement('section');panel.className='agent-progress';panel.dataset.testid='agent-progress';const title=document.createElement('div');title.className='agent-progress-title';title.textContent='Quá trình của agent';panel.append(title);for(const text of progress){const item=document.createElement('div');item.className='agent-progress-item';item.textContent=text;panel.append(item)}wrap.insertBefore(panel,wrap.querySelector('.tools')||wrap.querySelector('.body'))}
function renderTools(message,wrap){wrap.querySelector('.tools')?.remove();const tools=message.tools||[];if(!tools.length)return;const panel=document.createElement('div');panel.className='tools';panel.dataset.testid='tool-process';for(const tool of tools){const item=document.createElement('div');item.className='tool-item';item.dataset.status=tool.status;item.dataset.tool=tool.name;const head=document.createElement('div');head.className='tool-head';const dot=document.createElement('span');dot.className='tool-dot';const label=document.createElement('span');label.textContent=toolTitle(tool);head.append(dot,label);item.append(head);const detail=document.createElement('div');detail.className='tool-detail';detail.textContent=toolDetail(tool);if(tool.meta?.kind==='research-audit'&&tool.meta.sufficient===false)detail.classList.add('audit-missing');item.append(detail);const sources=tool.meta?.sources||[];if(sources.length){const links=document.createElement('div');links.className='tool-sources';for(const source of sources){if(typeof source.url!=='string'||!source.url.startsWith('https://'))continue;const link=document.createElement('a');link.href=source.url;link.target='_blank';link.rel='noreferrer noopener';link.textContent=source.title||source.url;links.append(link)}item.append(links)}panel.append(item)}wrap.insertBefore(panel,wrap.querySelector('.body'))}
function toolTitle(tool){if(tool.name==='web_search')return'Tìm kiếm web';if(tool.name==='read_web_page')return'Đọc nguồn';if(tool.name==='audit_research'||tool.name==='audit_research_evidence')return'Audit nghiên cứu · vòng '+(tool.input?.round||tool.meta?.round||'?');if(tool.name==='calculate')return'Tính toán';return tool.name}
function toolDetail(tool){if(tool.status==='running'){if(tool.input?.query)return tool.input.query;if(tool.input?.url)return tool.input.url;return'Đang thực thi…'}if(tool.status==='error')return'Tool thất bại';if(tool.meta?.kind==='web-search')return'Tìm thấy '+tool.meta.resultCount+' nguồn';if(tool.meta?.kind==='web-page')return'Đã đọc: '+tool.meta.title;if(tool.meta?.kind==='research-audit')return tool.meta.sufficient?'Đạt · coverage đủ để viết báo cáo':'Chưa đủ · tiếp tục tìm bằng chứng';if(tool.meta?.kind==='research-evidence-audit')return tool.meta.eligibleForIndependentReview?'Đủ provenance/coverage · chờ người review':'Chưa đủ · còn thiếu hoặc có evidence bị từ chối';return'Hoàn tất'}
function renderMarkdown(markdown,target){target.replaceChildren();const lines=markdown.split('\\n'),fence=String.fromCharCode(96).repeat(3);for(let index=0;index<lines.length;){const line=lines[index];if(!line.trim()){index++;continue}if(line.startsWith(fence)){const pre=document.createElement('pre'),code=document.createElement('code');const body=[];index++;while(index<lines.length&&!lines[index].startsWith(fence))body.push(lines[index++]);if(index<lines.length)index++;code.textContent=body.join('\\n');pre.append(code);target.append(pre);continue}const heading=/^(#{1,3})\\s+(.+)$/.exec(line);if(heading){const node=document.createElement('h'+heading[1].length);appendInline(node,heading[2]);target.append(node);index++;continue}if(/^>\\s?/u.test(line)){const quote=document.createElement('blockquote');appendInline(quote,line.replace(/^>\\s?/u,''));target.append(quote);index++;continue}const list=/^(\\s*)([-*]|\\d+\\.)\\s+(.+)$/.exec(line);if(list){const ordered=/\\d+\\./u.test(list[2]),node=document.createElement(ordered?'ol':'ul');while(index<lines.length){const item=/^(\\s*)([-*]|\\d+\\.)\\s+(.+)$/.exec(lines[index]);if(!item||/\\d+\\./u.test(item[2])!==ordered)break;const li=document.createElement('li');appendInline(li,item[3]);node.append(li);index++}target.append(node);continue}const paragraph=[];while(index<lines.length&&lines[index].trim()&&!isMarkdownBlock(lines[index]))paragraph.push(lines[index++].trim());if(!paragraph.length){paragraph.push(line.trim());index++}const node=document.createElement('p');appendInline(node,paragraph.join(' '));target.append(node)}}
function isMarkdownBlock(line){return /^(#{1,3})\\s+|^\\x60{3}|^>\\s?|^(\\s*)([-*]|\\d+\\.)\\s+/u.test(line)}
function appendInline(parent,text){const pattern=/(\\x60[^\\x60]+\\x60|\\*\\*[^*]+\\*\\*|\\[[^\\]]+\\]\\(https:\\/\\/[^)\\s]+\\))/gu;let cursor=0;for(const match of text.matchAll(pattern)){parent.append(document.createTextNode(text.slice(cursor,match.index)));const token=match[0];if(token.startsWith('**')){const strong=document.createElement('strong');strong.textContent=token.slice(2,-2);parent.append(strong)}else if(token.charCodeAt(0)===96){const code=document.createElement('code');code.textContent=token.slice(1,-1);parent.append(code)}else{const linkMatch=/^\\[([^\\]]+)\\]\\((https:\\/\\/[^)]+)\\)$/u.exec(token);if(linkMatch){const link=document.createElement('a');link.textContent=linkMatch[1];link.href=linkMatch[2];link.target='_blank';link.rel='noreferrer noopener';parent.append(link)}}cursor=match.index+token.length}parent.append(document.createTextNode(text.slice(cursor)))}
async function send(text){state.messages.push({role:'user',text});const assistant={role:'assistant',text:'',meta:'Đang kết nối…',progress:[],tools:[],done:false,progressOpen:false};state.messages.push(assistant);save();render();const row=el.messages.lastElementChild;const view={body:row.querySelector('.body'),wrap:row.querySelector('div:nth-child(2)'),meta:row.querySelector('.meta')};active=new AbortController();busy(true);try{const mode=state.deepSearch?'deep-search':'auto';const response=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:state.conversationId,message:text,mode}),signal:active.signal});if(!response.ok)throw new Error('HTTP '+response.status);const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',event='message',lastSequence=0,terminal=false;while(true){const result=await reader.read();if(result.done)break;pending+=decoder.decode(result.value,{stream:true});let cut;while((cut=pending.indexOf('\\n'))>=0){const line=pending.slice(0,cut).replace(/\\r$/,'');pending=pending.slice(cut+1);if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:')){const data=JSON.parse(line.slice(5));if(data.schemaVersion!==1||data.type!==event||data.sequence!==lastSequence+1)throw new Error('Luồng SSE không hợp lệ hoặc bị thiếu sự kiện');lastSequence=data.sequence;testEvents.push({type:event,data});if(event==='start'){assistant.mode=data.mode}else if(event==='delta'){if(data.phase==='commentary'){appendProgress(assistant,view.wrap,data.text)}else{assistant.text+=data.text;view.body.textContent=assistant.text;scrollMessages()}}else if(event==='tool-call'||event==='native-tool'&&data.status==='started'){closeProgress(assistant);assistant.tools.push({callId:data.callId,name:data.name,input:data.input,status:'running',family:data.family});assistant.meta='Đang dùng '+data.name;view.meta.textContent=assistant.meta;renderTools(assistant,view.wrap);scrollMessages();save()}else if(event==='tool-result'||event==='native-tool'){closeProgress(assistant);let tool=assistant.tools.find(item=>item.callId===data.callId);if(!tool){tool={callId:data.callId,name:data.name,status:'running',family:data.family};assistant.tools.push(tool)}tool.status=data.status==='completed'?'done':data.status==='started'?'running':'error';tool.meta=data.meta;renderTools(assistant,view.wrap);scrollMessages();save()}else if(event==='complete'){terminal=true;closeProgress(assistant);assistant.text=data.text;assistant.done=true;assistant.meta='Hoàn tất · '+assistant.mode+' · '+assistant.tools.length+' tool calls';view.meta.textContent=assistant.meta;renderMarkdown(assistant.text,view.body);scrollMessages()}else if(event==='failed'||event==='aborted'){terminal=true;throw new Error(event==='aborted'?'Đã dừng':'Agent không thể hoàn tất')}}}}if(!terminal)throw new Error('Luồng kết thúc chưa đầy đủ; không tự động phát lại');save();el.status.textContent='Sẵn sàng'}catch(error){assistant.meta=error.name==='AbortError'?'Đã dừng':'Lỗi: '+error.message;el.status.textContent=assistant.meta;save();render()}finally{active=undefined;busy(false)}}
function busy(value){el.send.disabled=value;el.prompt.disabled=value;el.mode.disabled=value;el.status.textContent=value?'Đang tạo phản hồi…':'Sẵn sàng'}
el.form.addEventListener('submit',event=>{event.preventDefault();const text=el.prompt.value.trim();if(!text||active)return;el.prompt.value='';void send(text)});
el.mode.addEventListener('click',()=>{if(active)return;state.deepSearch=!state.deepSearch;save();syncMode();el.prompt.focus()});
document.querySelector('#new-chat').addEventListener('click',()=>{active?.abort();state=fresh(state.deepSearch);save();render();el.prompt.focus()});
el.prompt.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();el.form.requestSubmit()}});render();
</script></body></html>`
