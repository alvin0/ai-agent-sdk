/**
 * Node file logger for exact provider-wire requests.
 *
 * Records are JSON Lines rather than one growing JSON array: each request is one
 * independently parseable line, so appending does not rewrite the day's history
 * and a process crash cannot corrupt every earlier record.
 *
 * @module ai-agent-sdk/providers/request-logger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  ProviderRequestLogger,
  ProviderRequestLogRecord,
} from './base/http-adapter.ts'

/** Options for {@link createDailyJsonlRequestLogger}. */
export interface DailyJsonlRequestLoggerOptions {
  /** Root containing one `<provider>/logs/` folder. Defaults to `.providers`. */
  readonly rootDir?: string
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date
  /** Calendar used to rotate files. Defaults to the host's local calendar. */
  readonly calendar?: 'local' | 'utc'
}

/** Turn an arbitrary route name into one safe path segment. */
function providerSegment(provider: string): string {
  const safe = provider.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_')
  return safe.length === 0 ? '_unknown' : safe
}

/**
 * Append each request to `.providers/<provider>/logs/YYYY-MM-DD.jsonl` by default.
 *
 * Writes to one daily file are serialized in call order. The returned logger is
 * still safe to call concurrently from several provider streams.
 */
export function createDailyJsonlRequestLogger(
  options: DailyJsonlRequestLoggerOptions = {},
): ProviderRequestLogger {
  const root = resolve(options.rootDir ?? '.providers')
  const tails = new Map<string, Promise<void>>()

  return async (record: ProviderRequestLogRecord): Promise<void> => {
    const instant = options.now?.() ?? new Date()
    const timestamp = instant.toISOString()
    const day = options.calendar === 'utc' ? timestamp.slice(0, 10) : localDay(instant)
    const directory = resolve(root, providerSegment(record.provider), 'logs')
    const file = resolve(directory, `${day}.jsonl`)
    const durableRecord: ProviderRequestLogRecord = { ...record, timestamp }

    const write = (tails.get(file) ?? Promise.resolve()).then(async () => {
      await mkdir(directory, { recursive: true })
      await appendFile(file, `${JSON.stringify(durableRecord)}\n`, 'utf8')
    })
    // Keep the queue usable after a failed write while returning the real failure
    // to the pipeline (which deliberately contains diagnostic logger failures).
    const tracked = write.catch(() => {})
    tails.set(file, tracked)
    void tracked.finally(() => {
      if (tails.get(file) === tracked) tails.delete(file)
    })
    await write
  }
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

function localDay(value: Date): string {
  const year = value.getFullYear().toString().padStart(4, '0')
  const month = (value.getMonth() + 1).toString().padStart(2, '0')
  const day = value.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}
