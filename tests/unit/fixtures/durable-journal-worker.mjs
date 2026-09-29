import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { openOperationJournal } from '../../../samples/durable-operations/journal.ts'

// Observe the real lock request. The test holds a write lock until both
// openers reach this boundary, exposing version reads made before the lock.
const exec = DatabaseSync.prototype.exec
let announced = false
DatabaseSync.prototype.exec = function (sql) {
  if (!announced && sql === 'BEGIN IMMEDIATE') {
    announced = true
    parentPort.postMessage({ type: 'locking' })
  }
  return exec.call(this, sql)
}
try {
  const journal = openOperationJournal(workerData.path)
  const version = journal.database.prepare('PRAGMA user_version').get().user_version
  journal.close()
  parentPort.postMessage({ type: 'done', version })
} catch (error) {
  parentPort.postMessage({ type: 'failed', message: error.message })
} finally {
  parentPort.close()
}
