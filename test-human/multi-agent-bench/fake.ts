import { ModelAdapter, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { Task } from './tasks.ts'

type Call = { name: string; args: object }
const call = (name: string, args: object): Call => ({ name, args })
const write = (path: string, content: unknown) => call('write_file', {
  path, content: typeof content === 'string' ? content : JSON.stringify(content),
})

function solution(task: Task): Call[] {
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
    const delegated = this.delegated(options)
    let next: Call | undefined
    if (delegated && step === 0) next = call('spawn_agent', { name: 'helper', task: this.task.prompt })
    if (delegated && step === 1) next = call('wait_agents', { targets: ['helper'], timeoutMs: 1000 })
    if (!delegated) next = solution(this.task)[step]
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
  private member(options: GenerateOptions) {
    return /Bench session: ([\w-]+)/.exec(options.system ?? '')?.[1] ?? 'lead'
  }
  private delegated(options: GenerateOptions) {
    return (options.tools ?? []).some(tool => tool.name === 'spawn_agent') && this.task.id !== 'sequential'
  }
}
