import { parentPort, workerData } from 'node:worker_threads'
import { newAsyncContext } from '../../artifacts/spikes/quickjs-dependencies-v1/node_modules/quickjs-emscripten/dist/index.mjs'
if (typeof workerData.code !== 'string' || Buffer.byteLength(workerData.code) > 65536 ||
    !Number.isSafeInteger(workerData.cpuMs) || workerData.cpuMs < 1 || workerData.cpuMs > 10000 ||
    !Number.isSafeInteger(workerData.hardCap) || workerData.hardCap < 1 || workerData.hardCap > 100) {
  throw new Error('INVALID_EXECUTOR_CONFIG')
}
const vm = await newAsyncContext()
const deadline = Date.now() + workerData.cpuMs
vm.runtime.setMemoryLimit(8 * 1024 * 1024)
vm.runtime.setMaxStackSize(256 * 1024)
vm.runtime.setInterruptHandler(() => Date.now() > deadline)
let calls = 0
let fatal
const failClosed = code => { fatal ??= code; throw new Error(fatal) }
const encode = value => {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        (typeof item === 'number' && !Number.isFinite(item))) throw new Error('NON_JSON_VALUE')
    return item
  })
  if (typeof encoded !== 'string') throw new Error('NON_JSON_VALUE')
  return encoded
}
const fn = vm.newAsyncifiedFunction('callTool', async (name, args) => {
  if (fatal) throw new Error(fatal)
  if (++calls > workerData.hardCap) return failClosed('PROGRAM_CALL_CAP')
  const tool = vm.getString(name)
  if (tool !== 'read_rows') throw new Error('ALLOWLIST_DENIED')
  const argument = vm.getString(args)
  if (Buffer.byteLength(argument) > 65536) throw new Error('INPUT_CAP')
  const value = JSON.parse(argument)
  if (value === null || typeof value !== 'object' || !Number.isSafeInteger(value.page)) throw new Error('INVALID_ARGS')
  const reply = await new Promise((resolve, reject) => {
    const requestId = calls
    const receive = event => {
      if (event.requestId !== requestId) return
      parentPort.off('message', receive)
      if (event.error) { fatal ??= event.error; reject(new Error(fatal)) }
      else resolve(event.data)
    }
    parentPort.on('message', receive)
    parentPort.postMessage({ type: 'call', requestId, tool, args: value })
  })
  let encoded
  try { encoded = encode(reply) } catch { return failClosed('NON_JSON_VALUE') }
  if (Buffer.byteLength(encoded) > 65536) return failClosed('RESULT_CAP')
  return vm.newString(encoded)
})
vm.setProp(vm.global, 'callTool', fn); fn.dispose()
try {
  const result = await vm.evalCodeAsync(workerData.code, 'guest.js')
  if (fatal) {
    (result.error ?? result.value).dispose()
    parentPort.postMessage({ type: 'error', error: fatal })
  } else if (result.error) { const error = vm.dump(result.error); result.error.dispose(); parentPort.postMessage({ type: 'error', error: String(error?.message ?? error) }) }
  else {
    const value = vm.dump(result.value); result.value.dispose()
    const encoded = encode(value)
    if (Buffer.byteLength(encoded) > 8192) throw new Error('PROJECTION_CAP')
    parentPort.postMessage({ type: 'result', value, calls })
  }
} catch (error) { parentPort.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'guest failure' }) }
finally { vm.dispose(); parentPort.close() }
