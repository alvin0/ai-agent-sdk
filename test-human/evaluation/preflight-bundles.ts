/** No remote model: prove common fixtures pass raw admission and spill in each isolated SDK. */
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { evaluationCasesV2 } from './cohort-v2.ts'
import { BUNDLE_LIMITS, fixtureSizeAudit } from './bundle-protocol.ts'

const preparation = resolve(process.argv[2] ?? 'artifacts/plan-completion-hHIqY2')
const tests = evaluationCasesV2()
const audit = fixtureSizeAudit(tests)
const results: unknown[] = []
for (const name of ['baseline-sdk', 'candidate-sdk']) {
  const load = createRequire(resolve(preparation, name, 'package.json'))
  const core = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-core')).href) as typeof import('@alvin0/ai-agent-sdk-core')
  const api = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-core/agent')).href) as typeof import('@alvin0/ai-agent-sdk-core/agent')
  const plugins = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-core/provider')).href) as typeof import('@alvin0/ai-agent-sdk-core/provider')
  const requests: GenerateOptions[] = []
  let round = 0
  class FixtureModel extends core.ModelAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 64000 } } }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(request)
      const tool = ['list_records', 'read_resource'][round++]
      if (tool) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: core.ToolCallId(`fixture-${round}`), name: tool, arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const runtime = await core.createAgentRuntime({ providers: [plugins.defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'Frozen fixture admission', setup(registrar) { registrar.registerAdapter(new FixtureModel()) } })] })
  try {
    const items = tests.find(test => test.variantId === 'DATA-04:en')!.collections.items!
    const documents = tests.find(test => test.variantId === 'DOC-04:en')!.resources.documents!
    const agent = runtime.agent({ id: 'fixture-admission', model: { provider: 'fixture', id: 'scripted' }, instructions: 'Read fixture data.', compaction: false, tools: [
      core.defineTool({ name: 'list_records', description: 'Frozen page', parameters: { type: 'object' }, execute: () => ({ records: items.slice(0, 40), nextOffset: 40, total: items.length }) }),
      core.defineTool({ name: 'read_resource', description: 'Frozen documents', parameters: { type: 'object' }, execute: () => documents }),
    ] })
    const session = agent.createSession({ spillStore: api.createMemorySpillStore(), runtimeLimits: { maxToolResultBytes: BUNDLE_LIMITS.maxToolResultBytes, maxToolResultTokens: BUNDLE_LIMITS.maxToolResultTokens } })
    const response = await session.run('Read both large fixtures.', { signal: AbortSignal.timeout(10000) })
    const history = JSON.stringify(session.snapshot().history)
    const passed = response.report.status === 'success' && response.report.operationCounts.tool.success === 2
      && response.report.operationCounts.tool.error === 0 && history.includes('read_tool_output')
      && requests.some(request => JSON.stringify(request).includes('read_tool_output'))
    results.push({ sdk: name, passed, toolCounts: response.report.operationCounts.tool, spillRetrievalAvailable: history.includes('read_tool_output') })
    if (!passed) throw new Error(`Frozen fixture admission failed on ${name}`)
  } finally { await runtime.close() }
}
await readFile(resolve(preparation, 'preparation.json'))
await writeFile(resolve(preparation, 'fixture-admission-preflight.json'), JSON.stringify({ audit, results }, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ audit, results }))
