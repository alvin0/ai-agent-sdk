import { performance } from 'node:perf_hooks'

type Implementation = 'candidate' | 'reference'

const implementation = process.argv[2] as Implementation
if (implementation !== 'candidate' && implementation !== 'reference') {
  throw new Error('Expected benchmark implementation: candidate or reference')
}

const encoder = new TextEncoder()
const scenarios = [
  {
    name: 'single-line-json',
    stream: encoder.encode('data: {"type":"delta","delta":"representative UTF-8 💡"}\n\n'.repeat(5_000)),
  },
  {
    name: 'mixed-fields-and-comments',
    stream: encoder.encode([
      ': heartbeat\n',
      'event: response.output_text.delta\n',
      'id: request-42\n',
      'data: {"type":"response.output_text.delta","delta":"A representative UTF-8 payload 💡"}\n',
      'data: {"usage":{"input_tokens":128,"output_tokens":32,"total_tokens":160}}\n',
      '\n',
    ].join('').repeat(2_000)),
  },
  {
    name: 'large-multiline-data',
    stream: encoder.encode(`data: ${'x'.repeat(8 * 1024)}\ndata: ${'y'.repeat(8 * 1024)}\n\n`.repeat(32)),
  },
]
const chunkSize = 16 * 1024
const iterations = 80

const createRunner = implementation === 'candidate'
  ? await candidateRunner()
  : await referenceRunner()

for (let index = 0; index < 3; index++) {
  for (const scenario of scenarios) createRunner(scenario.stream, chunkSize)
}
globalThis.gc?.()
const before = process.memoryUsage()
const results: Array<{
  name: string
  bytes: number
  events: number
  elapsedMs: number
  throughputMiBPerSecond: number
}> = []
for (const scenario of scenarios) {
  const started = performance.now()
  let events = 0
  for (let index = 0; index < iterations; index++) events += createRunner(scenario.stream, chunkSize)
  const elapsedMs = performance.now() - started
  results.push({
    name: scenario.name,
    bytes: scenario.stream.byteLength * iterations,
    events,
    elapsedMs: round(elapsedMs),
    throughputMiBPerSecond: round((scenario.stream.byteLength * iterations / 1024 / 1024) / (elapsedMs / 1000)),
  })
}
globalThis.gc?.()
const after = process.memoryUsage()
const bytesProcessed = results.reduce((total, result) => total + result.bytes, 0)
const eventsProcessed = results.reduce((total, result) => total + result.events, 0)
const elapsedMs = results.reduce((total, result) => total + result.elapsedMs, 0)

process.stdout.write(JSON.stringify({
  implementation,
  bytes: bytesProcessed,
  events: eventsProcessed,
  elapsedMs: round(elapsedMs),
  throughputMiBPerSecond: round((bytesProcessed / 1024 / 1024) / (elapsedMs / 1000)),
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  retainedHeapBytes: Math.max(0, after.heapUsed - before.heapUsed),
  scenarios: results,
}))

async function candidateRunner(): Promise<(input: Uint8Array, width: number) => number> {
  const { createOwnedSseParser } = await import('./candidate.ts')
  return (input, width) => {
    let events = 0
    const parser = createOwnedSseParser({ onEvent: () => events++ })
    for (let offset = 0; offset < input.byteLength; offset += width) {
      parser.feed(input.subarray(offset, Math.min(input.byteLength, offset + width)))
    }
    parser.finish()
    return events
  }
}

async function referenceRunner(): Promise<(input: Uint8Array, width: number) => number> {
  const { createParser } = await import('../../packages/provider-http/node_modules/eventsource-parser/dist/index.js')
  return (input, width) => {
    let events = 0
    const parser = createParser({ onEvent: () => events++ })
    const decoder = new TextDecoder()
    for (let offset = 0; offset < input.byteLength; offset += width) {
      parser.feed(decoder.decode(input.subarray(offset, Math.min(input.byteLength, offset + width)), { stream: true }))
    }
    const tail = decoder.decode()
    if (tail.length > 0) parser.feed(tail)
    return events
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
