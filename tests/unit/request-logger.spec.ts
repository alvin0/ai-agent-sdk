import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderRequestLogRecord } from '@ai-agent-sdk/provider-http'
import {
  combineProviderRequestLoggers,
  createDailyJsonlRequestLogger,
} from '@ai-agent-sdk/observability-node/diagnostic'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    // Every target came from mkdtemp under the OS temp directory.
    if (!absolute.startsWith(resolve(tmpdir()))) throw new Error(`refusing to remove ${absolute}`)
    await rm(absolute, { recursive: true, force: true })
  }
})

function record(id: string): ProviderRequestLogRecord {
  return {
    schemaVersion: 1,
    type: 'provider-request',
    id,
    timestamp: 'ignored-by-file-logger',
    provider: 'codex',
    model: 'gpt-test',
    method: 'POST',
    url: 'https://provider.invalid/responses',
    headers: { authorization: '[REDACTED]' },
    body: { model: 'gpt-test', input: id },
    bodyBytes: 40,
  }
}

describe('createDailyJsonlRequestLogger', () => {
  it('creates a private provider wire file and appends one JSON record per line in call order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-'))
    roots.push(root)
    const logger = createDailyJsonlRequestLogger({
      rootDir: root,
      content: 'full',
      allowWireBodies: true,
      now: () => new Date('2026-08-30T12:34:56.000Z'),
    })

    await Promise.all([logger(record('first')), logger(record('second'))])

    await logger.shutdown()
    const text = await readWireFile(root, 'codex')
    const rows = text.trim().split('\n').map(line => JSON.parse(line) as ProviderRequestLogRecord)
    expect(rows.map(row => row.id)).toEqual(['first', 'second'])
    expect(rows.every(row => row.timestamp === '2026-08-30T12:34:56.000Z')).toBe(true)
  })

  it('sanitizes a provider route before using it as a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-'))
    roots.push(root)
    const logger = createDailyJsonlRequestLogger({
      rootDir: root, content: 'full', allowWireBodies: true,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    })
    await logger({ ...record('safe'), provider: '../outside' })
    await logger.shutdown()
    await expect(readWireFile(root, '__outside')).resolves.toContain('"id":"safe"')
  })

  it('refuses exact wire logging without both high-risk opt-ins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-'))
    roots.push(root)
    expect(() => createDailyJsonlRequestLogger({
      rootDir: root, content: 'metadata' as never, allowWireBodies: true,
    })).toThrow(/content: 'full'/i)
    expect(() => createDailyJsonlRequestLogger({
      rootDir: root, content: 'full', allowWireBodies: false as never,
    })).toThrow(/allowWireBodies/i)
  })

  it('fans a request out to aggregate and per-run logs', async () => {
    const aggregate = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-aggregate-'))
    const report = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-report-'))
    roots.push(aggregate, report)
    const now = () => new Date(2026, 7, 31, 12, 0, 0)
    const aggregateLogger = createDailyJsonlRequestLogger({
      rootDir: aggregate, content: 'full', allowWireBodies: true, now,
    })
    const reportLogger = createDailyJsonlRequestLogger({
      rootDir: report, content: 'full', allowWireBodies: true, now,
    })
    const logger = combineProviderRequestLoggers(aggregateLogger, reportLogger)

    await logger(record('mirrored'))

    await Promise.all([aggregateLogger.shutdown(), reportLogger.shutdown()])
    await expect(readWireFile(aggregate, 'codex')).resolves.toContain('"id":"mirrored"')
    await expect(readWireFile(report, 'codex')).resolves.toContain('"id":"mirrored"')
  })
})

async function readWireFile(root: string, provider: string): Promise<string> {
  const directory = join(root, provider, 'wire')
  const [name] = await readdir(directory)
  if (name === undefined) throw new Error(`wire directory ${directory} is empty`)
  return await readFile(join(directory, name), 'utf8')
}
