import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

const { ModelAdapter, ModelRegistry, createUserMessage } = await import(
  new URL('../../packages/core/dist/index.js', import.meta.url).href
)
const registry = new ModelRegistry()
class Fixture extends ModelAdapter {
  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
registry.registerAdapter(['fixture'], new Fixture())

async function collect() {
  for (let cycle = 0; cycle < 4; cycle++) {
    await setImmediate()
    global.gc()
  }
}

async function complete(handles, inputs) {
  const message = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: randomBytes(8192).toString('hex') }],
  })
  const handle = registry.stream({ provider: 'fixture', model: 'offline-fixture', messages: [message] })
  const iterator = handle[Symbol.asyncIterator]()
  for await (const chunk of iterator) assert.equal(chunk.type, 'finish')
  assert.equal((await handle.report).status, 'success')
  handles.push({ handle, iterator })
  inputs.push(new WeakRef(message))
}

for (let i = 0; i < 100; i++) await complete([], [])
await collect()
const handles = []
const inputs = []
for (let i = 0; i < 1000; i++) await complete(handles, inputs)
// Advance past the last measured async frame before testing its WeakRef.
await complete([], [])
await collect()
console.log(JSON.stringify({
  handlesAndIteratorsKept: handles.length,
  inputsRetained: inputs.filter(input => input.deref() !== undefined).length,
}))
