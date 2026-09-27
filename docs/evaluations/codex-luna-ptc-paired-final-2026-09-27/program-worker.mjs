// SP-01 research executor: one QuickJS/WASM guest per program, inside a Node worker.
// The worker owns isolation and resource limits only. Every authority decision
// (allowlist, budget, program cap, policy, approval) is the host port's.
import { parentPort, workerData } from 'node:worker_threads'

const LIMITS = workerData.limits
const QUICKJS = workerData.quickjsEntry
const valid = n => Number.isSafeInteger(n) && n > 0
if (typeof workerData.code !== 'string' || Buffer.byteLength(workerData.code) > LIMITS.maxSourceBytes ||
    !valid(LIMITS.cpuMs) || !valid(LIMITS.heapBytes) || !valid(LIMITS.maxReplyBytes) ||
    !valid(LIMITS.maxProjectionBytes) || !valid(LIMITS.maxSourceBytes) || typeof QUICKJS !== 'string') {
  throw new Error('INVALID_EXECUTOR_CONFIG')
}
const { newAsyncContext } = await import(QUICKJS)
const vm = await newAsyncContext()
// Guest CPU budget. Time spent waiting for the host to run a tool is not guest
// CPU, so it extends the deadline; the host's wall-clock timer still bounds it all.
let deadline = Date.now() + LIMITS.cpuMs
vm.runtime.setMemoryLimit(LIMITS.heapBytes)
vm.runtime.setMaxStackSize(256 * 1024)
vm.runtime.setInterruptHandler(() => Date.now() > deadline)

// Lossless JSON only: undefined, functions, symbols and non-finite numbers are
// refused rather than silently dropped or turned into null.
const encode = value => {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        (typeof item === 'number' && !Number.isFinite(item))) throw new Error('NON_JSON_VALUE')
    return item
  })
  if (typeof encoded !== 'string') throw new Error('NON_JSON_VALUE')
  return encoded
}

let sequence = 0
const ask = message => new Promise(resolve => {
  const id = ++sequence
  const receive = event => {
    if (event?.id !== id) return // stale or foreign reply cannot settle this request
    parentPort.off('message', receive)
    resolve(event)
  }
  parentPort.on('message', receive)
  parentPort.postMessage({ ...message, id })
})

const reply = async message => {
  const waitStarted = Date.now()
  const answer = await ask(message)
  deadline += Date.now() - waitStarted
  if (!answer.ok) throw new Error(`${answer.code}: ${answer.message}`)
  const encoded = encode(answer.body)
  if (Buffer.byteLength(encoded) > LIMITS.maxReplyBytes) throw new Error('PROGRAM_REPLY_TOO_LARGE')
  return vm.newString(encoded)
}

const callTool = vm.newAsyncifiedFunction('__callTool', async (name, args, retain) => {
  const tool = vm.getString(name)
  const argument = vm.getString(args)
  if (Buffer.byteLength(argument) > LIMITS.maxReplyBytes) throw new Error('PROGRAM_INVALID_ARGUMENTS')
  return await reply({ type: 'call', tool, args: JSON.parse(argument), retain: vm.dump(retain) === true })
})
const loadResult = vm.newAsyncifiedFunction('__loadResult', async handle => await reply({ type: 'load', handle: vm.getString(handle) }))
vm.setProp(vm.global, '__callTool', callTool); callTool.dispose()
vm.setProp(vm.global, '__loadResult', loadResult); loadResult.dispose()
const catalog = vm.newString(encode(workerData.catalog))
vm.setProp(vm.global, '__catalog', catalog); catalog.dispose()

const prelude = `
const TOOLS = JSON.parse(__catalog);
function callToolResult(name, args, options) {
  return JSON.parse(__callTool(String(name), JSON.stringify(args === undefined ? {} : args), !!(options && options.retain)));
}
function callTool(name, args) { return callToolResult(name, args).value; }
function loadResult(handle) { return JSON.parse(__loadResult(String(handle))).value; }
`
// Programs are synchronous: an asyncified host call inside a QuickJS job
// corrupts the WASM stack, so async code is refused with a clear reason.
if (/\b(await|async)\b/.test(workerData.code)) {
  parentPort.postMessage({ type: 'error', code: 'PROGRAM_ASYNC_UNSUPPORTED', message: 'programs are synchronous: callTool returns the value directly; remove async/await and end with return' })
  vm.dispose()
  parentPort.close()
  await new Promise(() => {})
}
try {
  const result = await vm.evalCodeAsync(`${prelude}\n(function program() {\n${workerData.code}\n})()`, 'program.js')
  if (result.error) {
    const error = vm.dump(result.error); result.error.dispose()
    parentPort.postMessage({ type: 'error', code: 'PROGRAM_FAILED', message: String(error?.message ?? error).slice(0, 512) })
  } else {
    const state = vm.getPromiseState(result.value)
    if (state.type === 'pending') {
      result.value.dispose()
      parentPort.postMessage({ type: 'error', code: 'PROGRAM_PENDING', message: 'the program ended with a pending promise' })
    } else {
      const value = vm.dump(state.type === 'fulfilled' ? state.value : result.value)
      if (state.type === 'fulfilled' && state.value !== result.value) state.value.dispose()
      result.value.dispose()
      const encoded = encode(value ?? null)
      if (Buffer.byteLength(encoded) > LIMITS.maxProjectionBytes) {
        parentPort.postMessage({ type: 'error', code: 'PROGRAM_PROJECTION_TOO_LARGE', message: `result exceeds ${LIMITS.maxProjectionBytes} bytes` })
      } else parentPort.postMessage({ type: 'result', value: JSON.parse(encoded) })
    }
  }
} catch (error) {
  parentPort.postMessage({ type: 'error', code: 'PROGRAM_FAILED', message: (error instanceof Error ? error.message : 'guest failure').slice(0, 512) })
} finally {
  vm.dispose()
  parentPort.close()
}
