import assert from 'node:assert/strict'
import { runPackedOtelFixture } from './fixture.mjs'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  const result = await runPackedOtelFixture()
  assert.equal(result.spanCount, 1)
  assert.match(result.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-00$/)
  assert.equal(result.ended, true)
  assert.equal(result.semanticDuration, true)
  assert.equal(result.semanticTokens, 2)
  assert.equal(result.logCount, 1)
  assert.equal(result.safe, true)
  assert.equal(result.providerUnchanged, true)
  assert.equal(result.buffer, 'undefined')
  assert.equal(result.process, 'undefined')
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('otel-standards:pass')
