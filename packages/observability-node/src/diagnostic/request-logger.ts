import {
  createDiagnosticWireLogger,
  type ProviderWireLogRecord,
  type ProviderWireLogger,
} from './wire-logger.ts'

/** Minimum structural input accepted from an HTTP provider request logger. */
export interface ProviderRequestLogLike {
  readonly provider: string
  readonly timestamp: string
}

export interface DailyJsonlRequestLoggerOptions {
  readonly rootDir?: string
  readonly content: 'full'
  readonly allowWireBodies: true
  readonly now?: () => Date
  /** @deprecated Unique diagnostic files always use a UTC date. */
  readonly calendar?: 'local' | 'utc'
}

export type DailyJsonlRequestLogger = (
  (record: ProviderRequestLogLike) => Promise<void>
) & Pick<ProviderWireLogger, 'shutdown'>

/** Compatibility-shaped exact request logger hosted by the Node diagnostic capability. */
export function createDailyJsonlRequestLogger(
  options: DailyJsonlRequestLoggerOptions,
): DailyJsonlRequestLogger {
  const wire = createDiagnosticWireLogger({
    rootDir: options.rootDir ?? '.providers',
    content: options.content,
    allowWireBodies: options.allowWireBodies,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const logger = (async (record: ProviderRequestLogLike): Promise<void> => {
    await wire(record as ProviderWireLogRecord)
  }) as DailyJsonlRequestLogger
  logger.shutdown = () => wire.shutdown()
  return logger
}

/** Fan one exact request record out to independent caller-owned log sinks. */
export function combineProviderRequestLoggers<RecordType extends ProviderRequestLogLike>(
  ...loggers: readonly ((record: RecordType) => Promise<void> | void)[]
): (record: RecordType) => Promise<void> {
  const sinks = Object.freeze([...loggers])
  return async record => {
    await Promise.all(sinks.map(async logger => { await logger(record) }))
  }
}
