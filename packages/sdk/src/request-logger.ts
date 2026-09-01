/** Deprecated exact-wire diagnostic compatibility shim. */

import {
  createDiagnosticWireLogger,
  type ProviderWireLogRecord,
  type ProviderWireLogger,
} from '@ai-agent-sdk/observability-node'
import type {
  ProviderRequestLogger,
  ProviderRequestLogRecord,
} from '@ai-agent-sdk/provider-http'

export interface DailyJsonlRequestLoggerOptions {
  readonly rootDir?: string
  readonly content: 'full'
  readonly allowWireBodies: true
  readonly now?: () => Date
  /** @deprecated Unique diagnostic files always use a UTC date. */
  readonly calendar?: 'local' | 'utc'
}

export type DailyJsonlRequestLogger = ProviderRequestLogger & Pick<ProviderWireLogger, 'shutdown'>

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

export function combineProviderRequestLoggers(
  ...loggers: readonly ProviderRequestLogger[]
): ProviderRequestLogger {
  const sinks = Object.freeze([...loggers])
  return async record => { await Promise.all(sinks.map(async logger => { await logger(record) })) }
}
