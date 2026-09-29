/** Real-model regression: deep verification preserves requested formats and later tasks. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { codexNodeAdapter } from '@alvin0/ai-agent-sdk-auth-node/codex'

const at = process.argv.indexOf('--output')
if (at < 0 || process.argv[at + 1] === undefined) throw new Error('--output required')
const output = resolve(process.argv[at + 1]!)
await mkdir(output, { recursive: false })
const model = 'gpt-6-luna'
const registry = new ModelRegistry()
const remove = registry.registerAdapter(['codex'], codexNodeAdapter())
const requests: { readonly sequence: number; readonly model: string; readonly text: string }[] = []
const rows: Record<string, unknown>[] = []
const session = defineAgent({
  id: 'deep-format-live', provider: 'codex', model, effort: 'low', mode: 'deep',
  instructions: 'Complete each user request accurately. Follow the requested response format.',
  tools: [], compaction: false, maxTurns: 6,
}).createSession({ registry, hooks: { checkpoint(context) {
  if (context.kind === 'before-model-request') requests.push({ sequence: requests.length + 1,
    model: context.request.model, text: JSON.stringify(context.request.messages) })
} } })

try {
  for (const [id, prompt, verify] of [
    ['json', 'Return only the JSON object {"answer":37}, without Markdown fences.', (text: string) => assert.deepEqual(JSON.parse(text), { answer: 37 })],
    ['number', 'Reply only with the number 83.', (text: string) => assert.equal(text.trim(), '83')],
    ['exact-text', 'Reply exactly FORMAT_OK.', (text: string) => assert.equal(text.trim(), 'FORMAT_OK')],
  ] as const) {
    const started = performance.now(), requestStart = requests.length
    try {
      const response = await session.run(prompt, { signal: AbortSignal.timeout(180_000) })
      assert.equal(response.outcome.completed, true)
      assert.ok(response.outcome.completion, 'Deep mode must retain its accepted self-check')
      verify(response.text)
      rows.push({ id, passed: true, elapsedMs: Math.round(performance.now() - started),
        modelRequests: requests.length - requestStart, text: response.text,
        completion: response.outcome.completion, usage: response.report.usage })
    } catch (error) {
      rows.push({ id, passed: false, elapsedMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : 'unknown error' })
    }
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ model, rows }, null, 2))
    console.log(JSON.stringify({ id, passed: rows.at(-1)!.passed }))
  }
  const snapshot = session.snapshot()
  assert.ok(JSON.stringify(snapshot).includes('Return only the JSON object'), 'Original request must remain in raw state')
  await writeFile(resolve(output, 'request-trace.json'), JSON.stringify(requests, null, 2))
  assert.ok(requests.length > 0 && requests.every(request => request.model === model), 'Every provider request must use gpt-6-luna')
  assert.ok(rows.length === 3 && rows.every(row => row.passed), 'Inspect retained format failures')
} finally { remove() }
