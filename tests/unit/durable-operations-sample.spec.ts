import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolExecutionInterceptor, defineTool, dispatchToolCall, ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolExecutionResult, ToolOperation } from '@alvin0/ai-agent-sdk-core/agent'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { openOperationJournal, SCHEMA_VERSION, type OperationJournal } from '../../samples/durable-operations/journal.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-durable-sample-'))
  directories.push(directory)
  return join(directory, 'journal.sqlite')
}

const identity = { tenant: 'tenant-a', session: 'session-1' }
const signal = () => new AbortController().signal
const operation = (id = 'tenant-a:op-1', args: unknown = { amount: 7 }): ToolOperation => ({ operationId: id, toolName: 'create_record', args, identity })
const result = (receipt: string): ToolExecutionResult => ({ isError: false, value: { receipt }, content: [{ type: 'text', text: receipt }] })

async function runThroughInterceptor(journal: OperationJournal, args: { amount: number }, effects: { count: number }, id = 'tenant-a:op-1') {
  const tools = new ToolRegistry()
  tools.register(defineTool({ name: 'create_record', description: 'Create.', parameters: { type: 'object' }, execute: () => { effects.count++; return { receipt: `r-${String(effects.count)}` } } }))
  return await dispatchToolCall({
    catalog: tools, call: { callId: ToolCallId('call-1'), toolName: 'create_record', rawArguments: JSON.stringify(args) },
    position: { turn: 1, step: 1 }, signal: signal(),
    interceptors: [createToolExecutionInterceptor({ identity, operationId: () => id, store: journal.store })],
  })
}

describe('durable operations sample: schema', () => {
  it('serializes migrations when two real workers open the same older database', async () => {
    const path = databasePath()
    const database = new DatabaseSync(path)
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE operations (id TEXT PRIMARY KEY, operation TEXT NOT NULL, result TEXT, owner TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE intents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE approvals (id TEXT PRIMARY KEY, request TEXT NOT NULL, decision TEXT);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=1; BEGIN IMMEDIATE;`)
    const workers: Worker[] = []
    let locked = true
    try {
      const runs = [0, 1].map(() => {
        const worker = new Worker(new URL('./fixtures/durable-journal-worker.mjs', import.meta.url), {
          workerData: { path }, execArgv: ['--experimental-strip-types'],
        })
        workers.push(worker)
        let unlock!: () => void
        let rejectLock!: (error: Error) => void
        const locking = new Promise<void>((resolve, reject) => { unlock = resolve; rejectLock = reject })
        const done = new Promise<number>((resolve, reject) => {
          let completed = false
          const fail = (error: Error) => { rejectLock(error); reject(error) }
          worker.on('message', (message: { type: string; version: number; message: string }) => {
            if (message.type === 'locking') unlock()
            if (message.type === 'done') { completed = true; resolve(message.version) }
            if (message.type === 'failed') fail(new Error(message.message))
          })
          worker.once('error', fail)
          worker.once('exit', () => { if (!completed) fail(new Error('Journal worker exited before migration completed')) })
        })
        // Attach immediately: a failure must not become an unhandled rejection
        // while the other opener is still waiting for its write lock.
        void done.catch(() => undefined)
        return { locking, done }
      })
      await Promise.all(runs.map(run => run.locking))
      database.exec('COMMIT')
      locked = false
      expect(await Promise.all(runs.map(run => run.done))).toEqual([SCHEMA_VERSION, SCHEMA_VERSION])
      expect(Number(database.prepare('PRAGMA user_version').get()!.user_version)).toBe(SCHEMA_VERSION)
    } finally {
      if (locked) database.exec('ROLLBACK')
      await Promise.all(workers.map(worker => worker.terminate()))
      database.close()
    }
  })
  it('migrates an empty database and a research-schema database forward, keeping rows', () => {
    const fresh = openOperationJournal(databasePath())
    expect(Number(fresh.database.prepare('PRAGMA user_version').get()!.user_version)).toBe(SCHEMA_VERSION)
    fresh.close()

    const path = databasePath()
    const research = new DatabaseSync(path)
    research.exec(`CREATE TABLE operations (id TEXT PRIMARY KEY, operation TEXT NOT NULL, result TEXT, owner TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE intents (id TEXT PRIMARY KEY, data TEXT NOT NULL);`)
    research.prepare('INSERT INTO operations(id, operation, owner) VALUES (?, ?, ?)').run('old', JSON.stringify(operation('old')), 'research')
    research.close()
    const migrated = openOperationJournal(path)
    expect(Number(migrated.database.prepare('PRAGMA user_version').get()!.user_version)).toBe(SCHEMA_VERSION)
    expect(migrated.database.prepare('SELECT id, claimed_at FROM operations').all()).toEqual([{ id: 'old', claimed_at: null }])
    migrated.close()
  })

  it('refuses a database written by newer code', () => {
    const path = databasePath()
    const newer = new DatabaseSync(path)
    newer.exec(`PRAGMA user_version=${String(SCHEMA_VERSION + 1)}`)
    newer.close()
    expect(() => openOperationJournal(path)).toThrow(/newer than this code/)
  })
})

describe('durable operations sample: recovery', () => {
  it('reuses a completed result after restart without running the body again', async () => {
    const path = databasePath()
    const effects = { count: 0 }
    const first = openOperationJournal(path)
    expect(await runThroughInterceptor(first, { amount: 7 }, effects)).toMatchObject({ isError: false, value: { receipt: 'r-1' } })
    first.close()
    const second = openOperationJournal(path)
    expect(await runThroughInterceptor(second, { amount: 7 }, effects)).toMatchObject({ isError: false, value: { receipt: 'r-1' } })
    expect(effects.count).toBe(1)
    second.close()
  })

  it('keeps an unresolved claim unknown after restart and treats changed input as a conflict', async () => {
    const path = databasePath()
    const first = openOperationJournal(path)
    expect(await first.store.claim(operation(), signal())).toEqual({ status: 'claimed' })
    first.close()
    const second = openOperationJournal(path)
    const effects = { count: 0 }
    await expect(runThroughInterceptor(second, { amount: 7 }, effects)).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })
    await expect(runThroughInterceptor(second, { amount: 8 }, effects)).rejects.toMatchObject({ code: 'OPERATION_ID_CONFLICT' })
    expect(effects.count).toBe(0)
    second.close()
  })

  it('reconciles only from a receipt, fences the late original writer, and keeps unknown without one', async () => {
    const path = databasePath()
    const writer = openOperationJournal(path)
    await writer.store.claim(operation(), signal())
    const host = openOperationJournal(path)
    expect(await host.reconcile('tenant-a:op-1', async () => ({ status: 'unknown' }))).toBe('unknown')
    expect(await host.reconcile('tenant-a:op-1', async () => ({ status: 'completed', result: result('receipt-9') }))).toBe('reconciled')
    await expect(writer.store.complete(operation(), result('late'), signal())).rejects.toThrow(/ownership lost/)
    expect(await host.store.claim(operation(), signal())).toMatchObject({ status: 'completed', result: { value: { receipt: 'receipt-9' } } })
    expect(await host.reconcile('tenant-a:op-1', async () => { throw new Error('must not look up a completed operation') })).toBe('already-completed')
    writer.close(); host.close()
  })
})

describe('durable operations sample: retention', () => {
  it('retires an unresolved operation into a tombstone that can never be claimed again', async () => {
    const journal = openOperationJournal(databasePath())
    await journal.store.claim(operation(), signal())
    expect(() => journal.retire('tenant-a:op-1', { actor: '', reason: 'x' })).toThrow(TypeError)
    expect(journal.retire('tenant-a:op-1', { actor: 'operator-7', reason: 'receipt service decommissioned' })).toBe(true)
    expect(await journal.store.claim(operation(), signal())).toMatchObject({ status: 'unknown' })
    expect(await journal.reconcile('tenant-a:op-1', async () => ({ status: 'completed', result: result('x') }))).toBe('retired')
    expect(journal.database.prepare('SELECT actor, reason FROM tombstones').all()).toEqual([{ actor: 'operator-7', reason: 'receipt service decommissioned' }])
    await journal.store.claim(operation('tenant-a:op-2'), signal())
    await journal.store.complete(operation('tenant-a:op-2'), result('done'), signal())
    expect(journal.retire('tenant-a:op-2', { actor: 'operator-7', reason: 'x' })).toBe(false)
    journal.close()
  })

  it('prunes only completed, published operations past the TTL', async () => {
    const clock = { value: 1_000 }
    const journal = openOperationJournal(databasePath(), { now: () => clock.value })
    for (const id of ['done-published', 'done-unpublished', 'unresolved']) await journal.store.claim(operation(id), signal())
    await journal.store.complete(operation('done-published'), result('a'), signal())
    await journal.store.complete(operation('done-unpublished'), result('b'), signal())
    journal.markPublished('done-published')
    journal.markPublished('unresolved')
    clock.value = 1_000 + 60_000
    expect(journal.prune({ olderThanMs: 120_000 })).toBe(0)
    expect(journal.prune({ olderThanMs: 30_000 })).toBe(1)
    expect(journal.database.prepare('SELECT id FROM operations ORDER BY id').all().map(row => row.id)).toEqual(['done-unpublished', 'unresolved'])
    journal.close()
  })

  it('expires other owners\' pending approvals only when the host asks, never its own', () => {
    const path = databasePath()
    const earlier = openOperationJournal(path)
    const live = openOperationJournal(path)
    earlier.approvals.savePending({ approvalRequestId: 'approval-earlier' } as never)
    live.approvals.savePending({ approvalRequestId: 'approval-live' } as never)
    earlier.close()
    // Opening does not expire anything: another writer may still be alive.
    const restarted = openOperationJournal(path, { owner: live.owner })
    expect(restarted.database.prepare('SELECT count(*) AS n FROM approvals WHERE decision IS NULL').get()).toEqual({ n: 2 })
    expect(restarted.expirePendingApprovals()).toBe(1)
    restarted.approvals.saveDecision({ approvalRequestId: 'approval-earlier' } as never, 'allow')
    expect(restarted.database.prepare('SELECT id, decision FROM approvals ORDER BY id').all()).toEqual([
      { id: 'approval-earlier', decision: 'stale' }, { id: 'approval-live', decision: null },
    ])
    live.close(); restarted.close()
  })

  it('keeps pending intents until the host finishes them', () => {
    const journal = openOperationJournal(databasePath())
    const intent = { operationId: 'tenant-a:op-1', toolName: 'create_record', args: { amount: 7 }, identity }
    journal.recordIntent('pending', intent)
    expect(journal.pendingIntent('pending')).toEqual(intent)
    journal.finishIntent('pending')
    expect(journal.pendingIntent('pending')).toBeUndefined()
    journal.close()
  })
})
