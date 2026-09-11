import assert from 'node:assert/strict'
import { runPackedProviderFixture } from './fixture.mjs'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  const result = await runPackedProviderFixture()
  assert.equal(result.text, 'packed provider completed')
  assert.equal(result.totalTokens, 12)
  assert.equal(result.credentialEvents, result.expectedCredentialEvents)
  assert.equal(result.safeEvents, true)
  assert.equal(result.buffer, 'undefined')
  assert.equal(result.process, 'undefined')
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('standards:pass')
