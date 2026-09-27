/** Local algorithm microbenchmark; not a provider or end-to-end latency benchmark. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createMemorySpillStore } from '@alvin0/ai-agent-sdk-core/tools'

const text = '🚀row data\n'.repeat(200000), reads = 20
const store = createMemorySpillStore()
const record = await store.save(text, { toolName: 'large-log', callId: 'microbenchmark' })
let previousMs = 0, currentMs = 0
for (let run = 0; run < reads; run++) {
  const before = performance.now()
  // Previous implementation materialized every code point for every read.
  assert.equal([...text].slice(0, 1).join(''), '🚀')
  previousMs += performance.now() - before
  const after = performance.now()
  assert.equal((await store.read(record.locator, { offset: 0, limit: 1 }))?.text, '🚀')
  currentMs += performance.now() - after
}
const report = { kind: 'algorithm-microbenchmark', bytes: record.bytes, reads, offset: 0, limit: 1,
  previousMaterializationMs: previousMs, currentStoreMs: currentMs,
  note: 'Previous read algorithm versus current memory store, same in-process data. Timings vary with runtime and GC; no provider latency claim.' }
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
