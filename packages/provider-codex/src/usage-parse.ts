/**
 * Normalize the two shapes Codex reports usage in: the JSON body of the usage
 * endpoint and the `x-codex-*` headers on every model response.
 *
 * Both are undocumented service output, so every field is optional and a value of
 * the wrong type is dropped rather than trusted.
 */

import type {
  CodexAdditionalRateLimit, CodexCredits, CodexModelAvailability, CodexRateLimit, CodexUsage,
  CodexUsageWindow,
} from './usage-types.ts'

type Json = Record<string, unknown>

function record(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function epochMillis(value: unknown): number {
  if (typeof value === 'number') return value * 1000
  if (typeof value === 'string' && value.length > 0) return Date.parse(value)
  return Number.NaN
}

/** Unix seconds, or an ISO string, to ISO-8601; undefined when unusable. */
function timestamp(value: unknown): string | undefined {
  const millis = epochMillis(value)
  if (!Number.isFinite(millis) || millis <= 0) return undefined
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Every property of `T`, each allowed to be undefined until {@link compact} drops it. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined }

/** Drop undefined properties and freeze, so optional fields are absent rather than undefined. */
function compact<T extends object>(value: Loose<T>): T {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))) as T
}

/** `100 - used`, clamped to [0, 100] and rid of float noise (66.6 used → 33.4, not 33.400000000000006). */
function remainingShare(usedPercent: number): number {
  return Math.min(100, Math.max(0, Math.round((100 - usedPercent) * 1e6) / 1e6))
}

function usageWindow(usedPercent: number, rest: {
  windowSeconds?: number | undefined; resetAfterSeconds?: number | undefined; resetsAt?: string | undefined
}): CodexUsageWindow {
  return compact<CodexUsageWindow>({ usedPercent, remainingPercent: remainingShare(usedPercent), ...rest })
}

function bodyWindow(value: unknown): CodexUsageWindow | undefined {
  const source = record(value)
  const usedPercent = finite(source?.used_percent)
  if (source === undefined || usedPercent === undefined) return undefined
  return usageWindow(usedPercent, {
    windowSeconds: finite(source.limit_window_seconds),
    resetAfterSeconds: finite(source.reset_after_seconds),
    resetsAt: timestamp(source.reset_at),
  })
}

function bodyRateLimit(value: unknown): CodexRateLimit | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  return compact<CodexRateLimit>({
    allowed: flag(source.allowed),
    limitReached: flag(source.limit_reached),
    primary: bodyWindow(source.primary_window),
    secondary: bodyWindow(source.secondary_window),
  })
}

function bodyAdditional(value: unknown): readonly CodexAdditionalRateLimit[] {
  if (!Array.isArray(value)) return Object.freeze([])
  return Object.freeze(value.flatMap((entry): CodexAdditionalRateLimit[] => {
    const source = record(entry)
    const name = text(source?.limit_name) ?? text(source?.metered_limit_name)
    if (source === undefined || name === undefined) return []
    return [compact<CodexAdditionalRateLimit>({
      name,
      meteredName: text(source.metered_limit_name),
      rateLimit: bodyRateLimit(source.rate_limit),
    })]
  }))
}

function bodyCredits(value: unknown): CodexCredits | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  return compact<CodexCredits>({
    hasCredits: flag(source.has_credits),
    unlimited: flag(source.unlimited),
    balance: text(source.balance),
    overageLimitReached: flag(source.overage_limit_reached),
  })
}

function bodyModels(value: unknown): Readonly<Record<string, CodexModelAvailability>> {
  const source = record(value) ?? {}
  return Object.freeze(Object.fromEntries(Object.entries(source).flatMap(([slug, entry]) => {
    const model = record(entry)
    if (slug.length === 0 || model === undefined) return []
    return [[slug, compact<CodexModelAvailability>({
      available: flag(model.available),
      availableAt: timestamp(model.available_at),
    })]]
  })))
}

/** Normalize a usage-endpoint body; personal identifiers in it are dropped. */
export function parseCodexUsageBody(body: unknown, observedAt = new Date()): CodexUsage {
  const source = record(body)
  if (source === undefined) throw new TypeError('Codex usage response must be a JSON object')
  return compact<CodexUsage>({
    source: 'usage-endpoint',
    observedAt: observedAt.toISOString(),
    planType: text(source.plan_type),
    rateLimit: bodyRateLimit(source.rate_limit),
    codeReviewRateLimit: bodyRateLimit(source.code_review_rate_limit),
    additionalRateLimits: bodyAdditional(source.additional_rate_limits),
    credits: bodyCredits(source.credits),
    models: bodyModels(source.model_usage),
    limitReachedType: text(source.rate_limit_reached_type),
    spendControlReached: flag(record(source.spend_control)?.reached),
  })
}

type HeaderSource = Headers | Readonly<Record<string, string | undefined>>

function headerReader(headers: HeaderSource): (name: string) => string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return name => (headers as Headers).get(name) ?? undefined
  }
  const lowered = new Map(Object.entries(headers as Record<string, string | undefined>)
    .map(([key, value]) => [key.toLowerCase(), value]))
  return name => lowered.get(name)
}

function headerNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** `True`/`False` as the service sends them, in any case. */
function headerFlag(value: string | undefined): boolean | undefined {
  const lowered = value?.trim().toLowerCase()
  if (lowered === 'true') return true
  if (lowered === 'false') return false
  return undefined
}

function headerWindow(read: (name: string) => string | undefined, prefix: string): CodexUsageWindow | undefined {
  const usedPercent = headerNumber(read(`${prefix}-used-percent`))
  if (usedPercent === undefined) return undefined
  const minutes = headerNumber(read(`${prefix}-window-minutes`))
  const resetsAt = timestamp(headerNumber(read(`${prefix}-reset-at`)))
  // An unused plan slot is sent as all zeros with an empty reset time.
  if ((minutes ?? 0) <= 0 && resetsAt === undefined && usedPercent === 0) return undefined
  return usageWindow(usedPercent, {
    windowSeconds: minutes !== undefined && minutes > 0 ? minutes * 60 : undefined,
    resetAfterSeconds: headerNumber(read(`${prefix}-reset-after-seconds`)),
    resetsAt,
  })
}

function headerCredits(read: (name: string) => string | undefined): CodexCredits | undefined {
  const credits = compact<CodexCredits>({
    hasCredits: headerFlag(read('x-codex-credits-has-credits')),
    unlimited: headerFlag(read('x-codex-credits-unlimited')),
    balance: text(read('x-codex-credits-balance')),
  })
  return Object.keys(credits).length === 0 ? undefined : credits
}

/**
 * Read the `x-codex-*` usage headers of a Codex model response.
 *
 * Returns undefined when the response carries no usage headers. Accepts a Fetch
 * `Headers` object or a plain record such as `ProviderResponseLogRecord.headers`.
 */
export function parseCodexUsageHeaders(headers: HeaderSource, observedAt = new Date()): CodexUsage | undefined {
  const read = headerReader(headers)
  const primary = headerWindow(read, 'x-codex-primary')
  const secondary = headerWindow(read, 'x-codex-secondary')
  const planType = text(read('x-codex-plan-type'))
  if (primary === undefined && secondary === undefined && planType === undefined) return undefined
  return compact<CodexUsage>({
    source: 'response-headers',
    observedAt: observedAt.toISOString(),
    planType,
    rateLimit: primary === undefined && secondary === undefined
      ? undefined : compact<CodexRateLimit>({ primary, secondary }),
    additionalRateLimits: Object.freeze([]),
    credits: headerCredits(read),
    models: Object.freeze({}),
    activeLimit: text(read('x-codex-active-limit')),
  })
}
