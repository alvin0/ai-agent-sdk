import { ModelAdapter, ReasoningEffortId, ToolCallId } from '../../packages/core/dist/index.js'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '../../packages/core/dist/index.js'
import type { Task } from './tasks.ts'

type Call = { name: string; args: object }
const call = (name: string, args: object): Call => ({ name, args })
const write = (path: string, content: unknown) => call('write_file', {
  path, content: typeof content === 'string' ? content : JSON.stringify(content),
})

export function solution(task: Task): Call[] {
  if (task.files && task.id === 'extraction') return [
    call('read_file', { path: 'SPEC.md' }),
    ...Object.keys(task.files).filter(path => path.endsWith('.csv')).map(path => call('read_file', { path })),
    write('answer.json', extractionAnswer(task.files)),
  ]
  if (task.files) {
    const outputs = task.repairs ?? (task.id === 'review'
      ? { 'findings.json': JSON.stringify({ findings: task.reviewCases }) }
      : { [task.id === 'shared-artifact' ? 'plan.json' : 'answer.json']: JSON.stringify(task.expected) })
    return [call('list_files', {}), ...Object.entries(outputs).map(([path, content]) => write(path, content)),
      ...(task.checks.length ? [call('shell', { command: 'test' })] : [])]
  }
  const solutions: Record<string, Call[]> = {
    extraction: [write('answer.json', { requests: 8652, errors: 46,
      serviceIds: ['east', 'west', 'north', 'south', 'central', 'edge']
        .flatMap(region => [0, 1, 2, 3].map(i => `${region}-${i}`)).sort() })],
    sequential: [write('answer.json', { trace: [56, 6, 23, 19], final: 19 })],
    'code-change': [
      write('src/names.cjs', 'exports.normalize = value => value.trim().toLowerCase().replace(/ +/g,"-");'),
      write('src/prices.cjs', 'exports.cents = value => Math.round(value*100);'), call('shell', { command: 'test' }),
    ],
    'bug-hunt': [write('src/cache.cjs', 'exports.createCache = () => { const entries=new Map(); return {'
      + 'put(k,v,ttl,now){entries.set(k,{v,until:now+ttl*1000})},'
      + 'get(k,now){const i=entries.get(k);return !i||now>=i.until?null:i.v}}};'), call('shell', { command: 'test' })],
    review: [write('findings.json', { findings: [
      { file: 'src/auth.cjs', rule: 'active-admin', example: { active: true, role: 'guest' } },
      { file: 'src/redirect.cjs', rule: 'exact-origin', example: 'https://evil.example/' },
    ] })],
    'shared-artifact': [write('plan.json', { steps: [
      { id: 'assets', after: [], owners: ['web'] }, { id: 'backup', after: [], owners: ['ops'] },
      { id: 'schema', after: ['backup'], owners: ['api', 'ops'] },
      { id: 'server', after: ['assets', 'schema'], owners: ['api'] },
      { id: 'client', after: ['server'], owners: ['web'] },
      { id: 'verify', after: ['client'], owners: ['ops'] },
    ] })],
  }
  return [call('list_files', {}), ...solutions[task.id]!]
}

/** Scripted protocol exercise only; its fixed answers and usage are never quality evidence. */
export class FakeAdapter extends ModelAdapter {
  private readonly steps = new Map<string, number>()
  private readonly task: Task
  constructor(task: Task) { super(); this.task = task }
  override async resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const id = ReasoningEffortId('medium')
    return { provider, id: model, name: model, reasoning: { efforts: [{ id, name: 'medium' }] } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const member = this.member(options)
    const step = this.steps.get(member) ?? 0
    this.steps.set(member, step + 1)
    const next = this.nextCall(member, step, options)
    if (next) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call',
        id: ToolCallId(`${member}-${step}`), name: next.name, arguments: JSON.stringify(next.args) } }
    } else {
      yield { type: 'text-delta', index: 0, text: 'Completed the requested workspace artifact.' }
      yield { type: 'block-end', index: 0,
        block: { type: 'text', text: 'Completed the requested workspace artifact.' } }
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: next ? 'tool-calls' : 'stop' } }
  }
  private nextCall(member: string, step: number, options: GenerateOptions): Call | undefined {
    const spawn = discoverTool(options, 'spawn'), wait = discoverTool(options, 'wait')
    if (member !== 'lead' || !spawn || this.task.id === 'sequential') return solution(this.task)[step]
    if (step === 0) return call(spawn.name, requiredArguments(spawn.parameters, this.task.prompt, 'helper'))
    if (step === 1 && wait) return call(wait.name,
      requiredArguments(wait.parameters, this.task.prompt, workerAddress(options)))
    return undefined
  }
  private member(options: GenerateOptions) {
    return /Bench session: ([\w-]+)/.exec(options.system ?? '')?.[1] ?? 'lead'
  }
}

/** Discover capabilities from the offered catalog; no branch-specific tool identifiers. */
export function discoverTool(options: Pick<GenerateOptions, 'tools'>, kind: 'spawn' | 'wait') {
  const tools = (options.tools ?? []).filter(tool => 'parameters' in tool)
  const name = kind === 'spawn' ? /spawn|delegate|create.*(?:agent|worker)/i : /wait|join|yield/i
  const description = kind === 'spawn' ? /(?:create|spawn|start|delegate).*(?:worker|agent|subtask)/i
    : /(?:wait|join).*(?:agent|worker|work|finish)/i
  return tools.find(tool => name.test(tool.name)) ?? tools.find(tool => description.test(tool.description))
}

export function requiredArguments(
  schema: Readonly<Record<string, unknown>>, task: string, address: string,
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const result: Record<string, unknown> = {}
  for (const key of (schema.required ?? []) as string[]) {
    const field = properties[key] ?? {}
    result[key] = schemaValue(field, key, task, address)
  }
  return result
}

function schemaValue(spec: Record<string, unknown>, key: string, task: string, address: string): unknown {
  if ('const' in spec) return spec.const
  if (Array.isArray(spec.enum)) return spec.enum[0]
  if (spec.type === 'array') return [schemaValue(spec.items as Record<string, unknown>, key, task, address)]
  if (spec.type === 'object') return requiredArguments(spec, task, address)
  if (['number', 'integer'].includes(String(spec.type))) return Math.max(Number(spec.minimum ?? 0), 1000)
  if (spec.type === 'boolean') return false
  return /task|message|prompt|input|instruction/i.test(key + ' ' + String(spec.description ?? '')) ? task : address
}

function addressInText(text: string): string | undefined {
  try {
    const result = JSON.parse(text) as Record<string, unknown>
    const worker = (result.worker ?? result) as Record<string, unknown>
    const address = worker.target ?? worker.name ?? worker.agent_id ?? worker.agentId ?? worker.id
    return typeof address === 'string' ? address : undefined
  } catch { return undefined }
}
function workerAddress(options: GenerateOptions): string {
  const results = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
  for (const result of results.reverse()) {
    for (const block of result.content) {
      if (block.type !== 'text') continue
      const address = addressInText(block.text)
      if (address) return address
    }
  }
  throw new Error('Fake adapter could not discover spawned worker address')
}

// Independent host-side CSV calculation for the scripted adapter only. No live scripting tool is exposed.
function extractionAnswer(files: Record<string, string>) {
  const result: Record<string, unknown> = {}, globalErrors: Record<string, number> = {}
  let globalRequests = 0
  for (const [path, text] of Object.entries(files).filter(([path]) => path.endsWith('.csv'))) {
    const latencies: Record<string, number[]> = {}, errors: Record<string, number> = {}
    for (const line of text.trim().split('\n').slice(1)) {
      const [, service, ms, code] = line.split(',') as [string, string, string, string, string]
      ;(latencies[service] ??= []).push(Number(ms))
      errors[code] = (errors[code] ?? 0) + 1
      globalErrors[code] = (globalErrors[code] ?? 0) + 1
      globalRequests++
    }
    result[path] = { p95: Object.fromEntries(Object.entries(latencies).map(([service, values]) => {
      values.sort((a, b) => a - b)
      return [service, values[Math.ceil(values.length * 0.95) - 1]]
    })), errors }
  }
  return { ...result, globalRequests, globalErrors }
}
