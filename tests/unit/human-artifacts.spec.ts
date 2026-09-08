import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HumanArtifactRecorder } from '../../test-human/artifacts.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('human test artifacts', () => {
  it('writes bounded support-safe evidence with a verifiable digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-human-artifacts-'))
    cleanup.push(root)
    const recorder = new HumanArtifactRecorder({
      harness: 'artifact-test', runId: 'redaction', resultsRoot: root, maxRecords: 2,
    })
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(recorder.record('provider-call', {
      authorization: 'Bearer must-not-leak', apiKey: 'must-not-leak',
      prompt: 'private customer prompt', metadata: circular,
    })).toBe(true)
    expect(recorder.record('usage', {
      inputTokens: 11, outputTokens: 7,
      credential: { total: 2, success: 2, error: 0 },
    })).toBe(true)
    expect(recorder.record('overflow', { value: true })).toBe(false)
    const summary = await recorder.finish({
      status: 'passed', config: { token: 'must-not-leak' },
      invariants: [{ name: 'probe passes', passed: true }],
    })

    const events = await readFile(recorder.eventsPath, 'utf8')
    const saved = JSON.parse(await readFile(recorder.summaryPath, 'utf8')) as typeof summary
    expect(events).not.toContain('must-not-leak')
    expect(events).not.toContain('private customer prompt')
    expect(events).toContain('sha256')
    expect(events).toContain('"inputTokens":11')
    expect(events).toContain('"credential":{"total":2,"success":2,"error":0}')
    expect(saved.config).toEqual({ token: '<redacted>' })
    expect(saved.artifact).toMatchObject({ records: 2, droppedRecords: 1 })
    expect(saved.artifact.sha256).toBe(createHash('sha256').update(events).digest('hex'))
    // Windows exposes synthesized mode bits; it does not implement POSIX 0600.
    if (process.platform !== 'win32') {
      expect((await stat(recorder.summaryPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('never lets cyclic or hostile values break artifact completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-human-artifacts-'))
    cleanup.push(root)
    const recorder = new HumanArtifactRecorder({ harness: 'artifact-test', runId: 'hostile', resultsRoot: root })
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, 'boom', { enumerable: true, get() { throw new Error('getter secret') } })
    expect(() => recorder.record('hostile-value', hostile)).not.toThrow()
    const summary = await recorder.finish({ status: 'passed', metrics: hostile })
    expect(summary.status).toBe('passed')
    expect(summary.metrics).toMatchObject({ sanitizationFailed: true })
  })
})
