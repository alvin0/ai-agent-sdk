import assert from 'node:assert/strict'
import { runPackedProtocolFixture } from './fixture.mjs'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  assert.deepEqual(await runPackedProtocolFixture(), {
    protocol: 'gemini-interactions', model: 'packed-model',
    inputTokens: 6, outputTokens: 2, totalTokens: 12,
    buffer: 'undefined', process: 'undefined',
  })
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('standards:pass')
