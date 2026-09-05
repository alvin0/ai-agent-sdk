/** Reproducible isolated bundle and strict workerd evidence. */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { assertImportInspection, importSpecifiers } from './import-inspection.mts'
import { InspectorClient, type InspectorHeapUsage } from './inspector-client.mts'

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)))
const workspaceRoot = resolve(benchmarkRoot, '../../..')
const artifactRoot = resolve(workspaceRoot, '.temp/core-capability-benchmark')
const wrangler = resolve(workspaceRoot, 'node_modules/.bin/wrangler')
const CONTRACT_HEAP_USED_BUDGET_BYTES = 4 * 1024 * 1024
const BASIC_AGENT_HEAP_PEAK_BUDGET_BYTES = 16 * 1024 * 1024
const BASIC_AGENT_HEAP_DELTA_BUDGET_BYTES = 8 * 1024 * 1024
const CONTRACT_BUNDLE_GZIP_BUDGET_BYTES = 14_000
const BASIC_AGENT_BUNDLE_GZIP_BUDGET_BYTES = 70_000
const CORE_RUNTIME_GZIP_BUDGET_BYTES = 127_739

assertImportInspection()

interface BundleEvidence {
  readonly name: string
  readonly rawBytes: number
  readonly gzipBytes: number
  readonly files: readonly string[]
  readonly externalImports: readonly string[]
  readonly nodeBuiltinReferences: readonly string[]
  readonly workerdStartupMs: number
  readonly heap: HeapEvidence
  readonly result: Record<string, unknown>
}

interface HeapEvidence {
  readonly samples: number
  readonly before: InspectorHeapUsage
  readonly sampledPeak: InspectorHeapUsage
  readonly after: InspectorHeapUsage
  readonly sampledUsedDeltaBytes: number
}

interface PackageBaseline {
  readonly package: '@ai-agent-sdk/core'
  readonly files: readonly string[]
  readonly rawBytes: number
  readonly gzipBytes: number
  readonly perFileGzipBytes: number
  readonly gzipMethod: 'sorted-runtime-payload-concatenation'
}

await rm(artifactRoot, { recursive: true, force: true })
await mkdir(artifactRoot, { recursive: true, mode: 0o700 })

const contracts = await buildAndRun('contracts', 'contracts-worker.ts')
const basicAgent = await buildAndRun('basic-agent', 'basic-agent-worker.ts')
const packageBaseline = await currentPackageBaseline()
const reportPath = resolve(artifactRoot, 'report.json')
await writeBenchmarkReport(reportPath, contracts, basicAgent, packageBaseline)

assert(contracts.externalImports.length === 0, 'contract bundle retained external imports')
assert(basicAgent.externalImports.length === 0, 'basic-agent bundle retained external imports')
assert(contracts.nodeBuiltinReferences.length === 0, 'contract bundle references Node built-ins')
assert(basicAgent.nodeBuiltinReferences.length === 0, 'basic-agent bundle references Node built-ins')
assert(contracts.gzipBytes <= CONTRACT_BUNDLE_GZIP_BUDGET_BYTES,
  'contract Worker exceeded its gzip bundle budget')
assert(basicAgent.gzipBytes <= BASIC_AGENT_BUNDLE_GZIP_BUDGET_BYTES,
  'basic-agent Worker exceeded its gzip bundle budget')
assert(packageBaseline.gzipBytes <= CORE_RUNTIME_GZIP_BUDGET_BYTES,
  'packed core runtime exceeded its aggregate gzip budget')
assert(contracts.result.buffer === 'undefined' && contracts.result.process === 'undefined',
  `contract bundle observed Node globals in workerd: ${JSON.stringify(contracts.result)}`)
assert(basicAgent.result.buffer === 'undefined' && basicAgent.result.process === 'undefined',
  `basic-agent bundle observed Node globals in workerd: ${JSON.stringify(basicAgent.result)}`)
assert(basicAgent.result.calls === 64 && basicAgent.result.totalTokens === 384,
  'basic-agent workerd accounting is incorrect')
assert(basicAgent.result.diagnosticEvents === 32
  && typeof basicAgent.result.evictedEvents === 'number'
  && basicAgent.result.evictedEvents > 500,
'bounded diagnostics did not evict under workerd load')
assert(basicAgent.result.closeState === 'closed' && basicAgent.result.deadlineReached === false,
  'basic-agent workerd shutdown is incomplete')
assert(contracts.heap.samples > 0 && basicAgent.heap.samples > 0,
  'workerd inspector did not produce heap samples')
assert(contracts.heap.sampledPeak.usedSize >= contracts.heap.before.usedSize,
  'contract heap peak is lower than its baseline')
assert(basicAgent.heap.sampledPeak.usedSize >= basicAgent.heap.before.usedSize,
  'basic-agent heap peak is lower than its baseline')
assert(contracts.heap.sampledPeak.usedSize <= CONTRACT_HEAP_USED_BUDGET_BYTES,
  'contract Worker exceeded its sampled used-heap budget')
assert(basicAgent.heap.sampledPeak.usedSize <= BASIC_AGENT_HEAP_PEAK_BUDGET_BYTES,
  'basic-agent Worker exceeded its sampled peak-heap budget')
assert(basicAgent.heap.sampledUsedDeltaBytes <= BASIC_AGENT_HEAP_DELTA_BUDGET_BYTES,
  'basic-agent Worker exceeded its sampled heap-delta budget')

process.stdout.write(`${JSON.stringify({ ok: true, reportPath, contracts, basicAgent })}\n`)

async function writeBenchmarkReport(
  path: string,
  contracts: BundleEvidence,
  basicAgent: BundleEvidence,
  packageBaseline: PackageBaseline,
): Promise<void> {
  const checks = {
    contractBundle: contracts.gzipBytes <= CONTRACT_BUNDLE_GZIP_BUDGET_BYTES,
    basicAgentBundle: basicAgent.gzipBytes <= BASIC_AGENT_BUNDLE_GZIP_BUDGET_BYTES,
    coreRuntimeBundle: packageBaseline.gzipBytes <= CORE_RUNTIME_GZIP_BUDGET_BYTES,
    contractHeap: contracts.heap.sampledPeak.usedSize <= CONTRACT_HEAP_USED_BUDGET_BYTES,
    basicAgentHeapPeak: basicAgent.heap.sampledPeak.usedSize <= BASIC_AGENT_HEAP_PEAK_BUDGET_BYTES,
    basicAgentHeapDelta: basicAgent.heap.sampledUsedDeltaBytes <= BASIC_AGENT_HEAP_DELTA_BUDGET_BYTES,
    noExternalImports: contracts.externalImports.length === 0 && basicAgent.externalImports.length === 0,
    noNodeBuiltins: contracts.nodeBuiltinReferences.length === 0
      && basicAgent.nodeBuiltinReferences.length === 0,
  }
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    toolchain: { bundler: 'tsdown 0.22.14', runtime: 'workerd via wrangler 4.127.1' },
    packageBaseline,
    bundles: { contracts, basicAgent },
    checks,
    limitsProven: {
      strictWorkerExecution: true,
      diagnosticRetentionBound: 32,
      inspectorHeapSampling: true,
      heapSamplingYieldIntervalRuns: 4,
      heapBudgets: {
        contractUsedBytes: CONTRACT_HEAP_USED_BUDGET_BYTES,
        basicAgentPeakBytes: BASIC_AGENT_HEAP_PEAK_BUDGET_BYTES,
        basicAgentDeltaBytes: BASIC_AGENT_HEAP_DELTA_BUDGET_BYTES,
      },
      bundleBudgets: {
        contractGzipBytes: CONTRACT_BUNDLE_GZIP_BUDGET_BYTES,
        basicAgentGzipBytes: BASIC_AGENT_BUNDLE_GZIP_BUDGET_BYTES,
        coreRuntimeGzipBytes: CORE_RUNTIME_GZIP_BUDGET_BYTES,
      },
    },
    limitsNotProven: {
      allocationCompletePeak: 'DevTools sampling can miss allocations between samples; sampled peak is evidence, not a hard upper bound',
      postGcRetainedHeap: 'workerd did not answer the explicit DevTools GC command; after-request heap is not labelled retained heap',
    },
  }, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function buildAndRun(name: string, entry: string): Promise<BundleEvidence> {
  const output = resolve(artifactRoot, name)
  await mkdir(output, { recursive: true, mode: 0o700 })
  run('pnpm', [
    'exec', 'tsdown', resolve(benchmarkRoot, entry), '--no-config', '--format', 'esm',
    '--platform', 'neutral', '--target', 'es2022', '--minify', '--out-dir', output,
    '--clean', '--logLevel', 'warn',
  ], workspaceRoot)
  const emitted = (await readdir(output)).filter(file => file.endsWith('.js') || file.endsWith('.mjs'))
  if (emitted.length === 0) throw new Error(`${name} produced no JavaScript bundle`)
  const payloads = await Promise.all(emitted.map(async file => ({
    file,
    content: await readFile(resolve(output, file)),
  })))
  const sources = payloads.map(item => item.content.toString('utf8'))
  const externalImports = unique(sources.flatMap(importSpecifiers))
  const nodeBuiltinReferences = unique(externalImports.filter(specifier => specifier.startsWith('node:')))
  const main = emitted.find(file => basename(file).startsWith(entry.replace(/\.ts$/, '')))
    ?? emitted[0]
  if (main === undefined) throw new Error(`${name} has no main bundle`)
  const runtime = await runWorkerd(output, main)
  return {
    name,
    rawBytes: payloads.reduce((total, item) => total + item.content.byteLength, 0),
    gzipBytes: payloads.reduce((total, item) => total + gzipSync(item.content).byteLength, 0),
    files: Object.freeze(emitted.sort()),
    externalImports,
    nodeBuiltinReferences,
    workerdStartupMs: runtime.startupMs,
    heap: runtime.heap,
    result: runtime.result,
  }
}

async function runWorkerd(output: string, main: string): Promise<{
  readonly startupMs: number
  readonly heap: HeapEvidence
  readonly result: Record<string, unknown>
}> {
  const configPath = resolve(output, 'wrangler.jsonc')
  await writeFile(configPath, `${JSON.stringify({
    name: `core-capability-${basename(output)}`,
    main,
    compatibility_date: '2026-09-01',
  }, null, 2)}\n`, { mode: 0o600 })
  const port = await availablePort()
  let inspectorPort = await availablePort()
  while (inspectorPort === port) inspectorPort = await availablePort()
  const startedAt = performance.now()
  const child = spawn(wrangler, [
    'dev', '--config', configPath, '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
  ], { cwd: output, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout?.on('data', chunk => { logs = `${logs}${String(chunk)}`.slice(-16_384) })
  child.stderr?.on('data', chunk => { logs = `${logs}${String(chunk)}`.slice(-16_384) })
  let inspector: InspectorClient | undefined
  try {
    const inspectorUrl = await pollInspector(inspectorPort, child)
    inspector = await InspectorClient.connect(inspectorUrl)
    await inspector.command('Runtime.enable')
    const before = await inspector.heapUsage()
    const samples: InspectorHeapUsage[] = [before]
    let sampling = true
    let samplingFailure: unknown
    const samplingTask = (async (): Promise<void> => {
      try {
        while (sampling) {
          samples.push(await inspector?.heapUsage() ?? before)
          await new Promise(resolvePromise => setTimeout(resolvePromise, 1))
        }
      } catch (error) {
        if (sampling) samplingFailure = error
      }
    })()
    let result: Record<string, unknown>
    try {
      const response = await poll(`http://127.0.0.1:${port}`, child)
      result = await response.json() as Record<string, unknown>
    } finally {
      sampling = false
      await samplingTask
    }
    if (samplingFailure !== undefined) throw samplingFailure
    const after = await inspector.heapUsage()
    samples.push(after)
    const sampledPeak = samples.reduce((peak, sample) => (
      sample.usedSize > peak.usedSize ? sample : peak
    ))
    return {
      startupMs: Math.round(performance.now() - startedAt),
      heap: {
        samples: samples.length,
        before,
        sampledPeak,
        after,
        sampledUsedDeltaBytes: Math.max(0, sampledPeak.usedSize - before.usedSize),
      },
      result,
    }
  } catch (error) {
    throw new Error(`workerd fixture failed\n${logs}`, { cause: error })
  } finally {
    inspector?.close()
    await stop(child)
  }
}

async function pollInspector(port: number, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = await response.json() as Array<{ webSocketDebuggerUrl?: unknown }>
        const url = targets.find(target => typeof target.webSocketDebuggerUrl === 'string')
          ?.webSocketDebuggerUrl
        if (typeof url === 'string') return url
      }
    } catch { /* inspector is starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('workerd inspector did not become ready within 20 seconds')
}

async function currentPackageBaseline(): Promise<PackageBaseline> {
  const root = resolve(workspaceRoot, 'packages/core/dist')
  const files = await runtimeJavaScriptFiles(root)
  const payloads = await Promise.all(files.map(file => readFile(resolve(root, file))))
  return {
    package: '@ai-agent-sdk/core', files,
    rawBytes: payloads.reduce((total, content) => total + content.byteLength, 0),
    gzipBytes: gzipSync(Buffer.concat(payloads)).byteLength,
    perFileGzipBytes: payloads.reduce(
      (total, content) => total + gzipSync(content).byteLength,
      0,
    ),
    gzipMethod: 'sorted-runtime-payload-concatenation',
  }
}

async function runtimeJavaScriptFiles(root: string, directory = ''): Promise<readonly string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true })
  const files = await Promise.all(entries.map(async entry => {
    const relative = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory()) return runtimeJavaScriptFiles(root, relative)
    return entry.isFile() && entry.name.endsWith('.js') ? [relative] : []
  }))
  return Object.freeze(files.flat().sort())
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort())
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('could not allocate a port')
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  return address.port
}

async function poll(url: string, child: ChildProcess): Promise<Response> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return response
    } catch { /* workerd is starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('workerd did not become ready within 20 seconds')
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
