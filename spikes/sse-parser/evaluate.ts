import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createParser } from '../../packages/provider-http/node_modules/eventsource-parser/dist/index.js'
import {
  DEFAULT_MAX_EVENT_DATA,
  DEFAULT_MAX_PENDING_LINE,
  SseParserStateError,
  SseResourceLimitError,
  createOwnedSseParser,
} from './candidate.ts'
import { bytes, conformanceCases, differentialCorpus, emptyTrace } from './corpus.ts'
import type { Trace } from './corpus.ts'

const DIFFERENTIAL_PARTITIONS = 100_000
const FUZZ_SEEDS = 1_000_000
const DIFFERENTIAL_SEED = 0x5eed_2026
const FUZZ_SEED = 0xf022_2026

const startedAt = performance.now()
runConformance()
runResourceAndCancellationChecks()
const differential = runDifferential()
const fuzz = runFuzz()
const benchmark = runBenchmarks()

const report = {
  schemaVersion: 1,
  candidate: 'owned-sse-parser-spike',
  reference: 'eventsource-parser@4.1.0',
  standards: {
    html: 'https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream',
    encoding: 'https://encoding.spec.whatwg.org/#utf-8-decode',
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  conformance: {
    cases: conformanceCases.length,
    status: 'passed',
    semanticDifferences: [],
  },
  resources: {
    status: 'passed',
    defaults: {
      maxPendingLine: 256 * 1024,
      maxEventData: 1024 * 1024,
      maxTotalPending: 1024 * 1024,
    },
  },
  cancellation: { status: 'passed' },
  differential,
  fuzz,
  benchmark,
  elapsedMs: round(performance.now() - startedAt),
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

function runConformance(): void {
  for (const testCase of conformanceCases) {
    assert.deepEqual(runCandidate(testCase.chunks), testCase.expected, `candidate: ${testCase.name}`)
    assert.deepEqual(runReference(testCase.chunks), testCase.expected, `reference: ${testCase.name}`)
  }
}

function runResourceAndCancellationChecks(): void {
  const atLineLimit = createOwnedSseParser()
  atLineLimit.feed(bytes(`x${'a'.repeat(DEFAULT_MAX_PENDING_LINE - 1)}`))
  atLineLimit.feed(bytes('\n'))
  atLineLimit.finish()

  const lineOverflow = createOwnedSseParser()
  assert.throws(
    () => lineOverflow.feed(bytes(`x${'a'.repeat(DEFAULT_MAX_PENDING_LINE)}`)),
    (error) => isLimit(error, 'pending-line', DEFAULT_MAX_PENDING_LINE),
  )
  assert.throws(() => lineOverflow.feed(bytes('data: x\n\n')), SseParserStateError)

  const dataOverflow = createOwnedSseParser({ maxTotalPending: 2 * 1024 * 1024 })
  const dataBlock = `data: ${'a'.repeat(128 * 1024 - 1)}\n`
  for (let index = 0; index < 8; index++) dataOverflow.feed(bytes(dataBlock))
  assert.throws(
    () => dataOverflow.feed(bytes('data: x\n')),
    (error) => isLimit(error, 'event-data', DEFAULT_MAX_EVENT_DATA),
  )

  const totalOverflow = createOwnedSseParser({ maxEventData: 2 * 1024 * 1024 })
  for (let index = 0; index < 7; index++) totalOverflow.feed(bytes(dataBlock))
  assert.throws(
    () => totalOverflow.feed(bytes(dataBlock)),
    (error) => isLimit(error, 'total-pending', 1024 * 1024),
  )

  const cancelledEvents: string[] = []
  const cancelled = createOwnedSseParser({ onEvent: (event) => cancelledEvents.push(event.data) })
  cancelled.feed(bytes('data: secret'))
  cancelled.cancel()
  cancelled.cancel()
  assert.throws(() => cancelled.finish(), SseParserStateError)
  assert.deepEqual(cancelledEvents, [])
}

function runDifferential(): {
  status: 'passed'
  partitions: number
  seed: string
  corpusEntries: number
  semanticDifferences: []
  diagnosticDifferences: number
  diagnosticDifferenceExamples: Array<{ partition: number; candidate: Trace['errors']; reference: Trace['errors'] }>
  digest: string
} {
  const random = xorshift32(DIFFERENTIAL_SEED)
  let digest = 0x811c9dc5
  let diagnosticDifferences = 0
  const diagnosticDifferenceExamples: Array<{
    partition: number
    candidate: Trace['errors']
    reference: Trace['errors']
  }> = []
  for (let index = 0; index < DIFFERENTIAL_PARTITIONS; index++) {
    const input = differentialCorpus[index % differentialCorpus.length]!
    const chunks = partition(input, random)
    const candidate = runCandidate(chunks)
    const reference = runReference(chunks)
    assert.deepEqual(withoutDiagnostics(candidate), withoutDiagnostics(reference), `differential partition ${index}`)
    if (!deepEqual(candidate.errors, reference.errors)) {
      diagnosticDifferences++
      if (diagnosticDifferenceExamples.length < 3) {
        diagnosticDifferenceExamples.push({
          partition: index,
          candidate: candidate.errors,
          reference: reference.errors,
        })
      }
    }
    digest = hashString(digest, JSON.stringify(candidate))
  }
  return {
    status: 'passed',
    partitions: DIFFERENTIAL_PARTITIONS,
    seed: hex(DIFFERENTIAL_SEED),
    corpusEntries: differentialCorpus.length,
    semanticDifferences: [],
    diagnosticDifferences,
    diagnosticDifferenceExamples,
    digest: hex(digest),
  }
}

function runFuzz(): {
  status: 'passed'
  seeds: number
  seed: string
  maxInputBytes: number
  maxElapsedMs: number
  maxPeakRssBytes: number
  peakRssBytes: number
  elapsedMs: number
  digest: string
} {
  const maxElapsedMs = 30_000
  const maxPeakRssBytes = 512 * 1024 * 1024
  const started = performance.now()
  const random = xorshift32(FUZZ_SEED)
  let digest = 0x811c9dc5

  for (let seed = 0; seed < FUZZ_SEEDS; seed++) {
    const length = random() % 49
    const input = new Uint8Array(length)
    for (let index = 0; index < length; index++) input[index] = fuzzByte(random())

    let events = 0
    let comments = 0
    let errors = 0
    const parser = createOwnedSseParser({
      onEvent(event) {
        events++
        digest = hashString(digest, event.data)
      },
      onComment() {
        comments++
      },
      onError() {
        errors++
      },
    })

    let offset = 0
    while (offset < input.byteLength) {
      const width = 1 + (random() % 11)
      parser.feed(input.subarray(offset, Math.min(offset + width, input.byteLength)))
      offset += width
    }
    parser.finish()
    digest = Math.imul(digest ^ events ^ (comments << 8) ^ (errors << 16) ^ seed, 0x01000193)
  }

  const elapsedMs = performance.now() - started
  const peakRssBytes = process.resourceUsage().maxRSS * 1024
  assert.ok(elapsedMs <= maxElapsedMs, `fuzz exceeded ${maxElapsedMs}ms`)
  assert.ok(peakRssBytes <= maxPeakRssBytes, `fuzz exceeded ${maxPeakRssBytes} peak RSS bytes`)
  return {
    status: 'passed',
    seeds: FUZZ_SEEDS,
    seed: hex(FUZZ_SEED),
    maxInputBytes: 48,
    maxElapsedMs,
    maxPeakRssBytes,
    peakRssBytes,
    elapsedMs: round(elapsedMs),
    digest: hex(digest),
  }
}

function runBenchmarks(): {
  status: 'passed' | 'failed'
  allowedRegressionPercent: number
  throughputRegressionPercent: number
  scenarioThroughputRegressionPercent: Record<string, number>
  peakMemoryRegressionPercent: number
  candidate: BenchmarkResult
  reference: BenchmarkResult
} {
  const candidateSamples: BenchmarkResult[] = []
  const referenceSamples: BenchmarkResult[] = []
  for (let sample = 0; sample < 5; sample++) {
    referenceSamples.push(runBenchmarkWorker('reference'))
    candidateSamples.push(runBenchmarkWorker('candidate'))
  }
  const candidate = medianBenchmark(candidateSamples)
  const reference = medianBenchmark(referenceSamples)
  const scenarioThroughputRegressionPercent = Object.fromEntries(reference.scenarios.map((referenceScenario) => {
    const candidateScenario = candidate.scenarios.find((scenario) => scenario.name === referenceScenario.name)
    assert.ok(candidateScenario, `missing candidate benchmark scenario ${referenceScenario.name}`)
    return [referenceScenario.name, round(
      ((referenceScenario.throughputMiBPerSecond - candidateScenario.throughputMiBPerSecond)
        / referenceScenario.throughputMiBPerSecond) * 100,
    )]
  }))
  const throughputRegressionPercent = Math.max(...Object.values(scenarioThroughputRegressionPercent))
  const peakMemoryRegressionPercent = round(
    ((candidate.peakRssBytes - reference.peakRssBytes) / reference.peakRssBytes) * 100,
  )
  return {
    status: throughputRegressionPercent <= 20 && peakMemoryRegressionPercent <= 20 ? 'passed' : 'failed',
    allowedRegressionPercent: 20,
    throughputRegressionPercent,
    scenarioThroughputRegressionPercent,
    peakMemoryRegressionPercent,
    candidate,
    reference,
  }
}

function runCandidate(chunks: Uint8Array[]): Trace {
  const trace = emptyTrace()
  const parser = createOwnedSseParser({
    onEvent: (event) => trace.events.push(event),
    onComment: (comment) => trace.comments.push(comment),
    onId: (id) => trace.ids.push(id),
    onRetry: (retry) => trace.retries.push(retry),
    onError: (error) => trace.errors.push(error),
  })
  for (const chunk of chunks) parser.feed(chunk)
  parser.finish()
  return trace
}

function runReference(chunks: Uint8Array[]): Trace {
  const trace = emptyTrace()
  const parser = createParser({
    onEvent(event) {
      const normalized: Trace['events'][number] = { data: event.data }
      if (event.id !== undefined) normalized.id = event.id
      if (event.event !== undefined) normalized.event = event.event
      trace.events.push(normalized)
    },
    onComment: (comment) => trace.comments.push(comment),
    onId: (id) => trace.ids.push(id),
    onRetry: (retry) => trace.retries.push(retry),
    onError(error) {
      const normalized: Trace['errors'][number] = { type: error.type }
      if (error.field !== undefined) normalized.field = error.field
      if (error.value !== undefined) normalized.value = error.value
      if (error.line !== undefined) normalized.line = error.line
      trace.errors.push(normalized)
    },
  })
  const decoder = new TextDecoder()
  for (const chunk of chunks) parser.feed(decoder.decode(chunk, { stream: true }))
  const tail = decoder.decode()
  if (tail.length > 0) parser.feed(tail)
  return trace
}

function partition(input: Uint8Array, random: () => number): Uint8Array[] {
  if (input.byteLength === 0) return [input]
  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset < input.byteLength) {
    const width = 1 + (random() % 17)
    chunks.push(input.subarray(offset, Math.min(input.byteLength, offset + width)))
    offset += width
  }
  return chunks
}

function fuzzByte(value: number): number {
  const alphabet = [
    0x0a, 0x0d, 0x3a, 0x20, 0x64, 0x61, 0x74, 0x65, 0x69, 0x76, 0x6e, 0x72,
    0x79, 0x30, 0x39, 0x00, 0xef, 0xbb, 0xbf, 0xc0, 0xe2, 0xf0, 0x80, 0xff,
  ]
  return value % 5 === 0 ? value & 0xff : alphabet[value % alphabet.length]!
}

function xorshift32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    return value >>> 0
  }
}

function hashString(hash: number, value: string): number {
  let next = hash
  for (let index = 0; index < value.length; index++) {
    next = Math.imul(next ^ value.charCodeAt(index), 0x01000193)
  }
  return next >>> 0
}

function withoutDiagnostics(trace: Trace): Omit<Trace, 'errors'> {
  const { errors: _errors, ...semantic } = trace
  return semantic
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepEqual(left, right)
    return true
  } catch {
    return false
  }
}

function isLimit(error: unknown, resource: string, limit: number): boolean {
  return error instanceof SseResourceLimitError
    && error.resource === resource
    && error.limit === limit
}

interface BenchmarkResult {
  implementation: 'candidate' | 'reference'
  bytes: number
  events: number
  elapsedMs: number
  throughputMiBPerSecond: number
  peakRssBytes: number
  retainedHeapBytes: number
  scenarios: Array<{
    name: string
    bytes: number
    events: number
    elapsedMs: number
    throughputMiBPerSecond: number
  }>
}

function runBenchmarkWorker(implementation: BenchmarkResult['implementation']): BenchmarkResult {
  const worker = new URL('./benchmark-worker.ts', import.meta.url)
  const result = spawnSync(process.execPath, ['--expose-gc', worker.pathname, implementation], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`benchmark ${implementation} failed: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout) as BenchmarkResult
}

function medianBenchmark(samples: BenchmarkResult[]): BenchmarkResult {
  const first = samples[0]!
  return {
    implementation: first.implementation,
    bytes: median(samples.map((sample) => sample.bytes)),
    events: median(samples.map((sample) => sample.events)),
    elapsedMs: median(samples.map((sample) => sample.elapsedMs)),
    throughputMiBPerSecond: median(samples.map((sample) => sample.throughputMiBPerSecond)),
    peakRssBytes: median(samples.map((sample) => sample.peakRssBytes)),
    retainedHeapBytes: median(samples.map((sample) => sample.retainedHeapBytes)),
    scenarios: first.scenarios.map((scenario, index) => ({
      name: scenario.name,
      bytes: median(samples.map((sample) => sample.scenarios[index]!.bytes)),
      events: median(samples.map((sample) => sample.scenarios[index]!.events)),
      elapsedMs: median(samples.map((sample) => sample.scenarios[index]!.elapsedMs)),
      throughputMiBPerSecond: median(samples.map((sample) => sample.scenarios[index]!.throughputMiBPerSecond)),
    })),
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`
}
