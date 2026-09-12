/**
 * The report machinery both conformance runners share.
 *
 * `ProviderConformanceReport` is ONE report with ONE `schemaVersion`, and the
 * embedding checks live in the same `checks` array as the generation checks
 * (Requirement 17.2). That only stays true if there is a single owner of the
 * check collector, the pass/fail message wording and the report assembly — so it
 * lives here rather than being duplicated per runner.
 *
 * Nothing in this module knows what a check MEANS. It knows how a check is
 * recorded, how a failure is worded so it stays support-safe, and how the counts
 * are derived. The two runners own the semantics.
 *
 * @module ai-agent-sdk/testkit/provider/report
 */

import { PROVIDER_CONFORMANCE_DEFAULTS } from './config.ts'
import type {
  ProviderConformanceCheck,
  ProviderConformanceCheckId,
  ProviderConformanceOptions,
  ProviderConformanceReport,
} from './types.ts'

/** A conformance claim that did not hold. Its message IS support-safe. */
export class ConformanceAssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'ConformanceAssertionError' }
}

/**
 * A case exceeded its budget.
 *
 * Distinct from {@link ConformanceAssertionError} because a timeout is not
 * evidence about the claim under test: a runner that expects a rejection must
 * not accept a timeout as that rejection.
 */
export class ConformanceTimeoutError extends Error {
  constructor(message = 'conformance case timed out') {
    super(message)
    this.name = 'ConformanceTimeoutError'
  }
}

/** Failure containing the complete support-safe result of a conformance run. */
export class ProviderConformanceError extends Error {
  readonly report: ProviderConformanceReport
  constructor(report: ProviderConformanceReport) {
    const failed = report.checks.filter(check => check.status === 'failed').map(check => check.message).join('; ')
    super(`Provider conformance failed: ${failed}`)
    this.name = 'ProviderConformanceError'
    this.report = report
  }
}

/** Timeouts every case is run under, after defaults are applied. */
export interface ResolvedConformanceTimeouts {
  readonly caseTimeoutMs: number
  readonly startupTimeoutMs: number
  readonly closeTimeoutMs: number
}

/** Accumulates check results in execution order. */
export interface ConformanceCheckCollector {
  /** Live array, in the order checks completed. */
  readonly checks: ProviderConformanceCheck[]
  /** Run one check, recording pass or failure instead of propagating. */
  check(id: ProviderConformanceCheckId, task: () => Promise<void> | void): Promise<void>
  /** Record a result a caller produced itself, e.g. a check with a return value. */
  record(id: ProviderConformanceCheckId, error?: unknown): void
}

export function createCheckCollector(): ConformanceCheckCollector {
  const checks: ProviderConformanceCheck[] = []
  const record = (id: ProviderConformanceCheckId, error?: unknown): void => {
    checks.push(error === undefined
      ? Object.freeze({ id, status: 'passed', message: passedMessage(id) })
      : Object.freeze({ id, status: 'failed', message: failedMessage(id, error) }))
  }
  return {
    checks,
    record,
    async check(id, task) {
      try {
        await task()
        record(id)
      } catch (error) {
        record(id, error ?? new Error('check failed without a value'))
      }
    },
  }
}

/** Assemble the frozen report. `schemaVersion` is and stays `1`. */
export function assembleReport(
  checks: readonly ProviderConformanceCheck[],
): ProviderConformanceReport {
  const failed = checks.filter(row => row.status === 'failed').length
  return Object.freeze({
    schemaVersion: 1,
    status: failed === 0 ? 'passed' : 'failed',
    checks: Object.freeze([...checks]),
    passed: checks.length - failed,
    failed,
  })
}

export function resolveTimeouts(options: ProviderConformanceOptions): ResolvedConformanceTimeouts {
  return Object.freeze({
    caseTimeoutMs: positive(options.caseTimeoutMs ?? PROVIDER_CONFORMANCE_DEFAULTS.caseTimeoutMs),
    startupTimeoutMs: positive(options.startupTimeoutMs ?? PROVIDER_CONFORMANCE_DEFAULTS.startupTimeoutMs),
    closeTimeoutMs: positive(options.closeTimeoutMs ?? PROVIDER_CONFORMANCE_DEFAULTS.closeTimeoutMs),
  })
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Conformance timeouts must be positive finite numbers')
  return value
}

/** Reject with {@link ConformanceTimeoutError} once `timeoutMs` elapses. */
export async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ConformanceTimeoutError())
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceAssertionError(message)
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('dependent conformance case failed')
  return value
}

export function passedMessage(id: ProviderConformanceCheckId): string { return `${id} passed` }

/**
 * Failure wording.
 *
 * Only a {@link ConformanceAssertionError} message is reproduced: it is written
 * by this package and carries no provider payload. Anything else is reported as a
 * bare failure, because an arbitrary thrown value may hold a credential or a
 * request body.
 */
export function failedMessage(id: ProviderConformanceCheckId, error: unknown): string {
  if (error instanceof ConformanceAssertionError) return `${id} failed: ${error.message}`
  if (error instanceof ConformanceTimeoutError) return `${id} failed: ${error.message}`
  return `${id} failed`
}
