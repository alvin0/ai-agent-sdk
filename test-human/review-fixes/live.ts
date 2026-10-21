/**
 * Live Codex acceptance for the tool-error rendering, image retention, inject,
 * compaction and skill-catalog review fixes.
 *
 *   node --experimental-strip-types test-human/review-fixes/live.ts [--model gpt-6-luna] [--case <id>]
 *
 * Uses `.providers/.codex/auth.json`. Results go to test-human/results/review-fixes/<run>/.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { createAgentRuntime, createTextMessage, ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, UserMessage } from '@alvin0/ai-agent-sdk-core'
import {
  defineAgent, defineSkillProvider, defineTool, History, ToolError,
} from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentSessionOptions, SkillCandidate } from '@alvin0/ai-agent-sdk-core/agent'
import { codexNodeAdapter, codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}
const model = option('model') ?? 'gpt-6-luna'
const selectedCase = option('case')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const output = resolve(option('output') ?? `test-human/results/review-fixes/${runId}`)
await mkdir(output, { recursive: true })
const invoke = () => ({ signal: AbortSignal.timeout(300_000) })
const rows: Record<string, unknown>[] = []

// ---------------------------------------------------------------------------
// helpers

/** Solid-color RGB PNG, stored uncompressed so its byte size is predictable. */
function png(size: number, rgb: readonly [number, number, number]): string {
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

const COLORS = {
  red: [220, 20, 20], blue: [20, 40, 220], green: [20, 180, 40], yellow: [240, 220, 20],
} as const satisfies Record<string, readonly [number, number, number]>

function imageMessage(text: string, color: keyof typeof COLORS, size = 48): UserMessage {
  return { ...createTextMessage(text), content: [
    { type: 'text', text },
    { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: png(size, COLORS[color]) } },
  ] } as UserMessage
}

function countImages(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total: number, item) => total + countImages(item), 0)
  if (typeof value !== 'object' || value === null) return 0
  const block = value as { type?: unknown; content?: unknown; message?: unknown }
  if (block.type === 'image') return 1
  if (Array.isArray(block.content)) return countImages(block.content)
  return block.message === undefined ? 0 : countImages(block.message)
}

function toolResultTexts(request: GenerateOptions): string[] {
  return request.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'tool-result' ? block.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

function codexRegistry(): ModelRegistry {
  const registry = new ModelRegistry()
  registry.registerAdapter(['codex'], codexNodeAdapter())
  return registry
}

function recordRequests(requests: GenerateOptions[]): NonNullable<AgentSessionOptions['hooks']> {
  return { checkpoint(context) { if (context.kind === 'before-model-request') requests.push(context.request) } }
}

function agent(id: string, extra: Partial<Parameters<typeof defineAgent>[0]> = {}) {
  return defineAgent({
    id, provider: 'codex', model, effort: 'low', mode: 'basic', compaction: false, maxTurns: 6,
    instructions: 'Follow the user exactly. Keep replies minimal.', ...extra,
  })
}

function rejection(action: () => unknown): string {
  try { action(); return 'accepted' }
  catch (error: unknown) { return error instanceof Error ? error.message : String(error) }
}

async function runCase(id: string, action: () => Promise<Record<string, unknown>>): Promise<void> {
  if (selectedCase !== undefined && selectedCase !== id) return
  const started = performance.now()
  try {
    const evidence = await action()
    rows.push({ id, passed: true, elapsedMs: Math.round(performance.now() - started), ...evidence })
    console.log(JSON.stringify({ id, passed: true }))
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    rows.push({ id, passed: false, elapsedMs: Math.round(performance.now() - started), error: message })
    console.log(JSON.stringify({ id, passed: false, error: message }))
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ model, rows }, null, 2))
}

// ---------------------------------------------------------------------------
// cases

// Finding 2 (+ catch-path variant): rendered error text stays inside the result budget.
await runCase('error-code-rendered-and-bounded', async () => {
  const requests: GenerateOptions[] = []
  const tool = defineTool({
    name: 'fetch_report', description: 'Fetch the quarterly report.', parameters: { type: 'object' },
    execute: () => {
      throw ToolError.respondToModel(`report service failed: ${'trace-line '.repeat(20_000)}`, 'REPORT_UNAVAILABLE')
    },
  })
  const session = agent('error-bounded', { tools: [tool] }).createSession({
    registry: codexRegistry(), hooks: recordRequests(requests), runtimeLimits: { maxToolResultTokens: 200 },
  })
  const result = await session.run(
    'Call fetch_report exactly once with {}. Then reply with only the error code shown in brackets in the tool result.',
    invoke())
  const texts = requests.flatMap(toolResultTexts)
  assert.ok(texts.length > 0, 'the model must have seen a tool result')
  assert.ok(texts.every(text => text.startsWith('[REPORT_UNAVAILABLE] report service failed')), 'stable code rendering')
  const sizes = texts.map(text => text.length)
  assert.ok(sizes.every(size => size < 4_000), `tool result must be bounded, got ${sizes.join(',')}`)
  assert.match(result.text, /REPORT_UNAVAILABLE/)
  return { answer: result.text, toolResultChars: texts.map(text => text.length), modelRequests: requests.length }
})

// Finding 4: interceptor-authored feedback reaches the model as written.
await runCase('interceptor-feedback-preserved', async () => {
  const requests: GenerateOptions[] = []
  const feedback = [
    { type: 'text' as const, text: 'Deployment blocked by the change freeze.' },
    { type: 'text' as const, text: 'Reference ticket: FREEZE-4471' },
  ]
  const tool = defineTool({
    name: 'deploy', description: 'Deploy the service.', parameters: { type: 'object' }, execute: () => 'deployed',
  })
  const session = agent('feedback-preserved', { tools: [tool] }).createSession({
    registry: codexRegistry(), hooks: recordRequests(requests),
    interceptors: [{ name: 'freeze', after: () => Promise.resolve({ kind: 'block' as const, feedback }) }],
  })
  const result = await session.run(
    'Call deploy exactly once with {}. Then reply with only the reference ticket id from the tool result.', invoke())
  const texts = requests.flatMap(toolResultTexts)
  assert.deepEqual(texts, feedback.map(block => block.text), 'both feedback blocks, unrewritten')
  assert.match(result.text, /FREEZE-4471/)
  return { answer: result.text, toolResultTexts: texts }
})

// Finding 1: a non-detachable result still records a matching tool-result, so the next request is valid.
await runCase('undetachable-result-keeps-call-paired', async () => {
  const tool = defineTool({
    name: 'probe', description: 'Probe the host.', parameters: { type: 'object' }, execute: () => 'ok',
  })
  const session = agent('undetachable', { tools: [tool] }).createSession({
    registry: codexRegistry(),
    interceptors: [{ name: 'meta', after: () => Promise.resolve({
      kind: 'replace' as const, content: [{ type: 'text' as const, text: 'probe ok' }], meta: { size: 1n } as never,
    }) }],
  })
  let firstError: string | undefined
  try {
    const first = await session.run('Call probe exactly once with {}. Then reply DONE.', invoke())
    firstError = first.outcome.completed ? undefined : JSON.stringify(first.outcome)
  } catch (error: unknown) { firstError = error instanceof Error ? error.message : String(error) }
  assert.ok(firstError !== undefined, 'the fatal result must end the first run')
  const entries = session.snapshot().history.entries
  const callIdOf = (entry: (typeof entries)[number]) => (entry.event as { callId: string }).callId
  const calls = entries.filter(entry => entry.event.kind === 'tool-call').map(callIdOf)
  const results = entries.filter(entry => entry.event.kind === 'tool-result')
  assert.ok(calls.length > 0, 'the model called probe')
  assert.deepEqual(results.map(callIdOf), calls, 'every call has a tool-result')
  assert.ok(JSON.stringify(results).includes('INVALID_TOOL_RESULT'))
  const second = await session.run('Reply with only the word READY. Do not call tools.', invoke())
  assert.equal(second.outcome.completed, true)
  assert.match(second.text, /READY/)
  return { firstError, toolCalls: calls.length, followUp: second.text }
})

// Finding 8: one validator for both layers; custom renderer through the composed runtime.
await runCase('runtime-custom-renderer-and-validation', async () => {
  const runtime = await createAgentRuntime({ providers: [codexNodeProviderPlugin({ defaultModel: model })] })
  const requests: GenerateOptions[] = []
  const tool = defineTool({
    name: 'charge_card', description: 'Charge the saved card.', parameters: { type: 'object' },
    execute: () => { throw ToolError.respondToModel('gateway said: secret-merchant-key-993', 'PAYMENT_DECLINED') },
  })
  const runtimeAgent = runtime.agent({
    id: 'runtime-renderer', model: { provider: 'codex', id: model }, effort: 'low', compaction: false, maxTurns: 4,
    instructions: 'Follow the user exactly.', tools: [tool],
  })
  const errors = [
    rejection(() => runtimeAgent.createSession({ toolErrorRendering: 'loud' as never })),
    rejection(() => agent('invalid-renderer').createSession({
      registry: codexRegistry(), toolErrorRendering: 'loud' as never,
    })),
  ]
  assert.deepEqual(errors, Array(2).fill('toolErrorRendering must be false or a function'))
  const session = runtimeAgent.createSession({
    toolErrorRendering: ({ code }) => `Payment tool unavailable (${code}).`, hooks: recordRequests(requests),
  })
  const result = await session.run('Call charge_card exactly once with {}. '
    + 'Then reply with only the code inside the parentheses of the tool result.', invoke())
  const texts = requests.flatMap(toolResultTexts)
  assert.deepEqual([...new Set(texts)], ['Payment tool unavailable (PAYMENT_DECLINED).'])
  assert.ok(!requests.some(request => JSON.stringify(request.messages).includes('secret-merchant-key')))
  assert.match(result.text, /PAYMENT_DECLINED/)
  return { answer: result.text, validationErrors: errors }
})

// Findings 3, 9, 10: drop-pruned persistence, resume limits, and resumed recall.
await runCase('image-retention-drop-pruned-resume', async () => {
  const requests: GenerateOptions[] = []
  const definition = agent('drop-pruned')
  const retention = { keepLatest: 1, persist: 'drop-pruned' as const }
  const session = definition.createSession({
    registry: codexRegistry(), imageRetention: retention, hooks: recordRequests(requests),
  })
  const ask = 'What color is this square? Reply with one lowercase word.'
  const first = await session.run(imageMessage(ask, 'red'), invoke())
  const second = await session.run(imageMessage(ask, 'blue'), invoke())
  assert.match(first.text.toLowerCase(), /red/)
  assert.match(second.text.toLowerCase(), /blue/)
  assert.ok(requests.every(request => countImages(request.messages) <= 1), 'requests carry at most one image')
  const snapshot = JSON.parse(JSON.stringify(session.snapshot()))
  const storedEvents = snapshot.history.entries.map((entry: { event: unknown }) => entry.event)
  assert.equal(countImages(storedEvents), 1, 'snapshot keeps one image')
  const entryCount = snapshot.history.entries.length
  assert.throws(() => definition.resumeSession({ registry: codexRegistry(), snapshot, imageRetention: retention,
    historyLimits: { maxEntries: entryCount - 1 } }), new RegExp(`${entryCount - 1}-entry limit`))
  const resumed = definition.resumeSession({ registry: codexRegistry(), snapshot, imageRetention: retention })
  const recall = await resumed.run(
    'What color was the most recent square I showed you? Reply with one lowercase word.', invoke())
  assert.match(recall.text.toLowerCase(), /blue/)
  return {
    answers: [first.text, second.text, recall.text], entryCount,
    requestImages: requests.map(request => countImages(request.messages)),
  }
})

// Finding 7 (+ queued-buffer variant): images injected mid-round fit after live pruning.
await runCase('inject-images-mid-round', async () => {
  let injected = 0
  let injectError: string | undefined
  const requests: GenerateOptions[] = []
  const session = agent('inject-mid-round').createSession({
    registry: codexRegistry(),
    imageRetention: { keepLatest: 1, persist: 'drop-pruned' },
    historyLimits: { maxEntryBytes: 20_000, maxBytes: 26_000 },
    hooks: { checkpoint(context) {
      if (context.kind !== 'before-model-request') return
      requests.push(context.request)
      if (injected > 0) return
      injected = 2
      try {
        session.inject(imageMessage('First upload.', 'yellow', 56))
        session.inject(imageMessage(
          'Second upload. What color is this latest square? Reply with one lowercase word.', 'green', 56))
      } catch (error: unknown) { injectError = error instanceof Error ? error.message : String(error) }
    } },
  })
  const result = await session.run('Reply with only OK.', invoke())
  assert.equal(injectError, undefined, `inject must accept input the live history can hold: ${injectError}`)
  assert.equal(result.outcome.completed, true)
  const messages = session.snapshot().history.entries
    .flatMap(entry => entry.event.kind === 'user' ? [entry.event.message] : [])
  assert.ok(messages.some(message => JSON.stringify(message).includes('Second upload.')))
  assert.equal(countImages(messages), 1)
  assert.match(result.text.toLowerCase(), /green/)
  return {
    answer: result.text, modelRequests: requests.length,
    requestImages: requests.map(request => countImages(request.messages)),
  }
})

// Finding 6: compaction pressure counts only the images the model receives.
await runCase('compaction-measures-retained-images', async () => {
  const run = async (retained: boolean) => {
    const history = new History()
    for (let index = 0; index < 12; index++) {
      const color = index % 2 === 0 ? 'red' : 'blue'
      history.append({ kind: 'user', message: imageMessage(`Screen ${index + 1} of the onboarding flow.`, color) })
    }
    const requests: GenerateOptions[] = []
    const session = agent(`compaction-${retained ? 'retained' : 'control'}`, {
      compaction: { auto: true, maxInputTokens: 15_000, retainTokens: 2_000 },
    }).createSession({
      registry: codexRegistry(), history, hooks: recordRequests(requests),
      ...(retained ? { imageRetention: { keepLatest: 1 } } : {}),
    })
    const result = await session.run('How many onboarding screens were shared? Reply with a number only.', invoke())
    const compactions = session.snapshot().history.entries
      .filter(entry => entry.event.kind === 'compaction-start').length
    return { answer: result.text, compactions, requestImages: requests.map(request => countImages(request.messages)) }
  }
  const retained = await run(true)
  const control = await run(false)
  assert.equal(retained.compactions, 0, 'one retained image is far below the 15k-token threshold')
  assert.ok(control.compactions > 0, 'control: twelve stored images exceed the threshold')
  assert.ok(retained.requestImages.every(count => count <= 1))
  return { retained, control }
})

// Finding 5: the legacy candidate limit counts admitted skills, not list positions.
await runCase('legacy-skill-limit-counts-admitted', async () => {
  const providerId = 'legacy-live'
  const candidate = (id: string, name: string, description: string): SkillCandidate => ({
    id, name, description, source: 'live-fixture', provider: providerId,
    invocation: { modelInvocable: true, userInvocable: true },
  } as SkillCandidate)
  const candidates = [
    { ...candidate('Bad ID', 'Bad', 'Invalid id.') },
    { ...candidate('blocked-one', 'Blocked', 'Not allowed.') },
    { ...candidate('blocked-two', 'Blocked', 'Not allowed.') },
    candidate('release-notes', 'Release notes', 'Write release notes.'),
    candidate('incident-review', 'Incident review', 'Review an incident.'),
  ]
  const diagnostics: string[] = []
  const provider = defineSkillProvider({ kind: 'skill-provider', id: providerId,
    list: () => Promise.resolve(candidates),
    load: loaded => Promise.resolve({
      id: loaded.id, name: loaded.name, description: loaded.description, instructions: 'Fixture.',
    }) })
  const session = agent('legacy-skills', {
    skills: [provider], skillIds: ['release-notes', 'incident-review'], skillOptions: { maxSkills: 2 },
  }).createSession({
    registry: codexRegistry(), onSkillDiagnostic: diagnostic => { diagnostics.push(diagnostic.reason) },
  })
  const result = await session.run(
    'List the ids of every skill available to you, comma-separated, nothing else. Do not load any skill.', invoke())
  assert.match(result.text, /release-notes/)
  assert.match(result.text, /incident-review/)
  assert.ok(!diagnostics.includes('candidate-limit'), `unexpected candidate-limit: ${diagnostics.join(',')}`)
  return { answer: result.text, diagnostics }
})

const failed = rows.filter(row => row.passed !== true)
console.log(JSON.stringify({ output, passed: rows.length - failed.length, failed: failed.length }))
if (failed.length > 0) process.exitCode = 1
