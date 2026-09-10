/**
 * The wire protocol between the Edge backend and the browser.
 *
 * One module, imported by both sides, so a field renamed on the server stops
 * the client's typecheck instead of silently emptying a panel.
 */

/**
 * A single Server-Sent Event frame the chat stream can carry.
 *
 * Frames carrying `member` name the agent they came from. In a single-agent run
 * that field is absent; in a team run it is the lead's name on its own output
 * and a peer's name on theirs, which is what lets the transcript say who spoke.
 */
export type WireEvent =
  | {
    readonly t: 'start'
    readonly runId: string
    readonly conversationId: string
    readonly model: string
    readonly mode: RunMode
    /** The roster in play, so the page can draw it before anyone speaks. */
    readonly members?: readonly WireMember[]
  }
  | {
    readonly t: 'text-delta'
    readonly text: string
    /** Stable model block id; lets the client merge deltas across team events. */
    readonly blockId?: string
    readonly member?: string
  }
  | {
    readonly t: 'reasoning-delta'
    readonly text: string
    readonly blockId?: string
    readonly member?: string
  }
  | {
    readonly t: 'tool-call'
    readonly callId: string
    readonly name: string
    readonly input: unknown
    readonly member?: string
  }
  | {
    readonly t: 'tool-result'
    readonly callId: string
    readonly name: string
    readonly status: string
    readonly isError: boolean
    readonly member?: string
  }
  /** A peer started or finished working, from the team's own event stream. */
  | { readonly t: 'member-start'; readonly member: string }
  | { readonly t: 'member-end'; readonly member: string; readonly failed?: true }
  /**
   * What a peer produced, delivered whole.
   *
   * A peer's run is started by the team rather than by this host, so its tokens
   * are not on the handle being streamed. The text is read from that member's
   * own session once its run ends, which is why it arrives as a block rather
   * than as deltas.
   */
  | { readonly t: 'member-message'; readonly member: string; readonly text: string }
  | {
    readonly t: 'native-tool'
    readonly callId: string
    readonly name: string
    readonly provider: string
    readonly status: string
  }
  /** One execution span, sent when it opens and again when it closes. */
  | { readonly t: 'span'; readonly span: import('./traces').WireSpan }
  | { readonly t: 'done'; readonly text: string; readonly usage: WireUsage }
  | {
    readonly t: 'error'
    readonly code: string
    readonly message: string
    /** Which part of the run failed: `model-call`, `tool`, and so on. */
    readonly stage?: string
    /** HTTP status the provider returned, when the failure reached one. */
    readonly status?: number
    /** The provider's own words, when the SDK captured them. */
    readonly detail?: string
  }

/** Token accounting for one completed run, as the composer footer shows it. */
export interface WireUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

/**
 * How a turn is run.
 *
 * `team` uses a roster chosen before the run. `team-auto` starts with one lead
 * and lets that lead create bounded specialist workers with `spawn_agent` as
 * the question demands.
 */
export type RunMode = 'single' | 'team' | 'team-auto'

/** One team member, as the page configures it and the roster draws it. */
export interface WireMember {
  readonly name: string
  /** This member's own model; the run's default when absent. */
  readonly model?: string
  readonly effort?: string
  readonly instructions?: string
  /** Exactly one member is the lead: the one the prompt is delivered to. */
  readonly role?: 'lead' | 'peer'
}

/** Request body of `POST /api/chat`. */
export interface ChatRequestBody {
  readonly conversationId: string
  readonly message: string
  /** Model id to run; the deployment's default when absent. */
  readonly model?: string
  /** Reasoning effort; the model's own default when absent. */
  readonly effort?: string
  /** Single agent when absent. */
  readonly mode?: RunMode
  /** The roster, required when `mode` is `team`. */
  readonly team?: readonly WireMember[]
  /**
   * Capacities for the models this turn uses.
   *
   * The page owns the catalog because it is the page that knows which models
   * the visitor has added; the server has no store to keep one in.
   */
  readonly catalog?: readonly WireModel[]
}

/**
 * The roster a team run starts from.
 *
 * Two members, because two is the smallest number that makes delegation mean
 * anything, and every extra member is another model call the visitor pays for
 * before they have decided the shape is right. Both inherit the run's model
 * until the page gives one of them its own.
 *
 * It lives here rather than in the server's configuration because the page
 * needs it too: the roster editor opens on it before any request is sent.
 */
export const DEFAULT_TEAM: readonly WireMember[] = Object.freeze([
  Object.freeze({
    name: 'lead',
    role: 'lead' as const,
    instructions: 'You lead a small team. Answer directly when you can.'
      + ' Delegate a self-contained piece of work with followup_task when a teammate'
      + ' would genuinely do it better, then wait for it and fold the result into your answer.'
      + ' Never delegate the whole question unchanged.',
  }),
  Object.freeze({
    name: 'researcher',
    role: 'peer' as const,
    instructions: 'You take one delegated task at a time and return a short, concrete result.'
      + ' State what you could not determine rather than guessing.',
  }),
])

/**
 * One model the page knows about, with the capacities the SDK needs.
 *
 * The SDK will not send a request whose output cap exceeds the model's, or
 * whose cap does not fit inside its context window, so it needs both numbers.
 * Omitting them falls back to the provider adapter's own defaults, which are a
 * guess that fits most models and silently truncates on the ones it does not.
 */
export interface WireModel {
  readonly id: string
  /** Combined request and response capacity, in tokens. */
  readonly contextWindow?: number
  /** Largest response the model will produce, in tokens. */
  readonly maxOutputTokens?: number
  /** Effort levels this model accepts; an empty list means it does not reason. */
  readonly efforts?: readonly string[]
}

/**
 * Capacities for the models this sample can speak for.
 *
 * The GPT-5 and GPT-4 figures are OpenAI's published ones. A
 * model absent from this table gets no catalog entry at all, which leaves the
 * adapter's defaults in charge — and the dialog lets anyone type the real
 * numbers in once rather than every time.
 */
const GPT_5_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high'])
const GPT_5_1_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high'])
const GPT_5_2_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh'])
const GPT_5_4_PRO_EFFORTS = Object.freeze(['medium', 'high', 'xhigh'])
const GPT_5_PRO_EFFORTS = Object.freeze(['high'])
const O_SERIES_EFFORTS = Object.freeze(['low', 'medium', 'high'])
const NO_EFFORTS = Object.freeze([] as string[])

export const KNOWN_MODELS: Readonly<Record<string, WireModel>> = Object.freeze({
  'gpt-5.4': {
    id: 'gpt-5.4', contextWindow: 1_050_000, maxOutputTokens: 128_000, efforts: GPT_5_2_EFFORTS,
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini', contextWindow: 400_000, maxOutputTokens: 128_000, efforts: GPT_5_2_EFFORTS,
  },
  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano', contextWindow: 400_000, maxOutputTokens: 128_000, efforts: GPT_5_2_EFFORTS,
  },
  'gpt-5.4-pro': {
    id: 'gpt-5.4-pro', contextWindow: 1_050_000, maxOutputTokens: 128_000, efforts: GPT_5_4_PRO_EFFORTS,
  },
  'gpt-5.2': {
    id: 'gpt-5.2', contextWindow: 400_000, maxOutputTokens: 128_000, efforts: GPT_5_2_EFFORTS,
  },
  'gpt-5.1': {
    id: 'gpt-5.1', contextWindow: 400_000, maxOutputTokens: 128_000, efforts: GPT_5_1_EFFORTS,
  },
  'gpt-5': {
    id: 'gpt-5', contextWindow: 400_000, maxOutputTokens: 128_000, efforts: GPT_5_EFFORTS,
  },
  'gpt-5-pro': {
    id: 'gpt-5-pro', contextWindow: 400_000, maxOutputTokens: 272_000, efforts: GPT_5_PRO_EFFORTS,
  },
  'gpt-4.1': { id: 'gpt-4.1', contextWindow: 1_047_576, maxOutputTokens: 32_768, efforts: NO_EFFORTS },
  'gpt-4o': { id: 'gpt-4o', contextWindow: 128_000, maxOutputTokens: 16_384, efforts: NO_EFFORTS },
  'gpt-4o-mini': { id: 'gpt-4o-mini', contextWindow: 128_000, maxOutputTokens: 16_384, efforts: NO_EFFORTS },
})

/**
 * Return the effort levels known for an OpenAI model id.
 *
 * Snapshot ids and compatible future siblings are matched by family. An empty
 * result is intentional for non-reasoning models and for ids whose capabilities
 * are unknown; those models should use the provider default until their catalog
 * is configured explicitly.
 */
export function suggestedEfforts(id: string): readonly string[] {
  const known = KNOWN_MODELS[id]
  if (known?.efforts !== undefined) return known.efforts
  if (/^gpt-5\.4-pro(?:-|$)/u.test(id)) return GPT_5_4_PRO_EFFORTS
  if (/^gpt-5\.4(?:-|$)/u.test(id)) return GPT_5_2_EFFORTS
  if (/^gpt-5\.1(?:-|$)/u.test(id)) return GPT_5_1_EFFORTS
  // Includes legacy/sample ids such as gpt-5.6-luna and dated snapshots.
  if (/^gpt-5\.\d+(?:-|$)/u.test(id)) return GPT_5_2_EFFORTS
  if (/^gpt-5(?:-|$)/u.test(id)) return GPT_5_EFFORTS
  if (/^o(?:1|3|4)(?:-|$)/u.test(id)) return O_SERIES_EFFORTS
  return NO_EFFORTS
}

/** Resolve catalog metadata first, then the built-in OpenAI family metadata. */
export function effortsForModel(id: string, catalog: readonly WireModel[] = []): readonly string[] {
  return catalog.find(entry => entry.id === id)?.efforts ?? suggestedEfforts(id)
}

/**
 * What the dialog should pre-fill for a model id.
 *
 * An id in the table answers exactly. An unlisted `gpt-5.*` borrows the
 * family's figures, because a released sibling of a model whose capacities are
 * known is far more likely to match them than to match nothing — that is a
 * starting point for the fields, not an assertion, and the reader can correct
 * it before saving. Anything else pre-fills empty.
 * @param id - The model id.
 * @returns The suggested capacities, empty when there is nothing to suggest.
 */
export function suggestedCapacity(id: string): Omit<WireModel, 'id'> {
  const known = KNOWN_MODELS[id]
  if (known !== undefined) {
    return {
      ...(known.contextWindow === undefined ? {} : { contextWindow: known.contextWindow }),
      ...(known.maxOutputTokens === undefined ? {} : { maxOutputTokens: known.maxOutputTokens }),
    }
  }
  if (/^gpt-5\.4-pro(?:-|$)/u.test(id)) {
    return { contextWindow: 1_050_000, maxOutputTokens: 128_000 }
  }
  if (/^gpt-5\.4(?:-|$)/u.test(id)) {
    return { contextWindow: 1_050_000, maxOutputTokens: 128_000 }
  }
  if (/^gpt-5\.(?:1|2|3)(?:-|$)/u.test(id)) {
    return { contextWindow: 400_000, maxOutputTokens: 128_000 }
  }
  if (/^gpt-5(?:-|$)/u.test(id)) {
    return { contextWindow: 400_000, maxOutputTokens: 128_000 }
  }
  return {}
}

/** Bounds a typed capacity must fall inside before it reaches the SDK. */
export const MIN_CONTEXT_WINDOW = 1_000
export const MAX_CONTEXT_WINDOW = 10_000_000
export const MIN_OUTPUT_TOKENS = 256

/** Most models the page will carry in its own catalog. */
export const MAX_CATALOG_MODELS = 24

/** Most members one team may have. */
export const MAX_TEAM_MEMBERS = 4

/** Longest per-member instructions the backend accepts, in characters. */
export const MAX_MEMBER_INSTRUCTIONS = 2_000

/** Shape a member name must have; it is also a tool argument the model types. */
export const MEMBER_NAME = /^[a-z][a-z0-9-]{1,23}$/u

/** Response body of `GET /api/health`. */
export interface HealthBody {
  readonly ok: boolean
  readonly runtime: string
  /** Run shape configured by the deployment when the browser has not chosen. */
  readonly mode: RunMode
  /** The model used when the page names none. */
  readonly model: string
  /** Ids the picker offers first; a typed id is accepted too. */
  readonly models: readonly string[]
  /** Reasoning levels the picker offers. */
  readonly efforts: readonly string[]
  /** Whether the deployment itself holds a key, so no browser key is needed. */
  readonly configured: boolean
  readonly activeSessions: number
}

/**
 * Reasoning levels the page may ask for.
 *
 * These are OpenAI's own names. A model that does not reason will reject them,
 * which is why the picker also offers no effort at all and defaults to that.
 */
export const EFFORTS: readonly string[] = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
])

/**
 * Shape a model id must have.
 *
 * Loose on purpose: the SDK cannot know which ids are current, and a strict
 * pattern would reject a model released next week. It is strict about length
 * and character class, which is what keeps a hostile id out of a URL.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u

/** Longest prompt the backend accepts, in characters. */
export const MAX_PROMPT_CHARS = 24_000

/** Shape a conversation id must have before it reaches the session registry. */
export const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

/**
 * Header carrying a key the visitor typed into the page.
 *
 * A header, not the body, so the key stays out of anything that logs or
 * replays a request payload, and so `POST /api/close` can carry it too.
 */
export const API_KEY_HEADER = 'x-openai-key'

/**
 * Shape a browser-supplied key must have before it reaches the provider.
 *
 * Deliberately loose about what a key looks like — OpenAI has changed that
 * more than once, and a strict pattern here would reject a valid new key. It
 * is strict about what a header may contain, which is the part that matters.
 */
export const API_KEY_PATTERN = /^[\x21-\x7E]{20,256}$/u
