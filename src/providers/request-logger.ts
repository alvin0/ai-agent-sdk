/**
 * Node file logger for exact provider-wire requests.
 *
 * Records are JSON Lines rather than one growing JSON array: each request is one
 * independently parseable line, so appending does not rewrite the day's history
 * and a process crash cannot corrupt every earlier record.
 *
 * @module ai-agent-sdk/providers/request-logger
 */

import {
  createDiagnosticWireLogger,
  type ProviderWireLogRecord,
  type ProviderWireLogger,
} from '@ai-agent-sdk/observability-node'
import type {
  ProviderRequestLogger,
  ProviderRequestLogRecord,
} from './base/http-adapter.ts'

/** Options for {@link createDailyJsonlRequestLogger}. */
export interface DailyJsonlRequestLoggerOptions {
  /** Root containing one private `<provider>/wire/` folder. Defaults to `.providers`. */
  readonly rootDir?: string
  /** Required high-risk content opt-in. */
  readonly content: 'full'
  /** Required confirmation that exact provider bodies may be written. */
  readonly allowWireBodies: true
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date
  /** @deprecated Unique diagnostic files always use a UTC date. */
  readonly calendar?: 'local' | 'utc'
}

export type DailyJsonlRequestLogger = ProviderRequestLogger & Pick<ProviderWireLogger, 'shutdown'>

/**
 * Append each request to a private unique file below `.providers/<provider>/wire/`.
 *
 * Writes from one logger are serialized in call order. The returned logger is
 * still safe to call concurrently from several provider streams.
 */
export function createDailyJsonlRequestLogger(
  options: DailyJsonlRequestLoggerOptions,
): DailyJsonlRequestLogger {
  const wire = createDiagnosticWireLogger({
    rootDir: options.rootDir ?? '.providers',
    content: options.content,
    allowWireBodies: options.allowWireBodies,
    ...options.now === undefined ? {} : { now: options.now },
  })
  const logger = (async (record: ProviderRequestLogRecord): Promise<void> => {
    await wire(record as unknown as ProviderWireLogRecord)
  }) as DailyJsonlRequestLogger
  logger.shutdown = () => wire.shutdown()
  return logger
}

/** Fan one redacted request record out to multiple diagnostic sinks. */
export function combineProviderRequestLoggers(
  ...loggers: readonly ProviderRequestLogger[]
): ProviderRequestLogger {
  const sinks = Object.freeze([...loggers])
  return async record => {
    await Promise.all(sinks.map(async logger => { await logger(record) }))
  }
}
