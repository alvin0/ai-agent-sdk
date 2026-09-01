import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderRequestLogRecord } from '../../src/providers/base/http-adapter.ts'
import {
  combineProviderRequestLoggers,
  createDailyJsonlRequestLogger,
} from '../../src/providers/request-logger.ts'

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
  it('creates provider/logs and appends one JSON record per line in call order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-'))
    roots.push(root)
    const logger = createDailyJsonlRequestLogger({
      rootDir: root,
      now: () => new Date('2026-08-30T12:34:56.000Z'),
    })

    await Promise.all([logger(record('first')), logger(record('second'))])

    const text = await readFile(join(root, 'codex', 'logs', '2026-08-30.jsonl'), 'utf8')
    const rows = text.trim().split('\n').map(line => JSON.parse(line) as ProviderRequestLogRecord)
    expect(rows.map(row => row.id)).toEqual(['first', 'second'])
    expect(rows.every(row => row.timestamp === '2026-08-30T12:34:56.000Z')).toBe(true)
  })

  it('sanitizes a provider route before using it as a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-'))
    roots.push(root)
    const logger = createDailyJsonlRequestLogger({
      rootDir: root,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    })
    await logger({ ...record('safe'), provider: '../outside' })
    await expect(readFile(join(root, '__outside', 'logs', '2026-08-30.jsonl'), 'utf8'))
      .resolves.toContain('"id":"safe"')
  })

  it('rotates by the host local calendar while keeping UTC timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-'))
    roots.push(root)
    const localMidnight = new Date(2026, 7, 31, 0, 15, 0)
    const logger = createDailyJsonlRequestLogger({ rootDir: root, now: () => localMidnight })

    await logger(record('local-day'))

    const text = await readFile(join(root, 'codex', 'logs', '2026-08-31.jsonl'), 'utf8')
    const row = JSON.parse(text) as ProviderRequestLogRecord
    expect(row.timestamp).toBe(localMidnight.toISOString())
  })

  it('fans a request out to aggregate and per-run logs', async () => {
    const aggregate = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-aggregate-'))
    const report = await mkdtemp(join(tmpdir(), 'agent-sdk-request-log-report-'))
    roots.push(aggregate, report)
    const now = () => new Date(2026, 7, 31, 12, 0, 0)
    const logger = combineProviderRequestLoggers(
      createDailyJsonlRequestLogger({ rootDir: aggregate, now }),
      createDailyJsonlRequestLogger({ rootDir: report, now }),
    )

    await logger(record('mirrored'))

    const relative = join('codex', 'logs', '2026-08-31.jsonl')
    await expect(readFile(join(aggregate, relative), 'utf8')).resolves.toContain('"id":"mirrored"')
    await expect(readFile(join(report, relative), 'utf8')).resolves.toContain('"id":"mirrored"')
  })
})
