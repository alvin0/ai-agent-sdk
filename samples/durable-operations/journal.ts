import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  ApprovalRequest, ToolExecutionResult, ToolExecutionStore, ToolOperation,
} from '@alvin0/ai-agent-sdk-core/agent'

/**
 * Node-local durable operation journal for `createToolExecutionInterceptor`.
 *
 * Host sample, not a package. Proven for several processes on one machine
 * sharing one SQLite file; it is not a distributed store and promises no
 * exactly-once delivery to anything outside it. See README.md.
 */

/** Schema this code writes. A database newer than this is refused, never downgraded. */
export const SCHEMA_VERSION = 3

/** Forward-only. Each step runs in its own transaction when the journal opens. */
const MIGRATIONS: readonly ((database: DatabaseSync) => void)[] = [
  // 1: the SP-02 research schema. IF NOT EXISTS lets a research database adopt it.
  database => database.exec(`
    CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, operation TEXT NOT NULL, result TEXT,
      owner TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, request TEXT NOT NULL, decision TEXT);
    CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
      acknowledged INTEGER NOT NULL DEFAULT 0);`),
  // 2: retention timestamps and tombstones for retired operations.
  database => database.exec(`
    ALTER TABLE operations ADD COLUMN claimed_at INTEGER;
    ALTER TABLE operations ADD COLUMN completed_at INTEGER;
    ALTER TABLE operations ADD COLUMN published_at INTEGER;
    CREATE TABLE tombstones (id TEXT PRIMARY KEY, operation TEXT NOT NULL, actor TEXT NOT NULL,
      reason TEXT NOT NULL, retired_at INTEGER NOT NULL);`),
  // 3: which journal owner saved a pending approval, so expiry never touches a live writer's own.
  database => database.exec('ALTER TABLE approvals ADD COLUMN owner TEXT;'),
]

/** The exact call a host persisted before dispatch, so a restart resumes it rather than replanning. */
export interface PendingIntent {
  readonly operationId: string
  readonly toolName: string
  readonly args: unknown
  readonly identity: Readonly<Record<string, unknown>>
}

/** What an independent receipt lookup found. `unknown` keeps the operation unresolved. */
export type ReceiptLookup =
  | { readonly status: 'completed'; readonly result: ToolExecutionResult }
  | { readonly status: 'unknown' }

export type ReconcileOutcome = 'reconciled' | 'unknown' | 'already-completed' | 'retired' | 'not-found' | 'lost-race'

/** Instrumentation points for fault-injection harnesses. Production hosts leave them unset. */
export interface JournalHooks {
  afterClaim?(operation: ToolOperation): Promise<void> | void
  beforeCommit?(operation: ToolOperation, database: DatabaseSync): Promise<void> | void
  afterComplete?(operation: ToolOperation): Promise<void> | void
}

export interface OperationJournal {
  readonly database: DatabaseSync
  /** Pass to `createToolExecutionInterceptor({ store })`. */
  readonly store: ToolExecutionStore
  /** This journal's writer identity; claims and pending approvals record it. */
  readonly owner: string
  recordIntent(key: string, intent: PendingIntent): void
  pendingIntent(key: string): PendingIntent | undefined
  /** Only after the checkpoint that carries the operation's result has been written. */
  finishIntent(key: string): void
  reconcile(operationId: string, lookup: (operation: ToolOperation) => Promise<ReceiptLookup>): Promise<ReconcileOutcome>
  retire(operationId: string, by: { readonly actor: string; readonly reason: string }): boolean
  markPublished(operationId: string): void
  /** Deletes completed, published operations older than the TTL. Never touches unresolved ones. */
  prune(options: { readonly olderThanMs: number }): number
  /**
   * Mark approvals other owners left pending as stale. Call it only once the host
   * knows those writers are gone (for example, the single worker restarted);
   * a live writer's pending approval must not be expired from under it.
   */
  expirePendingApprovals(): number
  /** For `withApprovalPersistence`. Saved decisions are never replayed to a new request. */
  readonly approvals: {
    savePending(request: ApprovalRequest): void
    saveDecision(request: ApprovalRequest, decision: string): void
  }
  close(): void
}

export function openOperationJournal(path: string, options: {
  readonly hooks?: JournalHooks
  readonly now?: () => number
  readonly owner?: string
} = {}): OperationJournal {
  const database = new DatabaseSync(path)
  const now = options.now ?? Date.now
  const hooks = options.hooks ?? {}
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    migrate(database)
  } catch (error) {
    database.close()
    throw error
  }
  // One owner per process-lifetime journal. Generation fences a late writer
  // after a reconciler has taken the operation over.
  const owner = options.owner ?? `journal:${randomUUID()}`
  const owned = new Map<string, number>()
  const transaction = <T>(work: () => T): T => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  const operationOf = (text: unknown) => JSON.parse(String(text)) as ToolOperation

  const store: ToolExecutionStore = {
    async claim(operation, signal) {
      signal.throwIfAborted()
      return transaction(() => {
        const retired = database.prepare('SELECT operation FROM tombstones WHERE id=?').get(operation.operationId)
        // A retired identity is never claimable again: that would turn an
        // unknown outcome into a fresh side effect.
        if (retired !== undefined) return { status: 'unknown' as const, operation: operationOf(retired.operation) }
        const inserted = database.prepare(
          'INSERT INTO operations(id, operation, owner, claimed_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        ).run(operation.operationId, JSON.stringify(operation), owner, now()).changes
        if (Number(inserted) === 1) { owned.set(operation.operationId, 1); return { status: 'claimed' as const } }
        const row = database.prepare('SELECT operation, result FROM operations WHERE id=?').get(operation.operationId)!
        return row.result === null
          ? { status: 'unknown' as const, operation: operationOf(row.operation) }
          : { status: 'completed' as const, operation: operationOf(row.operation), result: JSON.parse(String(row.result)) as ToolExecutionResult }
      })
    },
    async complete(operation, result, signal) {
      signal.throwIfAborted()
      await hooks.beforeCommit?.(operation, database)
      const generation = owned.get(operation.operationId)
      if (generation === undefined) throw new Error('No owned claim for this operation')
      const encoded = JSON.stringify(result)
      // Throws the driver's own error (for example SQLITE_FULL) unchanged.
      const updated = database.prepare(
        'UPDATE operations SET result=?, completed_at=? WHERE id=? AND result IS NULL AND owner=? AND generation=?',
      ).run(encoded, now(), operation.operationId, owner, generation).changes
      if (Number(updated) !== 1) throw new Error('Completion ownership lost; the operation was reconciled or retired')
      owned.delete(operation.operationId)
      await hooks.afterComplete?.(operation)
    },
  }
  const claim = store.claim.bind(store)
  store.claim = async (operation, signal) => {
    const claimed = await claim(operation, signal)
    if (claimed.status === 'claimed') await hooks.afterClaim?.(operation)
    return claimed
  }

  return {
    database, store, owner,
    recordIntent(key, intent) {
      database.prepare('INSERT INTO intents(id, data) VALUES (?, ?)').run(key, JSON.stringify(intent))
    },
    pendingIntent(key) {
      const row = database.prepare('SELECT data FROM intents WHERE id=?').get(key)
      return row === undefined ? undefined : JSON.parse(String(row.data)) as PendingIntent
    },
    finishIntent(key) { database.prepare('DELETE FROM intents WHERE id=?').run(key) },
    async reconcile(operationId, lookup) {
      const row = database.prepare('SELECT operation, result, generation FROM operations WHERE id=?').get(operationId)
      if (row === undefined) {
        return database.prepare('SELECT 1 FROM tombstones WHERE id=?').get(operationId) === undefined ? 'not-found' : 'retired'
      }
      if (row.result !== null) return 'already-completed'
      // The receipt is read outside the transaction: never hold a write lock across a network call.
      const receipt = await lookup(operationOf(row.operation))
      if (receipt.status !== 'completed') return 'unknown'
      return transaction(() => {
        const committed = database.prepare(
          'UPDATE operations SET owner=?, generation=generation+1, result=?, completed_at=? WHERE id=? AND result IS NULL AND generation=?',
        ).run(`reconciler:${randomUUID()}`, JSON.stringify(receipt.result), now(), operationId, Number(row.generation)).changes
        return Number(committed) === 1 ? 'reconciled' as const : 'lost-race' as const
      })
    },
    retire(operationId, by) {
      if (by.actor.trim() === '' || by.reason.trim() === '') throw new TypeError('retire requires an actor and a reason')
      return transaction(() => {
        const row = database.prepare('SELECT operation FROM operations WHERE id=? AND result IS NULL').get(operationId)
        if (row === undefined) return false
        database.prepare('INSERT INTO tombstones(id, operation, actor, reason, retired_at) VALUES (?, ?, ?, ?, ?)')
          .run(operationId, String(row.operation), by.actor, by.reason, now())
        database.prepare('DELETE FROM operations WHERE id=?').run(operationId)
        return true
      })
    },
    markPublished(operationId) {
      database.prepare('UPDATE operations SET published_at=? WHERE id=? AND result IS NOT NULL').run(now(), operationId)
    },
    prune({ olderThanMs }) {
      if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new RangeError('olderThanMs must be a non-negative integer')
      return transaction(() => {
        const cutoff = now() - olderThanMs
        const ids = database.prepare(
          'SELECT id FROM operations WHERE result IS NOT NULL AND published_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at < ?',
        ).all(cutoff).map(entry => String(entry.id))
        for (const id of ids) {
          database.prepare('DELETE FROM operations WHERE id=?').run(id)
          database.prepare('DELETE FROM deliveries WHERE id=? AND acknowledged=1').run(id)
        }
        return ids.length
      })
    },
    expirePendingApprovals() {
      return Number(database.prepare(
        "UPDATE approvals SET decision='stale' WHERE decision IS NULL AND (owner IS NULL OR owner <> ?)").run(owner).changes)
    },
    approvals: {
      savePending(request) {
        database.prepare('INSERT INTO approvals(id, request, owner) VALUES (?, ?, ?)').run(request.approvalRequestId, JSON.stringify(request), owner)
      },
      saveDecision(request, decision) {
        database.prepare('UPDATE approvals SET decision=? WHERE id=? AND decision IS NULL').run(decision, request.approvalRequestId)
      },
    },
    close() { database.close() },
  }
}

function migrate(database: DatabaseSync): void {
  for (;;) {
    database.exec('BEGIN IMMEDIATE')
    try {
      // Another opener may have migrated while we waited for this lock.
      // Read the version only while holding the same lock as the DDL.
      const current = Number(database.prepare('PRAGMA user_version').get()!.user_version)
      if (current > SCHEMA_VERSION) {
        throw new Error(`operation journal schema ${String(current)} is newer than this code (${String(SCHEMA_VERSION)}); refusing to open`)
      }
      if (current === SCHEMA_VERSION) {
        database.exec('COMMIT')
        return
      }
      MIGRATIONS[current]!(database)
      database.exec(`PRAGMA user_version=${String(current + 1)}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}
