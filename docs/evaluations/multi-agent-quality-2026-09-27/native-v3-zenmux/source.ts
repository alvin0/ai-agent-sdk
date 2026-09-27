/** Separate acceptance smoke: real lead chooses native team tools. Not a paired benchmark. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type * as Core from '@alvin0/ai-agent-sdk-core'
import type * as Agent from '@alvin0/ai-agent-sdk-core/agent'
const args = process.argv.slice(2)
const option = (key: string) => { const at = args.indexOf(`--${key}`); return at < 0 ? undefined : args[at + 1] }
if (!option('sdk-root') || !option('output')) throw new Error('--sdk-root and new --output required')
const load = createRequire(resolve(option('sdk-root')!, 'package.json'))
const core = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-core')).href) as typeof Core
const agent = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-core/agent')).href) as typeof Agent
const codex = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-auth-node/codex')).href) as typeof import('@alvin0/ai-agent-sdk-auth-node/codex')
const openai = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-provider-openai')).href) as typeof import('@alvin0/ai-agent-sdk-provider-openai')
const auth = await import(pathToFileURL(load.resolve('@alvin0/ai-agent-sdk-auth-node')).href) as typeof import('@alvin0/ai-agent-sdk-auth-node')
const output = resolve(option('output')!); await mkdir(output)
const requestedProvider = option('provider')
if (requestedProvider && !['codex', 'zenmux'].includes(requestedProvider)) throw new Error('Unsupported smoke provider')
for (const model of [{ provider: 'codex', id: 'gpt-6-luna', effort: 'medium' }, { provider: 'zenmux', id: 'dots-studio/dots3-note-prev', effort: null }].filter(model => !requestedProvider || model.provider === requestedProvider)) {
  const registry = new core.ModelRegistry()
  registry.registerAdapter([model.provider], model.provider === 'codex' ? codex.codexNodeAdapter({ requestTimeoutMs: 120000 })
    : openai.openAiAdapter({ apiKey: auth.envCredential('COMPLETIONS_API_KEY'), api: 'chat-completions', baseUrl: (process.env.COMPLETIONS_URL ?? '').replace(/\/chat\/completions\/?$/, ''), models: [{ id: model.id }], requestTimeoutMs: 120000 }))
  const commissioned: { name: string; dependsOn: readonly string[]; conversationId: string }[] = []
  const conversations = new WeakMap<object, string>()
  let sequence = 0
  const calls: { member: string; tool: string }[] = [], terminals: { member: string; conversationId: string | undefined; data: Core.ObservationEvent['data'] }[] = []
  const sessionOptions = (member: string): Partial<Agent.AgentSessionOptions> => ({ runtimeLimits: { maxTotalTokens: 30000 }, spillStore: agent.createMemorySpillStore(), compaction: false,
    observation: { mode: 'operational', openSpan: core.createCoreSpan, capture(event) { if (event.name === 'sdk.agent.run' && event.phase === 'end') terminals.push({ member, conversationId: event.correlation.conversationId, data: event.data }); return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' } } },
    hooks: { checkpoint(context) { if (context.kind === 'before-tool-dispatch') calls.push({ member, tool: context.call.toolName }) } },
  })
  const definition = (id: string, tools: Core.ToolDefinition[] = []) => agent.defineAgent({ id, provider: model.provider, model: model.id,
    ...(model.effort ? { effort: core.ReasoningEffortId(model.effort) } : {}), mode: 'basic', maxTurns: 12, maxToolCalls: 24,
    instructions: 'Follow the assigned workflow and use evidence, not guesses. Return only the requested JSON. Workers must finish their assigned task and report; the lead synthesizes. No state-changing tools or writes are authorized.', tools })
  const facts = { source_a: { sourceId: 'native-a', observed: 155, baseline: 100 }, source_b: { sourceId: 'native-b', observed: 95, baseline: 100 } }
  const team = agent.createManagedAgentTeam({ registry, lead: definition('lead'), maxWorkers: 3, workerTimeoutMs: 90000, holdWaitMs: 1000,
    leadSessionOptions: sessionOptions('lead'), workerSessionOptionsFactory: request => ({ ...sessionOptions(request.name), conversationId: conversations.get(request)! }),
    workerFactory: request => { const conversationId = `native-${model.provider}-${++sequence}`; conversations.set(request, conversationId); commissioned.push({ name: request.name, dependsOn: request.dependsOn, conversationId }); return definition(request.name, request.name in facts ? [core.defineTool({ name: 'read_measurement', description: 'Read this producer own original measurement.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => facts[request.name as keyof typeof facts], isConcurrencySafe: () => true })] : []) },
  })
  const signal = AbortSignal.timeout(180000)
  let text = '', errorType: string | undefined
  try {
    const response = await team.run('Execute this required team workflow. Spawn source_a and source_b to independently call their read_measurement tool and report its exact sourceId, observed and baseline. Both are read-only: omit writes. Then spawn consumer with dependsOn [source_a,source_b] to combine their actual returned measurements. Require the consumer to return JSON {status,totalObserved,totalBaseline,changePercent,sourceIds}, with exact evidence IDs and status completed only with both sources. Read its final result and return that JSON as the final answer. Do not guess or generate measurements yourself, and do not use send_message to yourself.', { signal })
    text = response.text
    await team.whenQuiet(signal)
  } catch (error) { errorType = error instanceof Error ? error.name : 'unknown' }
  const workers = team.workers()
  let parsed: Record<string, unknown> | undefined
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) as Record<string, unknown> } catch { /* retain raw format failures */ }
  const identity = Array.isArray(parsed?.sourceIds) && [...parsed.sourceIds].sort().join('|') === 'native-a|native-b'
  const correct = parsed?.status === 'completed' && parsed.totalObserved === 250 && parsed.totalBaseline === 200 && parsed.changePercent === 25 && identity
  const checks = { finalAnswer: correct, nativeSpawn: calls.filter(c => c.member === 'lead' && c.tool === 'spawn_agent').length >= 3,
    bothActualMeasurements: ['source_a','source_b'].every(member => calls.some(c => c.member === member && c.tool === 'read_measurement')),
    dependencyConsumer: commissioned.some(w => w.name === 'consumer' && w.dependsOn.includes('source_a') && w.dependsOn.includes('source_b') && terminals.some(t => t.member === 'consumer' && t.conversationId === w.conversationId && t.data.completed === true && t.data.status === 'success')) }
  await team.dispose(); await team.team.dispose()
  await writeFile(resolve(output, model.provider + '.json'), JSON.stringify({ model, checks, text, ...(errorType ? { errorType } : {}), calls, terminals, commissioned, workers, scope: 'candidate-only public native-tool acceptance, per-session limits; no comparison or shared workflow-budget claim' }, null, 2))
  console.log(JSON.stringify({ provider: model.provider, checks, errorType }))
}
