import assert from 'node:assert/strict'
import { runPackedFetchObservationFixture } from './fixture.mjs'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  assert.deepEqual(await runPackedFetchObservationFixture(), {
    durable: true,
    boundary: 'remote-acknowledged',
    calls: 2,
    identicalBody: true,
    identicalKey: true,
    complete: true,
    lifetimeCount: 1,
    safe: true,
    runtimeFactory: true,
    buffer: 'undefined',
    process: 'undefined',
  })
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('standards:pass')
