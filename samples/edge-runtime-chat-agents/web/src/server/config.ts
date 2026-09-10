/**
 * Everything the Edge backend reads from the environment, in one place.
 *
 * Universal SDK packages never read environment variables themselves, so the
 * host does it here and injects the values. Values are read per request rather
 * than captured at module load: an isolate can outlive a redeploy of its
 * bindings, and a stale key would keep failing for the isolate's whole life.
 */

import { DEFAULT_TEAM, type RunMode, type WireMember, type WireModel } from './wire'

/** Model used when `EDGE_CHAT_MODEL` is unset. */
export const DEFAULT_MODEL = 'gpt-5.4'

/**
 * Ids the picker offers first.
 *
 * A suggestion list, not a whitelist: the picker also takes a typed id, because
 * this sample cannot know which models a given account can reach and a fixed
 * list would go stale the week after it was written. `EDGE_CHAT_MODELS`
 * replaces it for a deployment that does know.
 */
const SUGGESTED_MODELS: readonly string[] = Object.freeze([
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2', 'gpt-5.1',
  'gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini',
])

export interface EdgeChatConfig {
  /**
   * The OpenAI API key in effect: the visitor's if the page sent one, otherwise
   * the deployment's. Absent when neither exists.
   */
  readonly apiKey: string | undefined
  readonly model: string
  /**
   * Reasoning effort to ask for, or undefined to send none.
   *
   * Undefined is the default because a non-reasoning model rejects the field
   * outright, and a sample whose first request fails on a setting nobody chose
   * is a bad sample.
   */
  readonly effort: string | undefined
  /** Ids the page shows in its picker. */
  readonly models: readonly string[]
  /**
   * Capacities for the models this turn uses, as the page supplied them.
   *
   * Entries reach the provider catalog verbatim. A model with no entry runs on
   * the adapter's own defaults, which is the same as before the page had a
   * catalog at all.
   */
  readonly catalog: readonly WireModel[]
  /** One agent, or a team with a lead who delegates. */
  readonly mode: RunMode
  /**
   * The roster, empty unless `mode` is `team`.
   *
   * A member with no model of its own runs {@link EdgeChatConfig.model}, so a
   * team can be assembled by naming roles alone and given per-member models
   * only where they actually differ.
   */
  readonly team: readonly WireMember[]
  /** Endpoint override, for an OpenAI-compatible gateway. */
  readonly baseUrl: string | undefined
  readonly instructions: string
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly maxTotalTokens: number
  /** Most workers a Team Auto conversation may have at once. */
  readonly maxAutoWorkers: number
  /** End-to-end deadline for one generated worker. */
  readonly autoWorkerTimeoutMs: number
  /** Sessions the isolate keeps warm before it refuses a new conversation. */
  readonly maxSessions: number
  /** Idle time after which a warm session is dropped, in milliseconds. */
  readonly sessionTtlMs: number
}

const DEFAULT_INSTRUCTIONS = `You are a helpful assistant running on a web Edge runtime.

Answer in the language the user writes in. Keep answers direct and concrete.
Use Markdown for structure, and fenced code blocks for code.
You have no filesystem and no shell: say so plainly rather than pretending to run commands.`

/**
 * Read the configuration for the current request.
 * @param source - The environment record; Next inlines `process.env` on Edge.
 * @param requestKey - A key the visitor typed into the page, when there is one.
 *   It wins over the deployment's own key: a visitor who supplied a key meant
 *   to be billed for it, and silently spending the host's instead would be the
 *   surprising reading.
 * @param choice - Model, effort, mode and roster the page asked for.
 * @returns The resolved configuration.
 */
export function readConfig(
  source: Record<string, string | undefined> = process.env,
  requestKey?: string,
  choice?: {
    readonly model?: string
    readonly effort?: string
    readonly mode?: RunMode
    readonly team?: readonly WireMember[]
    readonly catalog?: readonly WireModel[]
  },
): EdgeChatConfig {
  const apiKey = text(requestKey) ?? text(source.OPENAI_API_KEY)
  const instructions = text(source.EDGE_CHAT_INSTRUCTIONS)
  const models = list(source.EDGE_CHAT_MODELS) ?? SUGGESTED_MODELS
  const model = text(choice?.model) ?? text(source.EDGE_CHAT_MODEL) ?? DEFAULT_MODEL
  const configuredMode = source.EDGE_CHAT_MODE === 'team'
    ? 'team'
    : source.EDGE_CHAT_MODE === 'team-auto' ? 'team-auto' : 'single'
  const mode = choice?.mode ?? configuredMode
  // A team of one is a single agent wearing a roster, so an empty or one-member
  // request falls back to the default pair rather than pretending to delegate.
  const roster = choice?.team === undefined || choice.team.length < 2
    ? DEFAULT_TEAM
    : choice.team
  return {
    apiKey,
    model,
    mode,
    team: mode === 'team' ? roster : [],
    effort: text(choice?.effort) ?? text(source.EDGE_CHAT_EFFORT),
    // The model in play leads the list even when it was typed rather than
    // picked, so the picker never shows a selection it does not contain.
    models: models.includes(model) ? models : [model, ...models],
    catalog: choice?.catalog ?? [],
    baseUrl: text(source.OPENAI_BASE_URL),
    instructions: instructions ?? DEFAULT_INSTRUCTIONS,
    maxTurns: bounded(source.EDGE_CHAT_MAX_TURNS, 12, 1, 64),
    maxToolCalls: bounded(source.EDGE_CHAT_MAX_TOOL_CALLS, 16, 0, 128),
    maxTotalTokens: bounded(source.EDGE_CHAT_MAX_TOTAL_TOKENS, 200_000, 8_000, 1_500_000),
    maxAutoWorkers: bounded(source.EDGE_CHAT_AUTO_MAX_WORKERS, 3, 1, 5),
    autoWorkerTimeoutMs: bounded(source.EDGE_CHAT_AUTO_WORKER_TIMEOUT_MS, 90_000, 10_000, 120_000),
    maxSessions: bounded(source.EDGE_CHAT_MAX_SESSIONS, 24, 1, 256),
    sessionTtlMs: bounded(source.EDGE_CHAT_SESSION_TTL_MS, 20 * 60_000, 60_000, 6 * 3_600_000),
  }
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** A comma-separated environment list, or undefined when it is empty. */
function list(value: string | undefined): readonly string[] | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const entries = raw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  return entries.length === 0 ? undefined : Object.freeze(entries)
}

/** A configured integer, or the fallback when it is absent or out of range. */
function bounded(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const raw = text(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback
  return parsed
}
