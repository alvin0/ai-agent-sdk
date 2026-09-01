/**
 * SPIKE C — caller-owned persistence with an awaited durability boundary.
 *
 * The open question is not merely "who writes the file/database?". A process can
 * die after a mutating tool ran but before the caller saved history. The useful
 * seam must therefore gate the side effect, while leaving the storage backend
 * outside the SDK.
 *
 * Run: `node spikes/persistence-boundary.ts`
 */

import assert from 'node:assert/strict'
import {
  createAssistantMessage,
  createTextMessage,
  type Message,
} from '../src/core/message/message.ts'
import { ToolCallId } from '../src/core/primitives/brand.ts'

interface SpikeEntry {
  seq: number
  kind: 'user' | 'assistant'
  message: Message
}

interface HistorySnapshotV1 {
  version: 1
  entries: readonly SpikeEntry[]
}

/** The proposed caller-owned seam: core awaits it at a named safety boundary. */
type Checkpoint = (
  reason: 'before-model-request' | 'before-tool-dispatch',
  snapshot: HistorySnapshotV1,
) => Promise<void>

function roundTrip(snapshot: HistorySnapshotV1): HistorySnapshotV1 {
  return JSON.parse(JSON.stringify(snapshot)) as HistorySnapshotV1
}

async function runWithCheckpoint(checkpoint: Checkpoint, order: string[]): Promise<void> {
  const callId = ToolCallId('call_write')
  const entries: SpikeEntry[] = [{
    seq: 0,
    kind: 'user',
    message: createTextMessage('write the file'),
  }, {
    seq: 1,
    kind: 'assistant',
    message: createAssistantMessage({
      content: [{
        type: 'tool-call',
        id: callId,
        name: 'write_file',
        arguments: '{"path":"a.txt"}',
      }],
      source: { provider: 'spike', model: 'spike' },
    }),
  }]

  order.push('history:tool-intent')
  await checkpoint('before-tool-dispatch', { version: 1, entries })
  order.push('tool:side-effect')
}

const sample: HistorySnapshotV1 = {
  version: 1,
  entries: [{ seq: 0, kind: 'user', message: createTextMessage('hello') }],
}
assert.deepEqual(roundTrip(sample), sample)

const successOrder: string[] = []
await runWithCheckpoint(async (_reason, snapshot) => {
  successOrder.push('checkpoint:start')
  const durableCopy = roundTrip(snapshot)
  assert.equal(durableCopy.entries[1]?.message.content[0]?.type, 'tool-call')
  successOrder.push('checkpoint:durable')
}, successOrder)
assert.deepEqual(successOrder, [
  'history:tool-intent',
  'checkpoint:start',
  'checkpoint:durable',
  'tool:side-effect',
])

const failureOrder: string[] = []
await assert.rejects(
  runWithCheckpoint(async () => {
    failureOrder.push('checkpoint:failed')
    throw new Error('disk unavailable')
  }, failureOrder),
  /disk unavailable/,
)
assert.deepEqual(failureOrder, ['history:tool-intent', 'checkpoint:failed'])

console.log('\nSPIKE C — persistence boundary\n')
console.log('  JSON snapshot round-trip     : PASS (message ids and tool calls preserved)')
console.log('  awaited checkpoint ordering : PASS (durable before side effect)')
console.log('  rejected checkpoint         : PASS (tool body did not run)')
console.log('  storage backend in core     : NOT REQUIRED\n')

