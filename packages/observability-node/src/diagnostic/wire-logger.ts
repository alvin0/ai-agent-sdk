import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { JsonValue, ObservationContentPolicy } from '@alvin0/ai-agent-sdk-core/observability'
import { ensureSafeRoot, openExclusiveFile } from '../common/safe-filesystem.ts'

export interface ProviderWireLogRecord {
  readonly schemaVersion: 1
  readonly type: string
  readonly provider: string
  readonly timestamp: string
  readonly [key: string]: JsonValue
}

export interface ProviderWireLogger {
  (record: ProviderWireLogRecord): Promise<void>
  shutdown(): Promise<void>
}

export interface DiagnosticWireLoggerOptions {
  readonly rootDir: string
  readonly content: ObservationContentPolicy
  readonly allowWireBodies: boolean
  readonly now?: () => Date
}

function providerSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return safe.length === 0 ? '_unknown' : safe
}

/** Create an exact-wire logger only after two explicit high-risk opt-ins. */
export function createDiagnosticWireLogger(options: DiagnosticWireLoggerOptions): ProviderWireLogger {
  if (options?.content !== 'full' || options.allowWireBodies !== true) {
    throw new TypeError("wire diagnostics require content: 'full' and allowWireBodies: true")
  }
  const rootInput = resolve(options.rootDir)
  const handles = new Map<string, Promise<FileHandle>>()
  let tail: Promise<void> = Promise.resolve()
  let closed = false
  const handleFor = (provider: string): Promise<FileHandle> => {
    const segment = providerSegment(provider)
    const existing = handles.get(segment)
    if (existing !== undefined) return existing
    const pending = (async () => {
      const root = await ensureSafeRoot(join(rootInput, segment, 'wire'))
      const day = (options.now?.() ?? new Date()).toISOString().slice(0, 10)
      return await openExclusiveFile(root, `${day}-${process.pid}-${randomBytes(8).toString('hex')}.wire.jsonl`)
    })()
    handles.set(segment, pending)
    return pending
  }
  const logger = (async (record: ProviderWireLogRecord) => {
    if (closed) throw new TypeError('wire diagnostic logger is closed')
    const write = tail.then(async () => {
      const handle = await handleFor(record.provider)
      await handle.writeFile(
        `${JSON.stringify({ ...record, timestamp: (options.now?.() ?? new Date()).toISOString() })}\n`,
        'utf8',
      )
    })
    tail = write.catch(() => undefined)
    await write
  }) as ProviderWireLogger
  logger.shutdown = async () => {
    if (closed) return
    closed = true
    await tail
    for (const handle of await Promise.all(handles.values())) {
      await handle.datasync()
      await handle.close()
    }
  }
  return logger
}
