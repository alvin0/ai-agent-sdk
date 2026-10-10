import { describe, expect, it } from 'vitest'
import { resolvedCatalogModelInfo } from '../../../packages/provider-http/src/base/transport.ts'
import {
  normalizeResolvedModelInfo, resolveCallWithModelInfo,
} from '../../../packages/core/src/runtime/model-metadata.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { ProviderCatalogModel } from '../../../packages/provider-http/src/index.ts'

/**
 * Properties of catalog window resolution over generated catalogs: whatever a
 * route's fallbacks are, a model whose own declarations agree with each other
 * resolves, and what it resolves to always leaves input headroom.
 */

const SIZES = [1_000, 4_096, 8_192, 32_000, 64_000, 100_000, 128_000, 200_000, 272_000, 400_000, 1_000_000]

/** Deterministic PRNG, so a failing case reproduces from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Case {
  readonly entry: ProviderCatalogModel
  readonly routeMaxTokens: number | undefined
  readonly routeWindow: number | undefined
}

function generate(random: () => number): Case {
  const maybe = (chance = 0.5): number | undefined =>
    random() < chance ? SIZES[Math.floor(random() * SIZES.length)] : undefined
  const entry: Record<string, unknown> = { id: 'model' }
  for (const key of ['contextWindow', 'defaultContextWindow', 'maxContextWindow', 'maxTokens', 'defaultMaxTokens']) {
    const value = maybe(key === 'maxTokens' ? 0.7 : 0.35)
    if (value !== undefined) entry[key] = value
  }
  return { entry: entry as unknown as ProviderCatalogModel, routeMaxTokens: maybe(0.7), routeWindow: maybe(0.8) }
}

/** Whether `value` passes `limit` (or reaches it when `inclusive`); an absent side never does. */
function exceeds(value: number | undefined, limit: number | undefined, inclusive: boolean): boolean {
  return value !== undefined && limit !== undefined && (inclusive ? value >= limit : value > limit)
}

/** Whether the model's OWN declarations agree with each other (route fallbacks play no part). */
function selfConsistent(entry: ProviderCatalogModel): boolean {
  const window = entry.contextWindow ?? entry.defaultContextWindow
  return ![
    exceeds(entry.contextWindow, entry.maxContextWindow, false),
    exceeds(entry.defaultContextWindow, entry.maxContextWindow, false),
    exceeds(entry.defaultMaxTokens, entry.maxTokens, false),
    exceeds(entry.defaultMaxTokens, window ?? entry.maxContextWindow, true),
    exceeds(entry.maxTokens, entry.maxContextWindow ?? window, true),
  ].some(Boolean)
}

function resolve(scenario: Case) {
  const info = resolvedCatalogModelInfo('route', 'model', [scenario.entry],
    scenario.routeMaxTokens, scenario.routeWindow)
  const normalized = normalizeResolvedModelInfo('route', 'model', info as unknown as ResolvedModelInfo,
    { maxBytes: 1_000_000 })
  const call = resolveCallWithModelInfo({ provider: 'route', model: 'model' }, normalized)
  return { normalized, call }
}

/** What a resolved scenario gets wrong about input headroom, if it resolves at all. */
function headroomProblems(scenario: Case): string[] {
  let resolved: ReturnType<typeof resolve>
  try { resolved = resolve(scenario) } catch { return [] }
  const window = resolved.normalized.context?.contextWindow ?? Infinity
  const maxTokens = resolved.call.config.maxTokens
  const ceiling = resolved.normalized.maxOutputTokens
  const problems: string[] = []
  if (exceeds(maxTokens, window, true) || exceeds(maxTokens, ceiling, false)) {
    problems.push(`${JSON.stringify(scenario)} -> maxTokens ${maxTokens} in window ${window}`)
  }
  // Compaction keeps free what the request asks for, else the ceiling held
  // to half the window (compaction.ts `outputReserve`); the rest holds input.
  const reserve = maxTokens ?? Math.min(ceiling ?? 0, Math.floor(window / 2))
  if (window - reserve < Math.min(1_000, window / 4)) {
    problems.push(`${JSON.stringify(scenario)} -> compaction threshold ${window - reserve} of ${window}`)
  }
  return problems
}

describe('catalog window resolution properties', () => {
  const RUNS = 25_000
  const random = mulberry32(0xC0FFEE)
  const cases = Array.from({ length: RUNS }, () => generate(random))

  it('never refuses a model whose own declarations agree, whatever the route falls back to', () => {
    const refused: string[] = []
    for (const scenario of cases.filter(entry => selfConsistent(entry.entry))) {
      try {
        resolve(scenario)
      } catch (error) {
        refused.push(`${JSON.stringify(scenario)} -> ${(error as Error).message}`)
      }
    }
    expect(refused.slice(0, 5)).toEqual([])
  })

  it('always leaves input headroom in what it resolves to', () => {
    const unsafe = cases.flatMap(headroomProblems)
    expect(unsafe.slice(0, 5)).toEqual([])
  })
})
