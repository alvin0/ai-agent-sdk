/** Controlled public model-boundary audit; no live quality or token-cost claim. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const args = process.argv.slice(2)
const option = (name: string) => args[args.indexOf('--' + name) + 1]
if (!args.includes('--sdk-root') || !args.includes('--output')) throw new Error('--sdk-root and new --output required')
const root = resolve(option('sdk-root')!)
const output = resolve(option('output')!)
await mkdir(output)
const load = createRequire(resolve(root, 'package.json'))
const core = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-core')).href)
const agent = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-core/agent')).href)
const records: unknown[] = []
for (const policy of [false, 'reporting', 'full'] as const) {
  const requests: { system: string; tools: string[] }[] = []
  class Controlled extends core.ModelAdapter {
    async resolveModel(provider: string, id: string) {
      const effort = core.ReasoningEffortId('medium')
      return { provider, id, name: id, reasoning: { efforts: [{ id: effort, name: 'medium' }], defaultEffort: effort } }
    }
    async *stream(options: { system?: string; tools?: { name: string }[] }) {
      requests.push({ system: options.system ?? '', tools: (options.tools ?? []).map(t => t.name) })
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new core.ModelRegistry()
  registry.registerAdapter(['controlled'], new Controlled())
  const define = (id: string) => agent.defineAgent({ id, provider: 'controlled', model: 'probe', mode: 'basic', instructions: 'Follow the task requested by the host.' })
  const managed = agent.createManagedAgentTeam({ registry, lead: define('lead'), workerFactory: (request: { name: string }) => define(request.name), workerTeamTools: policy })
  try {
    await managed.spawn({ name: 'worker', task: 'Return a short plain-text answer.' })
    const result = await managed.awaitWorker('worker')
    const request = requests[0]!
    records.push({ policy, ...request, sdkToolNamesMentioned: ['list_agents', 'send_message', 'followup_task', 'wait_agents'].filter(name => request.system.includes(name)), succeeded: result?.succeeded })
  } finally { await managed.dispose(); await managed.team.dispose() }
}
await writeFile(resolve(output, 'results.json'), JSON.stringify({ sdkRoot: root, records, scope: 'Controlled adapter on the public session/model boundary. No live model behavior, latency or provider-token claim.' }, null, 2))
const source = await readFile(import.meta.filename)
await writeFile(resolve(output, 'source.ts'), source)
await writeFile(resolve(output, 'source.sha256'), createHash('sha256').update(source).digest('hex'))
console.log(JSON.stringify(records.map((record: any) => ({ policy: record.policy, tools: record.tools, sdkToolNamesMentioned: record.sdkToolNamesMentioned, succeeded: record.succeeded }))))
