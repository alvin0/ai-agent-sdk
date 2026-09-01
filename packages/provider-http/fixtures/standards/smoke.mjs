import assert from 'node:assert/strict'
import { runPackedProviderFixture } from './fixture.mjs'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  assert.deepEqual(await runPackedProviderFixture(), {
    text: 'packed provider completed',
    totalTokens: 12,
    attempts: 1,
    dispatchState: 'sent',
    requestId: 'packed-request',
    eventCount: 4,
    buffer: 'undefined',
    process: 'undefined',
  })
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('standards:pass')
