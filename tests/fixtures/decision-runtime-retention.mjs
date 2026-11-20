import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'

const tree = fileURLToPath(new URL('../../', import.meta.url))
const load = relative => import(pathToFileURL(resolve(tree, relative)))
const { createDecisionRuntime } = await load('packages/decision-adapter/dist/index.js')
const { abortable } = await load('packages/a2a/src/server/support.ts')
const { raceWithSignal } = await load('packages/a2a/src/client/values.ts')
const snapshots = []
const retained = []
let cleanups = 0
async function collect() {
  for (let cycle = 0; cycle < 4; cycle++) { await setImmediate(); global.gc() }
}
async function closedRuntime() {
  const capture = { text: randomBytes(8192).toString('hex') }
  snapshots.push(new WeakRef(capture))
  const runtime = createDecisionRuntime({ providers: [{
    kind: 'decision-provider-plugin', apiVersion: 1, id: 'fixture', routes: ['fixture'],
    setup() { return () => { assert.ok(capture.text); cleanups++ } },
  }] })
  await runtime.close()
  await runtime.close()
  retained.push(runtime)
}
await collect()
for (let count = 0; count < 1000; count++) await closedRuntime()
await collect()
console.log(JSON.stringify({ scenario: 'decision-closed-runtimes', count: retained.length, cleanups,
  retainedCaptures: snapshots.filter(reference => reference.deref() !== undefined).length }))

const unhandled = []
const onUnhandled = error => unhandled.push(error)
process.on('unhandledRejection', onUnhandled)
for (let count = 0; count < 100; count++) {
  const controller = new AbortController()
  controller.abort(new Error('fixture canceled'))
  await abortable(Promise.reject(new Error('fixture completed with failure')), controller.signal).catch(() => {})
}
await setImmediate()
console.log(JSON.stringify({ scenario: 'a2a-preaborted-promise', count: 100, unhandledRejections: unhandled.length }))
unhandled.length = 0
for (let count = 0; count < 100; count++) {
  const controller = new AbortController()
  controller.abort(new Error('fixture canceled'))
  await raceWithSignal(Promise.reject(new Error('fixture completed with failure')), controller.signal).catch(() => {})
}
await setImmediate()
console.log(JSON.stringify({ scenario: 'a2a-client-preaborted-promise', count: 100,
  unhandledRejections: unhandled.length }))
process.off('unhandledRejection', onUnhandled)
