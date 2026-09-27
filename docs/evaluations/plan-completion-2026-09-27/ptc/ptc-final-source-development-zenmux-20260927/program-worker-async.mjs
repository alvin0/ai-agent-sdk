// Async program executor (v2): one QuickJS/WASM guest per program, inside a Node worker.
// No asyncify. callTool returns a guest Promise that the host settles; the event loop
// here runs QuickJS jobs until the program's promise settles. Children are queued so
// the host port only ever sees one in flight. Every authority decision stays with
// the host port, exactly as in the synchronous executor.
import { parentPort, workerData } from 'node:worker_threads'
import { GUEST_JSON_PRELUDE, encodeGuestProjection, projectionFailureCode } from './guest-json.mjs'

const LIMITS = workerData.limits
const QUICKJS = workerData.quickjsEntry
const valid = n => Number.isSafeInteger(n) && n > 0
if (typeof workerData.code !== 'string' || Buffer.byteLength(workerData.code) > LIMITS.maxSourceBytes ||
    !valid(LIMITS.cpuMs) || !valid(LIMITS.heapBytes) || !valid(LIMITS.maxReplyBytes) ||
    !valid(LIMITS.maxProjectionBytes) || !valid(LIMITS.maxSourceBytes) || typeof QUICKJS !== 'string') {
  throw new Error('INVALID_EXECUTOR_CONFIG')
}
const { getQuickJS } = await import(QUICKJS)
const QuickJS = await getQuickJS()
const runtime = QuickJS.newRuntime()
runtime.setMemoryLimit(LIMITS.heapBytes)
runtime.setMaxStackSize(256 * 1024)
const vm = runtime.newContext()

// Guest CPU: only time spent inside QuickJS counts; waiting for the host does not.
let cpuUsed = 0
let segmentStart = 0
runtime.setInterruptHandler(() => cpuUsed + (Date.now() - segmentStart) > LIMITS.cpuMs)
const inGuest = work => {
  segmentStart = Date.now()
  try { return work() } finally { cpuUsed += Date.now() - segmentStart }
}

const encode = value => {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        (typeof item === 'number' && !Number.isFinite(item))) throw new Error('NON_JSON_VALUE')
    return item
  })
  if (typeof encoded !== 'string') throw new Error('NON_JSON_VALUE')
  return encoded
}

// Host requests: queued, one in flight, each settling one guest promise.
const queue = []
let inFlight
let sequence = 0
const replies = new Map()
parentPort.on('message', event => {
  if (inFlight === undefined || event?.id !== inFlight.id) return // stale or foreign reply
  replies.set(event.id, event)
  wake?.()
})
let wake
const nextEvent = () => new Promise(resolve => { wake = () => { wake = undefined; resolve() } })

function enqueue(message) {
  const deferred = vm.newPromise()
  queue.push({ message, deferred })
  return deferred.handle
}
function pump() {
  if (inFlight !== undefined || queue.length === 0) return
  const next = queue.shift()
  inFlight = { ...next, id: ++sequence }
  parentPort.postMessage({ ...next.message, id: inFlight.id })
}
function settleInFlight(answer) {
  const { deferred } = inFlight
  inFlight = undefined
  let failure
  let encoded
  if (!answer.ok) failure = `${answer.code}: ${answer.message}`
  else {
    try { encoded = encode(answer.body) } catch { failure = 'NON_JSON_VALUE: the host reply is not lossless JSON' }
    if (encoded !== undefined && Buffer.byteLength(encoded) > LIMITS.maxReplyBytes) failure = 'PROGRAM_REPLY_TOO_LARGE: the reply exceeds the byte limit'
  }
  if (failure === undefined) {
    const value = vm.newString(encoded)
    deferred.resolve(value)
    value.dispose()
  } else {
    const error = vm.newError(failure)
    deferred.reject(error)
    error.dispose()
  }
  deferred.dispose()
}

const callTool = vm.newFunction('__callTool', (name, args, retain) => {
  const tool = vm.getString(name)
  const argument = vm.getString(args)
  if (Buffer.byteLength(argument) > LIMITS.maxReplyBytes) throw new Error('PROGRAM_INVALID_ARGUMENTS')
  return enqueue({ type: 'call', tool, args: JSON.parse(argument), retain: vm.dump(retain) === true })
})
const loadResult = vm.newFunction('__loadResult', handle => enqueue({ type: 'load', handle: vm.getString(handle) }))
vm.setProp(vm.global, '__callTool', callTool); callTool.dispose()
vm.setProp(vm.global, '__loadResult', loadResult); loadResult.dispose()
const catalog = vm.newString(encode(workerData.catalog))
vm.setProp(vm.global, '__catalog', catalog); catalog.dispose()

const prelude = `
${GUEST_JSON_PRELUDE}
const TOOLS = JSON.parse(__catalog);
async function callToolResult(name, args, options) {
  return JSON.parse(await __callTool(String(name), __encodeArguments(args === undefined ? {} : args), !!(options && options.retain)));
}
async function callTool(name, args) { return (await callToolResult(name, args)).value; }
async function loadResult(handle) { return JSON.parse(await __loadResult(String(handle))).value; }
`

const fail = (code, message) => parentPort.postMessage({ type: 'error', code, message: String(message).slice(0, 512) })
let program
try {
  const evaluated = inGuest(() => vm.evalCode(`${prelude}\n(async function program() {\n${workerData.code}\n})()`, 'program.js'))
  if (evaluated.error) {
    const error = vm.dump(evaluated.error); evaluated.error.dispose()
    fail('PROGRAM_FAILED', error?.message ?? error)
  } else {
    program = evaluated.value
    for (;;) {
      const jobs = inGuest(() => runtime.executePendingJobs())
      if (jobs.error) {
        const error = vm.dump(jobs.error); jobs.error.dispose()
        fail('PROGRAM_FAILED', error?.message ?? error)
        break
      }
      jobs.dispose()
      const state = vm.getPromiseState(program)
      if (state.type === 'fulfilled') {
        let encoded
        try { encoded = inGuest(() => encodeGuestProjection(vm, state.value, LIMITS.maxProjectionBytes)) }
        finally { if (state.value !== program) state.value.dispose() }
        if (Buffer.byteLength(encoded) > LIMITS.maxProjectionBytes) fail('PROGRAM_PROJECTION_TOO_LARGE', `result exceeds ${LIMITS.maxProjectionBytes} bytes`)
        else parentPort.postMessage({ type: 'result', value: JSON.parse(encoded) })
        break
      }
      if (state.type === 'rejected') {
        const error = vm.dump(state.error); state.error.dispose()
        fail('PROGRAM_FAILED', error?.message ?? error)
        break
      }
      pump()
      if (inFlight === undefined && !runtime.hasPendingJob()) {
        fail('PROGRAM_PENDING', 'the program is waiting on a promise nothing will settle')
        break
      }
      if (inFlight !== undefined && !replies.has(inFlight.id)) await nextEvent()
      if (inFlight !== undefined && replies.has(inFlight.id)) {
        const answer = replies.get(inFlight.id)
        replies.delete(inFlight.id)
        inGuest(() => settleInFlight(answer))
      }
    }
  }
} catch (error) {
  fail(projectionFailureCode(error), error instanceof Error ? error.message : 'guest failure')
} finally {
  program?.dispose()
  for (const entry of queue) entry.deferred.dispose()
  if (inFlight !== undefined) inFlight.deferred.dispose()
  vm.dispose()
  runtime.dispose()
  parentPort.close()
}
