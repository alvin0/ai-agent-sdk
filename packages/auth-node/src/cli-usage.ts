/** `--usage` rendering for the Codex login CLI. */

import { getCodexNodeUsage, type CodexAuthStore, type CodexUsage, type CodexUsageWindow } from './codex.ts'

const GRAY = '\u001B[90m'
const BOLD = '\u001B[1m'
const RED = '\u001B[91m'
const RESET = '\u001B[0m'

/** `18000` → `5h`, `604800` → `7d`, `90` → `1m`. */
export function formatSpan(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${Math.max(minutes, total > 0 ? 1 : 0)}m`
}

function windowLabel(window: CodexUsageWindow, fallback: string): string {
  return window.windowSeconds === undefined ? fallback : `${formatSpan(window.windowSeconds)} window`
}

function resetText(window: CodexUsageWindow): string {
  if (window.resetAfterSeconds !== undefined) return `resets in ${formatSpan(window.resetAfterSeconds)}`
  if (window.resetsAt !== undefined) return `resets at ${window.resetsAt}`
  return 'reset time unknown'
}

function windowLine(window: CodexUsageWindow | undefined, fallback: string): string | undefined {
  if (window === undefined) return undefined
  const left = `${window.remainingPercent}% left`
  const tone = window.remainingPercent <= 0 ? RED : BOLD
  return `  ${windowLabel(window, fallback).padEnd(12)}: ${tone}${left}${RESET} `
    + `${GRAY}(${window.usedPercent}% used, ${resetText(window)})${RESET}`
}

function creditsLine(usage: CodexUsage): string | undefined {
  const credits = usage.credits
  if (credits === undefined) return undefined
  if (credits.unlimited === true) return '  credits     : unlimited'
  if (credits.hasCredits !== true) return '  credits     : none'
  return `  credits     : ${credits.balance ?? 'available'}`
}

function modelLines(usage: CodexUsage): string[] {
  return Object.entries(usage.models).map(([slug, model]) => {
    const state = model.available === false
      ? `${RED}unavailable${RESET}${model.availableAt === undefined ? '' : ` until ${model.availableAt}`}`
      : 'available'
    return `  model       : ${slug} ${state}`
  })
}

/** Render a usage snapshot as the CLI prints it. */
export function renderUsage(usage: CodexUsage, location: string): string {
  const limit = usage.rateLimit
  const lines = [
    `codex: usage${usage.planType === undefined ? '' : ` (plan ${usage.planType})`} ${GRAY}(${location})${RESET}`,
    windowLine(limit?.primary, 'primary'),
    windowLine(limit?.secondary, 'secondary'),
    limit?.limitReached === true || usage.limitReachedType !== undefined
      ? `  ${RED}limit reached${usage.limitReachedType === undefined ? '' : `: ${usage.limitReachedType}`}${RESET}`
      : undefined,
    creditsLine(usage),
    ...modelLines(usage),
  ]
  return `${lines.filter(line => line !== undefined).join('\n')}\n`
}

export interface ReportUsageOptions {
  /** Auth issuer the account signed in with (`--issuer`), used if tokens must be refreshed. */
  readonly issuer?: string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/** Fetch and print the account's remaining usage; exit code 0 on success. */
export async function reportUsage(
  store: CodexAuthStore, location: string, options: ReportUsageOptions = {},
): Promise<number> {
  const usage = await getCodexNodeUsage({
    authStore: store,
    ...options.issuer === undefined ? {} : { oauth: { issuer: options.issuer } },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
  })
  process.stdout.write(renderUsage(usage, location))
  return 0
}
