/**
 * Warm agent sessions, keyed by conversation.
 *
 * An Edge isolate has no database and no disk, so conversation history lives in
 * the isolate's own memory for as long as the platform keeps it alive. That is
 * a deliberate trade for a sample: it costs nothing to deploy, and a cold start
 * simply begins the conversation again. Anything that must survive a cold start
 * belongs in a durable store the host owns, not here.
 */

import {
  ModelRegistry, ReasoningEffortId, createAgentRuntime,
  type AgentRuntime, type RuntimeAgentSession, type RuntimeAgentTeam, type RuntimeAgentTeamEvent,
} from '@alvin0/ai-agent-sdk-core'
import {
  createManagedAgentTeam, defineAgent,
  type AgentRunEvent, type AgentSession, type ManagedAgentTeam,
} from '@alvin0/ai-agent-sdk-core/agent'
import { openAiAdapter, openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import { createEdgeTools } from './tools'
import type { EdgeChatConfig } from './config'
import { TraceStore } from './traces'
import { effortsForModel, type WireMember, type WireModel } from './wire'

export interface WarmSession {
  readonly kind: 'runtime' | 'team-auto'
  readonly runtime: AgentRuntime | undefined
  /**
   * The session the prompt is delivered to: the only agent in a single run,
   * the lead in a team run.
   */
  readonly session: RuntimeAgentSession | AgentSession
  readonly model: string
  readonly effort: string | undefined
  /** Present only in a team run, and then it owns every member's session. */
  readonly team: RuntimeAgentTeam | undefined
  /** Present only in Team Auto; owns the lead and every generated worker. */
  readonly managedTeam: ManagedAgentTeam | undefined
  /**
   * Team lifecycle events since the last drain.
   *
   * The team reports member starts and ends through a callback rather than a
   * stream, and the callback fires while the lead's handle is being consumed.
   * Queuing them here lets the one loop that owns the response body pick them
   * up in order instead of two writers racing for the same stream.
   */
  readonly teamEvents: RuntimeAgentTeamEvent[]
  /** Raw events from fixed-team member wake-up runs. */
  readonly teamRawEvents: TeamRawEvent[]
  /** Raw events from generated workers and model-triggered lead wakeups. */
  readonly autoEvents: AutoTeamEvent[]
  /** The signature of the roster that built this team, for reuse checks. */
  readonly rosterKey: string
  /** The provider's own words from this session's most recent failed call. */
  readonly providerError: ProviderErrorBox
  /** Request traces kept for as long as this warm session remains resident. */
  readonly traceStore: TraceStore
  /** Cancellation for the Team Auto turn currently attached to an SSE body. */
  activeAbort: AbortController | undefined
  touchedAt: number
  /** Release provider registrations, workers and runtime-owned resources. */
  close(): Promise<void>
}

export interface AutoTeamEvent {
  readonly member: string
  readonly event: AgentRunEvent
}

export interface TeamRawEvent {
  readonly member: string
  readonly event: AgentRunEvent
}

/**
 * Somewhere to put what the provider actually said.
 *
 * The SDK redacts error text on its way into the run report — the report is
 * built to be safe to persist and ship, and a provider's error body is not
 * known to be either. That is the right default and the wrong outcome for a
 * page whose whole job is to tell one developer why their run failed, so the
 * host reads the body itself, in the one place it owns: its own `fetch`.
 */
export interface ProviderErrorBox {
  /** Cleared at the start of each run, so a stale failure never explains a new one. */
  message: string | undefined
}

/** Raised when the isolate is already holding as many conversations as it may. */
export class SessionCapacityError extends Error {
  constructor() {
    super('session capacity reached')
    this.name = 'SessionCapacityError'
  }
}

const warm = new Map<string, WarmSession>()

/** How many conversations the isolate currently holds. */
export function activeSessions(): number {
  return warm.size
}

/**
 * Find or create the session for one conversation.
 * @param conversationId - Validated conversation id.
 * @param config - Configuration for this request.
 * @returns The warm session.
 */
export async function acquireSession(
  conversationId: string,
  config: EdgeChatConfig,
): Promise<WarmSession> {
  prune(config)
  const slot = await slotKey(conversationId, config.apiKey)
  const existing = warm.get(slot)
  const rosterKey = rosterSignature(config)
  // A model, effort, mode or roster the visitor just changed must not keep
  // answering from a session built around the previous one, so that session is
  // discarded. The conversation's history goes with it, which is the honest
  // outcome: the history belongs to the agents that produced it.
  if (existing !== undefined && existing.model === config.model
    && existing.effort === config.effort && existing.rosterKey === rosterKey) {
    existing.touchedAt = Date.now()
    return existing
  }
  if (existing !== undefined) await drop(slot)
  if (warm.size >= config.maxSessions) throw new SessionCapacityError()
  const created = await createSession(conversationId, config, new TraceStore())
  warm.set(slot, created)
  return created
}

/**
 * Close one conversation and release its runtime.
 * @param conversationId - The conversation to forget.
 * @param apiKey - The key whose session this is; see {@link slotKey}.
 * @returns True when a session was actually held.
 */
export async function dropSession(
  conversationId: string,
  apiKey: string | undefined,
): Promise<boolean> {
  return await drop(await slotKey(conversationId, apiKey))
}

async function drop(slot: string): Promise<boolean> {
  const entry = warm.get(slot)
  if (entry === undefined) return false
  warm.delete(slot)
  entry.traceStore.clear()
  await entry.close().catch(() => undefined)
  return true
}

/** Find a warm conversation without creating a provider session. */
export async function findSession(
  conversationId: string,
  apiKey: string | undefined,
): Promise<WarmSession | undefined> {
  return warm.get(await slotKey(conversationId, apiKey))
}

/** Read one trace while enforcing the credential that owns its conversation. */
export async function findTrace(
  runId: string,
  apiKey: string | undefined,
): Promise<readonly import('./traces').WireSpan[]> {
  const prefix = await credentialPrefix(apiKey)
  for (const [slot, entry] of warm) {
    if (!slot.startsWith(prefix)) continue
    if (entry.traceStore.has(runId)) return entry.traceStore.read(runId)
  }
  return []
}

/**
 * The registry key for one conversation under one credential.
 *
 * Conversation ids are chosen by the browser, so two visitors can pick the same
 * one. Without the credential in the key, the second visitor would inherit the
 * first one's warm session — their history, billed to the first one's key. The
 * key itself is never stored: only a digest of it, which is enough to tell two
 * credentials apart and useless to anyone reading the isolate's memory.
 * @param conversationId - Validated conversation id.
 * @param apiKey - The key in effect, or undefined when none is configured.
 * @returns The registry key.
 */
async function slotKey(conversationId: string, apiKey: string | undefined): Promise<string> {
  return `${await credentialPrefix(apiKey)}${conversationId}`
}

async function credentialPrefix(apiKey: string | undefined): Promise<string> {
  if (apiKey === undefined) return 'anon:'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey))
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 32)}:`
}

async function createSession(
  conversationId: string,
  config: EdgeChatConfig,
  traceStore: TraceStore,
): Promise<WarmSession> {
  if (config.apiKey === undefined) throw new Error('OPENAI_API_KEY is not configured')
  const providerError: ProviderErrorBox = { message: undefined }
  const catalog = providerCatalog(config)

  if (config.mode === 'team-auto') {
    return createAutoTeamSession(conversationId, config, providerError, catalog, traceStore)
  }

  const runtime = await createAgentRuntime({
    providers: [openAiPlugin({
      apiKey: config.apiKey,
      defaultModel: config.model,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(catalog.length === 0 ? {} : { models: catalog }),
      fetch: capturingFetch(providerError),
      // The platform kills a long request before a slow provider finishes, so
      // the transport gives up first and the client sees a real error frame.
      requestTimeoutMs: 120_000,
      streamIdleTimeoutMs: 45_000,
    })],
    closeTimeoutMs: 5_000,
    resource: { serviceName: 'edge-runtime-chat-agents', environment: 'sample' },
  })
  const common = {
    kind: 'runtime' as const,
    runtime,
    managedTeam: undefined,
    autoEvents: [],
    teamRawEvents: [],
    activeAbort: undefined,
    model: config.model,
    effort: config.effort,
    rosterKey: rosterSignature(config),
    providerError,
    traceStore,
    touchedAt: Date.now(),
    close: async () => { await runtime.close() },
  }

  if (config.mode !== 'team') {
    const agent = runtime.agent({
      id: 'edge-chat',
      model: { provider: 'openai', id: config.model },
      ...(config.effort === undefined ? {} : { effort: config.effort }),
      instructions: config.instructions,
      tools: createEdgeTools(),
      maxTurns: config.maxTurns,
      maxToolCalls: config.maxToolCalls,
    })
    return {
      ...common,
      session: agent.createSession(sessionOptions(conversationId, config)),
      team: undefined,
      teamEvents: [],
    }
  }

  // The team's own events arrive on a callback while the lead's handle is being
  // read, so they are queued for the one loop that owns the response body.
  const teamEvents: RuntimeAgentTeamEvent[] = []
  const teamRawEvents: TeamRawEvent[] = []
  const team = runtime.team({
    id: `edge-team-${conversationId}`,
    onEvent: (event) => { teamEvents.push(event) },
    onAgentEvent: (member, event) => { teamRawEvents.push({ member, event }) },
    members: config.team.map((member) => {
      const effort = memberEffort(member, config)
      return {
        name: member.name,
        ...(member.role === undefined ? {} : { role: member.role }),
        ...(member.instructions === undefined ? {} : { instructions: member.instructions }),
        agent: runtime.agent({
          id: `edge-${member.name}`,
          // A member with no model of its own runs the conversation's model, so
          // a roster can be assembled by naming roles and given per-member
          // models only where they actually differ.
          model: { provider: 'openai', id: member.model ?? config.model },
          ...(effort === undefined ? {} : { effort }),
          instructions: config.instructions,
          tools: createEdgeTools(),
          maxTurns: config.maxTurns,
          maxToolCalls: config.maxToolCalls,
        }),
        session: sessionOptions(`${conversationId}-${member.name}`, config),
      }
    }),
  })
  return { ...common, session: team.session(leadName(config.team)), team, teamEvents, teamRawEvents }
}

/** Worker roles available to the Team Auto lead on the Edge tool surface. */
const AUTO_TEAM_ROLES = Object.freeze([
  Object.freeze({
    name: 'researcher',
    description: 'Researches one bounded part of the question with the available HTTPS fetch tool.',
    whenToUse: 'independent facts or sources can be gathered in parallel',
    instructions: 'Return concise findings and source URLs. Say clearly when evidence is unavailable.',
  }),
  Object.freeze({
    name: 'analyst',
    description: 'Analyzes supplied facts, tradeoffs, calculations, or competing explanations.',
    whenToUse: 'the question benefits from an independent analysis of known information',
    instructions: 'Check assumptions, units, dates, and contradictions. Do not invent missing inputs.',
  }),
  Object.freeze({
    name: 'reviewer',
    description: 'Reviews a proposed answer or another worker result for concrete gaps and mistakes.',
    whenToUse: 'there is already a result worth checking before the lead answers',
    instructions: 'Report specific corrections and unresolved uncertainty. Do not merely restate the result.',
  }),
])

const AUTO_LEAD_INSTRUCTIONS = `You are the lead of a small dynamic team running on an Edge runtime.
Answer simple questions yourself. For questions with genuinely independent research, analysis, or review work,
create only the specialists that help using spawn_agent. Keep working while they run, wait for required results,
then synthesize one final answer. You and every worker have no filesystem or shell.`

/** Build the low-level managed harness used by Team Auto. All dependencies are web-standard. */
function createAutoTeamSession(
  conversationId: string,
  config: EdgeChatConfig,
  providerError: ProviderErrorBox,
  catalog: ReturnType<typeof providerCatalog>,
  traceStore: TraceStore,
): WarmSession {
  const registry = new ModelRegistry()
  const removeProvider = registry.registerAdapter(['openai'], openAiAdapter({
    apiKey: config.apiKey as string,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(catalog.length === 0 ? {} : { models: catalog }),
    fetch: capturingFetch(providerError),
    requestTimeoutMs: 120_000,
    streamIdleTimeoutMs: 45_000,
  }))
  const tools = createEdgeTools()
  const definition = (id: string, instructions: string) => defineAgent({
    id,
    provider: 'openai',
    model: config.model,
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    instructions,
    mode: 'deep',
    tools,
    maxTurns: config.maxTurns,
    maxToolCalls: config.maxToolCalls,
  })
  const autoEvents: AutoTeamEvent[] = []
  const report = (member: string, event: AgentRunEvent): void => {
    autoEvents.push({ member, event })
  }
  let managed: ManagedAgentTeam
  try {
    managed = createManagedAgentTeam({
      registry,
      lead: definition('edge-auto-lead', `${config.instructions}\n\n${AUTO_LEAD_INSTRUCTIONS}`),
      leadName: 'lead',
      leadDescription: 'Chooses useful specialists and owns the final answer.',
      workerTemplate: definition('edge-auto-worker', config.instructions),
      leadSessionOptions: autoSessionOptions(conversationId, config),
      workerSessionOptionsFactory: request => autoSessionOptions(
        `${conversationId}-${request.name}`,
        config,
      ),
      maxWorkers: config.maxAutoWorkers,
      workerTimeoutMs: config.autoWorkerTimeoutMs,
      spawnTimeoutMs: Math.min(20_000, config.autoWorkerTimeoutMs),
      holdWaitMs: 5_000,
      allowModelWorkerCancellation: false,
      defaultSpawnContext: 'fork',
      writeScopePolicy: 'off',
      roles: AUTO_TEAM_ROLES,
      onWorkerEvent: report,
      // A worker report can wake an idle lead. Those follow-up lead events are
      // not on the request's original stream, so keep them in the same queue.
      team: { onAgentEvent: report },
    })
  } catch (error) {
    removeProvider()
    throw error
  }

  let closing: Promise<void> | undefined
  const created: WarmSession = {
    kind: 'team-auto',
    runtime: undefined,
    session: managed.lead,
    team: undefined,
    managedTeam: managed,
    teamEvents: [],
    teamRawEvents: [],
    autoEvents,
    model: config.model,
    effort: config.effort,
    rosterKey: rosterSignature(config),
    providerError,
    traceStore,
    activeAbort: undefined,
    touchedAt: Date.now(),
    close() {
      closing ??= (async () => {
        created.activeAbort?.abort(new Error('Team Auto session closed'))
        await managed.dispose().catch(() => undefined)
        await managed.team.dispose().catch(() => undefined)
        removeProvider()
      })()
      return closing
    },
  }
  return created
}

/** Session limits shared by the Team Auto lead and generated workers. */
function autoSessionOptions(conversationId: string, config: EdgeChatConfig) {
  return {
    conversationId,
    runtimeLimits: {
      maxSteps: config.maxTurns,
      maxToolCalls: config.maxToolCalls,
      maxTotalTokens: config.maxTotalTokens,
      observerTimeoutMs: 5_000,
    },
  }
}

/** Session limits, identical for every agent this sample builds. */
function sessionOptions(conversationId: string, config: EdgeChatConfig) {
  return {
    conversationId,
    runtimeLimits: {
      maxSteps: config.maxTurns,
      maxToolCalls: config.maxToolCalls,
      maxTotalTokens: config.maxTotalTokens,
      observerTimeoutMs: 5_000,
    },
  }
}

/** The member marked lead, or the first one when the roster names none. */
export function leadName(team: readonly WireMember[]): string {
  return (team.find(member => member.role === 'lead') ?? team[0])?.name ?? 'lead'
}

/** A member's own effort, falling back to the run's. */
function memberEffort(member: WireMember, config: EdgeChatConfig): string | undefined {
  return member.effort ?? (member.model === undefined ? config.effort : undefined)
}

/**
 * A stable string for the roster in play.
 *
 * Compared rather than deep-equalled, so a page that reorders its members or
 * renames one gets a fresh team instead of a stale one answering under the
 * new names.
 * @param config - The configuration for this request.
 * @returns The signature.
 */
function rosterSignature(config: EdgeChatConfig): string {
  // The catalog is part of it: capacities are baked into the provider when the
  // runtime is built, so a corrected context window has to rebuild the session
  // rather than apply from the next turn onward.
  const catalog = config.catalog
    .filter(entry => inPlay(entry.id, config))
    .map(entry => [
      entry.id,
      entry.contextWindow ?? 0,
      entry.maxOutputTokens ?? 0,
      entry.efforts ?? [],
    ])
  if (config.mode === 'team-auto') {
    return JSON.stringify([
      'team-auto', config.maxAutoWorkers, config.autoWorkerTimeoutMs, catalog,
    ])
  }
  if (config.mode !== 'team') return JSON.stringify(['single', catalog])
  return JSON.stringify([config.team.map(member => [
    member.name, member.role ?? 'peer', member.model ?? '', member.effort ?? '',
    member.instructions ?? '',
  ]), catalog])
}

/** Longest provider error text kept, in characters. */
const MAX_PROVIDER_ERROR_CHARS = 600

/**
 * Wrap `fetch` so a failed call leaves its body behind.
 *
 * Only the failure path is touched: a successful response is returned exactly
 * as it arrived, so streaming is unaffected. The body is read from a clone, so
 * the SDK still gets to read the original.
 * @param box - Where to record what the provider said.
 * @returns The wrapped fetch.
 */
function capturingFetch(box: ProviderErrorBox): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    if (response.ok) return response
    try { box.message = providerMessage(await response.clone().text()) }
    catch { /* the body was already gone; the status still says something */ }
    return response
  }
}

/** Pull the human-readable message out of an error body, whatever its shape. */
function providerMessage(raw: string): string | undefined {
  const text = raw.trim()
  if (text.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    const error = parsed === null || typeof parsed !== 'object'
      ? undefined
      : Reflect.get(parsed, 'error')
    const message = error === null || typeof error !== 'object'
      ? undefined
      : Reflect.get(error, 'message')
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.slice(0, MAX_PROVIDER_ERROR_CHARS)
    }
  } catch { /* not JSON; the raw text is the best there is */ }
  return text.slice(0, MAX_PROVIDER_ERROR_CHARS)
}

/**
 * The model catalog this run declares to the provider.
 *
 * The OpenAI provider ships no catalog of its own — it cannot know which ids
 * are current — so anything the SDK needs to know about a model has to be
 * declared here. Two things need declaring, and both come from the page: the
 * reasoning level it asked for, which the SDK refuses unless the catalog lists
 * it, and the model's capacities, which the SDK uses to keep an output cap
 * inside its context window.
 *
 * Only models this turn could actually call are declared. Nothing is asserted
 * about a model nobody named.
 * @param config - The configuration for this request.
 * @returns One entry per model that needs one; empty when none does.
 */
function providerCatalog(config: EdgeChatConfig) {
  // Keep all levels in the provider catalog, not only the selected one. The
  // runtime validates the selected level against this list, and the list is
  // also what lets a model expose its complete effort ladder to callers.
  const efforts = new Map<string, string>()
  if (config.effort !== undefined) efforts.set(config.model, config.effort)
  for (const member of config.team) {
    const level = member.effort ?? (member.model === undefined ? config.effort : undefined)
    if (level !== undefined) efforts.set(member.model ?? config.model, level)
  }

  // Then capacities, for every model this turn could actually call. A model
  // with neither an effort nor a capacity contributes no entry at all.
  const capacities = new Map<string, WireModel>()
  for (const entry of config.catalog) {
    if (inPlay(entry.id, config)) capacities.set(entry.id, entry)
  }

  const ids = new Set([...efforts.keys(), ...capacities.keys()])
  return [...ids].map((id) => {
    const capacity = capacities.get(id)
    const declared = capacity?.efforts ?? effortsForModel(id, config.catalog)
    // Never synthesize a capability from the selected value. If a model has no
    // declared ladder, the SDK must reject a stale/invalid effort before it can
    // become a provider request.
    const available = declared.map(value => ({ id: ReasoningEffortId(value), name: value }))
    return {
      id,
      name: id,
      ...(capacity?.contextWindow === undefined ? {} : { contextWindow: capacity.contextWindow }),
      ...(capacity?.maxOutputTokens === undefined ? {} : { maxTokens: capacity.maxOutputTokens }),
      ...(available.length === 0
        ? {}
        : {
          reasoning: {
            efforts: available,
          },
        }),
    }
  })
}

/** Whether some agent in this run would actually call that model. */
function inPlay(id: string, config: EdgeChatConfig): boolean {
  if (id === config.model) return true
  return config.team.some(member => member.model === id)
}

/** Drop idle sessions so one isolate does not hold every conversation it ever saw. */
function prune(config: EdgeChatConfig): void {
  const cutoff = Date.now() - config.sessionTtlMs
  for (const [id, entry] of warm) {
    if (entry.session.isRunning || entry.touchedAt >= cutoff) continue
    warm.delete(id)
    void entry.close().catch(() => undefined)
  }
}
