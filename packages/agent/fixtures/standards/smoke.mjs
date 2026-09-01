import assert from 'node:assert/strict'
import { runPackedAgentFixture } from './fixture.mjs'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  const result = await runPackedAgentFixture()
  assert.deepEqual(result, {
    text: 'packed agent completed', totalTokens: 23, toolCalls: 1,
    teamMembers: 1, compaction: 'completed', adapterCalls: 3,
    buffer: 'undefined', process: 'undefined',
  })
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('standards:pass')
