import {
  ModelAdapter,
  ReasoningEffortId,
  ToolCallId,
  defineTool,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'

const DEEP_SEARCH_POLICY_MARKER = '<deep_search_policy>'
export type ChatMode = 'auto' | 'deep-search'
type EffectiveChatMode = 'standard' | 'deep-search'
export const edgeFixtureRequests: GenerateOptions[] = []
export function resetScriptedFixture(): void { edgeFixtureRequests.length = 0 }

interface SearchDocument {
  readonly title: string
  readonly url: string
  readonly summary: string
  readonly content: string
  readonly tags: readonly string[]
}

const SEARCH_DOCUMENTS: readonly SearchDocument[] = Object.freeze([
  Object.freeze({
    title: 'MDN Streams API',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Streams_API',
    summary: 'Web Streams provide incremental readable, writable, and transform pipelines.',
    content: 'ReadableStream lets a web application consume data incrementally. Fetch response bodies are readable streams and can be decoded progressively without buffering the full response.',
    tags: ['web', 'standards', 'stream', 'readablestream', 'fetch', 'edge'],
  }),
  Object.freeze({
    title: 'MDN Fetch API',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    summary: 'Fetch is the Web Standard request/response API available across modern runtimes.',
    content: 'The Fetch API is built around Request, Response, Headers, AbortSignal, and Promise. It provides a portable HTTP boundary for browsers and Edge runtimes.',
    tags: ['web', 'standards', 'fetch', 'request', 'response', 'abortsignal', 'edge'],
  }),
  Object.freeze({
    title: 'Cloudflare Workers Runtime APIs',
    url: 'https://developers.cloudflare.com/workers/runtime-apis/',
    summary: 'Workers expose Web Platform APIs in an isolate-based Edge runtime.',
    content: 'Workers support Web Platform primitives including fetch, Request, Response, ReadableStream, crypto, and AbortController. Node-specific APIs require explicit compatibility support.',
    tags: ['cloudflare', 'workers', 'edge', 'web', 'standards', 'runtime'],
  }),
  Object.freeze({
    title: 'Cloudflare Durable Objects',
    url: 'https://developers.cloudflare.com/durable-objects/',
    summary: 'Durable Objects coordinate stateful workloads with a stable object identity.',
    content: 'Durable Objects combine compute with durable storage and a globally addressable identity. A conversation id can route chat turns to one object so session state is coordinated instead of relying on an ephemeral isolate Map.',
    tags: ['cloudflare', 'durable', 'objects', 'state', 'conversation', 'session', 'edge'],
  }),
])

class EdgeDemoAdapter extends ModelAdapter {
  override resolveModel(provider: string, model: string) {
    const effort = ReasoningEffortId('low')
    return Promise.resolve({
      provider,
      id: model,
      name: 'Deterministic Edge Demo',
      context: { contextWindow: 32_000 },
      reasoning: { efforts: [{ id: effort, name: 'low' }], defaultEffort: effort },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    edgeFixtureRequests.push(options)
    const prompt = latestUserText(options.messages)
    if (prompt.includes('[native-search]')) {
      yield { type: 'block-end', index: 0, block: {
        type: 'native-tool-call', id: 'edge-native-web-1', name: 'web-search', status: 'completed',
        arguments: { query: 'bounded fixture query' },
        content: [{ type: 'text', text: 'bounded fixture result' }],
      } }
      yield { type: 'usage', usage: usageFor(prompt, 24) }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (prompt.includes('[missing-usage]')) {
      yield { type: 'text-delta', index: 0, text: 'usage probe' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'usage probe' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (prompt.includes('[fail]')) {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'EDGE_FIXTURE_FAILURE', message: 'PRIVATE/PROVIDER_BODY_SENTINEL',
      } } }
      return
    }
    if (options.system?.includes(DEEP_SEARCH_POLICY_MARKER) === true) {
      yield* deepSearchResponse(options, prompt)
      return
    }
    const toolResult = latestToolResult(options.messages)
    if (toolResult !== undefined) {
      yield* textResponse(`Kết quả tính toán là ${toolResult}. Phép tính được thực thi bởi tool chạy ngay trong Edge agent.`, options)
      return
    }
    const calculation = parseCalculation(prompt)
    if (calculation !== undefined) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: ToolCallId(`edge-calc-${crypto.randomUUID()}`),
          name: 'calculate',
          arguments: JSON.stringify(calculation),
        },
      }
      yield { type: 'usage', usage: usageFor(prompt, 8) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const turn = options.messages.filter(message => message.source.kind === 'user').length
    yield* textResponse(
      `Xin chào! Đây là phản hồi streaming từ AI Agent SDK trên Edge runtime. Tôi đã nhận lượt hội thoại thứ ${turn}: “${prompt}”`,
      options,
      prompt.includes('[slow]') ? 15 : 0,
    )
  }
}

export const calculate = defineTool({
  name: 'calculate',
  description: 'Multiply two finite numbers.',
  parameters: {
    type: 'object',
    properties: { left: { type: 'number' }, right: { type: 'number' } },
    required: ['left', 'right'],
    additionalProperties: false,
  },
  parse(value: unknown): { left: number; right: number } {
    if (value === null || typeof value !== 'object') throw new TypeError('calculation arguments must be an object')
    const left = Reflect.get(value, 'left')
    const right = Reflect.get(value, 'right')
    if (typeof left !== 'number' || !Number.isFinite(left) || typeof right !== 'number' || !Number.isFinite(right)) {
      throw new TypeError('left and right must be finite numbers')
    }
    return { left, right }
  },
  execute: ({ left, right }) => ({ operation: 'multiply', result: left * right }),
})

export const webSearch = defineTool({
  name: 'web_search',
  description: 'Search a bounded deterministic web corpus. The production host can replace this execution body with a real search provider.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['query'],
    additionalProperties: false,
  },
  parse(value: unknown): { query: string } {
    if (value === null || typeof value !== 'object') throw new TypeError('search arguments must be an object')
    const query = Reflect.get(value, 'query')
    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200) {
      throw new TypeError('query must contain 1-200 characters')
    }
    return { query: query.trim() }
  },
  execute: ({ query }) => ({ query, results: searchDocuments(query).map(({ content: _content, tags: _tags, ...document }) => document) }),
  meta: (value, { query }) => {
    const result = value as { results?: readonly { title?: string; url?: string }[] } | undefined
    const sources = (result?.results ?? []).flatMap(source => (
      typeof source.title === 'string' && typeof source.url === 'string'
        ? [{ title: source.title, url: source.url }]
        : []
    ))
    return { kind: 'web-search', query, resultCount: sources.length, sources }
  },
})

export const readWebPage = defineTool({
  name: 'read_web_page',
  description: 'Read one allowlisted page returned by web_search.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', minLength: 1, maxLength: 500 } },
    required: ['url'],
    additionalProperties: false,
  },
  parse(value: unknown): { url: string } {
    if (value === null || typeof value !== 'object') throw new TypeError('page arguments must be an object')
    const url = Reflect.get(value, 'url')
    if (typeof url !== 'string' || url.length === 0 || url.length > 500) throw new TypeError('url must contain 1-500 characters')
    if (!SEARCH_DOCUMENTS.some(document => document.url === url)) throw new Error('read_web_page only accepts URLs returned by the allowlisted search corpus')
    return { url }
  },
  execute: ({ url }) => {
    const document = SEARCH_DOCUMENTS.find(candidate => candidate.url === url)
    if (document === undefined) throw new Error('allowlisted page is unavailable')
    return { title: document.title, url: document.url, content: document.content }
  },
  meta: (value, { url }) => {
    const title = value !== undefined && value !== null && typeof value === 'object' && typeof Reflect.get(value, 'title') === 'string'
      ? String(Reflect.get(value, 'title'))
      : 'Web page'
    return { kind: 'web-page', title, url }
  },
})

export const auditResearch = defineTool({
  name: 'audit_research',
  description: 'Audit whether read sources cover every required research topic. A final report is forbidden until this returns sufficient.',
  parameters: {
    type: 'object',
    properties: {
      round: { type: 'integer', minimum: 1, maximum: 10 },
      sourceUrls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      requiredTopics: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
    },
    required: ['round', 'sourceUrls', 'requiredTopics'],
    additionalProperties: false,
  },
  parse(value: unknown): { round: number; sourceUrls: string[]; requiredTopics: string[] } {
    if (value === null || typeof value !== 'object') throw new TypeError('audit arguments must be an object')
    const round = Reflect.get(value, 'round')
    const sourceUrls = Reflect.get(value, 'sourceUrls')
    const requiredTopics = Reflect.get(value, 'requiredTopics')
    if (!Number.isSafeInteger(round) || (round as number) < 1 || (round as number) > 10) throw new TypeError('round must be an integer from 1 to 10')
    if (!Array.isArray(sourceUrls) || sourceUrls.length < 1 || sourceUrls.length > 20 || sourceUrls.some(url => typeof url !== 'string')) {
      throw new TypeError('sourceUrls must contain 1-20 strings')
    }
    if (!Array.isArray(requiredTopics) || requiredTopics.length < 1 || requiredTopics.length > 10 || requiredTopics.some(topic => typeof topic !== 'string')) {
      throw new TypeError('requiredTopics must contain 1-10 strings')
    }
    return { round: round as number, sourceUrls: [...sourceUrls] as string[], requiredTopics: [...requiredTopics] as string[] }
  },
  execute: ({ round, sourceUrls, requiredTopics }) => {
    const allowed = sourceUrls.filter(url => SEARCH_DOCUMENTS.some(document => document.url === url))
    const coverage = {
      'web-streaming': allowed.some(url => url.includes('/Streams_API')),
      'stateful-conversation': allowed.some(url => url.includes('/durable-objects/')),
    } as const
    const missingTopics = requiredTopics.filter(topic => coverage[topic as keyof typeof coverage] !== true)
    return {
      round,
      sufficient: missingTopics.length === 0,
      checkedSources: allowed.length,
      missingTopics,
      instruction: missingTopics.length === 0
        ? 'Coverage gate passed; the final report may be written.'
        : 'Coverage gate failed; continue searching and reading before the next audit.',
    }
  },
  meta: (value, { round }) => {
    const result = value as { sufficient?: boolean; checkedSources?: number; missingTopics?: string[] } | undefined
    return {
      kind: 'research-audit',
      round,
      sufficient: result?.sufficient === true,
      checkedSources: result?.checkedSources ?? 0,
      missingTopics: result?.missingTopics ?? [],
    }
  },
})

export const edgeDemoProvider = defineModelProviderPlugin({
  id: 'edge-demo-provider', displayName: 'Deterministic Edge Demo', family: 'edge-demo',
  routes: ['edge-demo'], defaultModel: { provider: 'edge-demo', id: 'edge-demo-v1' },
  setup(registrar) { registrar.registerAdapter(new EdgeDemoAdapter()) },
})

export const STANDARD_INSTRUCTIONS = 'You are a concise Edge runtime assistant. Use calculate for multiplication. Give a direct answer unless the host enables the bounded deep-search overlay.'
export const DEEP_SEARCH_INSTRUCTIONS = `${DEEP_SEARCH_POLICY_MARKER}
You are in deep-search mode. Treat research as an adaptive agent task, not a fixed workflow.
- Derive a concise plan from the user's request and expose meaningful progress before tool calls.
- Search broadly, then read the actual authoritative pages needed for each claim; snippets are not evidence.
- Build every audit from the sources actually read and the criteria derived from the request.
- If an audit reports missing coverage, revise the plan and investigate those gaps. Do not follow a predeclared number of rounds.
- Write the final Markdown report only after the latest audit is sufficient. Cite the pages actually read.`

async function* textResponse(text: string, options: GenerateOptions, delayMs = 0): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (const token of text.match(/\S+\s*/gu) ?? [text]) {
    options.signal?.throwIfAborted()
    yield { type: 'text-delta', index: 0, text: token, phase: 'final-answer' }
    if (delayMs === 0) await Promise.resolve()
    else await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  yield { type: 'block-end', index: 0, block: { type: 'text', text, phase: 'final-answer' } }
  yield { type: 'usage', usage: usageFor(latestUserText(options.messages), text.length) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* deepSearchResponse(options: GenerateOptions, prompt: string): AsyncIterable<StreamChunk> {
  const state = inspectResearch(options.messages)
  const requiredTopics = researchTopics(prompt)
  if (state.searches.length === 0) {
    const plan = `Kế hoạch: xác định ${requiredTopics.map(topicLabel).join(' và ')}; tìm nguồn chính; đọc bằng chứng; audit coverage; tự bổ sung phần còn thiếu trước khi viết báo cáo.`
    yield* researchToolRound(options, plan, 'web_search', { query: initialResearchQuery(prompt) })
    return
  }
  if (state.reads.length === 0) {
    const candidate = selectUnreadResult(state.searches.at(-1)?.results ?? [], requiredTopics, state.reads)
    if (candidate !== undefined) {
      yield* researchToolRound(options, `Đã có danh sách nguồn. Đang đọc ${candidate.title} để kiểm chứng thay vì dùng search snippet.`, 'read_web_page', { url: candidate.url })
      return
    }
  }
  if (state.audits.length === 0) {
    yield* researchToolRound(options, 'Đã có bằng chứng ban đầu. Đang audit coverage theo đúng tiêu chí của yêu cầu.', 'audit_research', auditArguments(state, requiredTopics))
    return
  }
  const latestAudit = state.audits.at(-1)
  if (latestAudit?.sufficient === true) {
    yield* textResponse(researchReport(prompt, state), options)
    return
  }
  const missingTopics = latestAudit?.missingTopics.length === 0 || latestAudit === undefined
    ? requiredTopics
    : latestAudit.missingTopics
  const searchesAfterAudit = state.searches.filter(search => search.order > (latestAudit?.order ?? -1))
  if (searchesAfterAudit.length === 0) {
    yield* researchToolRound(
      options,
      `Audit chưa đạt. Tôi cập nhật hướng điều tra theo phần còn thiếu: ${missingTopics.map(topicLabel).join(', ')}.`,
      'web_search',
      { query: missingTopicQuery(missingTopics) },
    )
    return
  }
  const readsAfterAudit = state.reads.filter(read => read.order > (latestAudit?.order ?? -1))
  if (readsAfterAudit.length === 0) {
    const candidate = selectUnreadResult(searchesAfterAudit.flatMap(search => search.results), missingTopics, state.reads)
    if (candidate !== undefined) {
      yield* researchToolRound(options, `Đã tìm được nguồn cho gap "${missingTopics.map(topicLabel).join(', ')}". Đang đọc ${candidate.title}.`, 'read_web_page', { url: candidate.url })
      return
    }
  }
  yield* researchToolRound(
    options,
    `Đã bổ sung ${readsAfterAudit.length} nguồn sau audit gần nhất. Đang kiểm tra lại toàn bộ coverage.`,
    'audit_research',
    auditArguments(state, requiredTopics),
  )
}

async function* researchToolRound(
  options: GenerateOptions,
  commentary: string,
  name: string,
  args: Record<string, unknown>,
): AsyncIterable<StreamChunk> {
  options.signal?.throwIfAborted()
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: commentary, phase: 'commentary' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: commentary, phase: 'commentary' } }
  yield {
    type: 'block-end', index: 1,
    block: {
      type: 'tool-call', id: ToolCallId(`edge-tool-${crypto.randomUUID()}`),
      name, arguments: JSON.stringify(args),
    },
  }
  yield { type: 'usage', usage: usageFor(latestUserText(options.messages), commentary.length) }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

interface ResearchLink { readonly title: string; readonly url: string }
interface ResearchSearch { readonly order: number; readonly query: string; readonly results: readonly ResearchLink[] }
interface ResearchRead extends ResearchLink { readonly order: number; readonly content: string }
interface ResearchAudit { readonly order: number; readonly round: number; readonly sufficient: boolean; readonly missingTopics: readonly string[] }
interface ResearchState {
  readonly searches: readonly ResearchSearch[]
  readonly reads: readonly ResearchRead[]
  readonly audits: readonly ResearchAudit[]
}

function inspectResearch(messages: readonly Message[]): ResearchState {
  const calls = new Map<string, { readonly name: string; readonly args: Record<string, unknown> }>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      const args = parseJsonObject(block.arguments)
      if (args !== undefined) calls.set(String(block.id), { name: block.name, args })
    }
  }
  const searches: ResearchSearch[] = []
  const reads: ResearchRead[] = []
  const audits: ResearchAudit[] = []
  for (const [order, message] of messages.entries()) {
    if (message.source.kind !== 'tool') continue
    const resultBlock = message.content.find(block => block.type === 'tool-result')
    if (resultBlock?.type !== 'tool-result' || resultBlock.isError === true) continue
    const call = calls.get(String(message.source.callId))
    const result = parseToolResult(resultBlock.content)
    if (call === undefined || result === undefined) continue
    if (call.name === 'web_search') {
      const query = typeof result.query === 'string' ? result.query : call.args.query
      const results = Array.isArray(result.results) ? result.results.flatMap(researchLink) : []
      if (typeof query === 'string') searches.push({ order, query, results })
    } else if (call.name === 'read_web_page') {
      const link = researchLink(result)
      if (link.length === 1 && typeof result.content === 'string') reads.push({ order, ...link[0]!, content: result.content })
    } else if (call.name === 'audit_research') {
      const round = result.round
      const missingTopics = Array.isArray(result.missingTopics)
        ? result.missingTopics.filter((topic): topic is string => typeof topic === 'string')
        : []
      if (typeof round === 'number' && typeof result.sufficient === 'boolean') {
        audits.push({ order, round, sufficient: result.sufficient, missingTopics })
      }
    }
  }
  return { searches, reads, audits }
}

function parseToolResult(content: readonly unknown[]): Record<string, unknown> | undefined {
  const text = content.flatMap(block => (
    block !== null && typeof block === 'object' && Reflect.get(block, 'type') === 'text' && typeof Reflect.get(block, 'text') === 'string'
      ? [String(Reflect.get(block, 'text'))]
      : []
  )).join('\n')
  return parseJsonObject(text)
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

function researchLink(value: unknown): ResearchLink[] {
  if (value === null || typeof value !== 'object') return []
  const title = Reflect.get(value, 'title')
  const url = Reflect.get(value, 'url')
  return typeof title === 'string' && typeof url === 'string' ? [{ title, url }] : []
}

function researchTopics(prompt: string): string[] {
  const normalized = prompt.toLocaleLowerCase()
  const topics: string[] = []
  if (/stream|fetch|readablestream|chat/u.test(normalized)) topics.push('web-streaming')
  if (/state|session|conversation|hội thoại|giữ/u.test(normalized)) topics.push('stateful-conversation')
  return topics.length === 0 ? ['web-streaming', 'stateful-conversation'] : topics
}

function topicLabel(topic: string): string {
  if (topic === 'web-streaming') return 'streaming theo Web Standards'
  if (topic === 'stateful-conversation') return 'conversation state trên Edge'
  return topic
}

function initialResearchQuery(prompt: string): string {
  return boundedQuery(`${prompt.replace(/\s+/gu, ' ').trim()} authoritative Web Standards documentation`)
}

function missingTopicQuery(topics: readonly string[]): string {
  const phrases = topics.map(topic => topic === 'stateful-conversation'
    ? 'Durable Objects stateful conversation session Edge runtime'
    : topic === 'web-streaming'
      ? 'Fetch ReadableStream Web Standards Edge streaming'
      : topic)
  return boundedQuery(`${phrases.join(' ')} authoritative documentation`)
}

function boundedQuery(query: string): string {
  return query.length <= 200 ? query : query.slice(0, 200).trimEnd()
}

function selectUnreadResult(
  results: readonly ResearchLink[],
  topics: readonly string[],
  reads: readonly ResearchRead[],
): ResearchLink | undefined {
  const readUrls = new Set(reads.map(read => read.url))
  const unread = results.filter(result => !readUrls.has(result.url))
  for (const topic of topics) {
    const match = unread.find(result => topic === 'web-streaming'
      ? /Streams_API|Fetch_API/u.test(result.url)
      : topic === 'stateful-conversation'
        ? /durable-objects/u.test(result.url)
        : true)
    if (match !== undefined) return match
  }
  return unread[0]
}

function auditArguments(state: ResearchState, requiredTopics: readonly string[]): Record<string, unknown> {
  return {
    round: state.audits.length + 1,
    sourceUrls: [...new Set(state.reads.map(read => read.url))],
    requiredTopics: [...requiredTopics],
  }
}

function researchReport(prompt: string, state: ResearchState): string {
  const auditLines = state.audits.map(audit => audit.sufficient
    ? `- Vòng ${audit.round}: **đạt** — coverage đủ trên ${state.reads.filter(read => read.order < audit.order).length} nguồn đã đọc.`
    : `- Vòng ${audit.round}: **chưa đạt** — còn thiếu ${audit.missingTopics.map(topic => `\`${topic}\``).join(', ')}.`)
  const sourceLines = state.reads.map((read, index) => `${index + 1}. [${read.title}](${read.url})`)
  return [
    '## Báo cáo deep search',
    '',
    `> Yêu cầu: ${prompt.replace(/\s+/gu, ' ').trim()}`,
    '',
    '### Kết luận',
    '',
    'Một chat SDK trên Edge có thể stream phản hồi bằng **Fetch + ReadableStream** theo Web Standards. Conversation state không nên phụ thuộc vào `Map` của một isolate; cần Durable Object hoặc durable store tương đương để phối hợp state qua nhiều request.',
    '',
    '### Audit coverage',
    '',
    ...auditLines,
    '',
    '### Nguồn đã đọc',
    '',
    ...sourceLines,
  ].join('\n')
}

function isDeepSearchPrompt(prompt: string): boolean {
  return /\bdeep[ -]?search\b|nghiên cứu sâu|tìm hiểu sâu/iu.test(prompt)
}

export function resolveChatMode(requestedMode: ChatMode | undefined, prompt: string): EffectiveChatMode {
  return requestedMode === 'deep-search' || isDeepSearchPrompt(prompt)
    ? 'deep-search'
    : 'standard'
}

function searchDocuments(query: string): SearchDocument[] {
  const terms = [...new Set(query.toLocaleLowerCase().split(/[^a-z0-9]+/u).filter(term => term.length > 2))]
  return SEARCH_DOCUMENTS.map(document => ({
    document,
    score: terms.reduce((score, term) => score + (document.tags.some(tag => tag.includes(term) || term.includes(tag)) ? 2 : 0)
      + (document.title.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
  })).filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.document.title.localeCompare(right.document.title))
    .slice(0, 3)
    .map(entry => entry.document)
}

function latestUserText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.source.kind !== 'user') continue
    return message.content.filter(block => block.type === 'text').map(block => block.text).join(' ').trim()
  }
  return ''
}

function latestToolResult(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.source.kind === 'user') return undefined
    if (message?.source.kind !== 'tool') continue
    const encoded = JSON.stringify(message.content)
    const match = /\\?"result\\?"\s*:\s*(-?\d+(?:\.\d+)?)/u.exec(encoded)
    return match === null ? undefined : Number(match[1])
  }
  return undefined
}

function parseCalculation(prompt: string): { left: number; right: number } | undefined {
  const match = /(-?\d+(?:\.\d+)?)\s*(?:\*|x|×|nhân|multiply(?:\s+by)?)\s*(-?\d+(?:\.\d+)?)/iu.exec(prompt)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { left: Number(match[1]), right: Number(match[2]) }
}

function usageFor(input: string, outputChars: number) {
  const inputTokens = Math.max(1, Math.ceil(input.length / 4))
  const outputTokens = Math.max(1, Math.ceil(outputChars / 4))
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}
