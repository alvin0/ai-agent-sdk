import type { WireSpan } from '../server/traces'

export function duration(ms: number | null): string {
  if (ms === null) return '…'
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(2)}s`
}

export function tokens(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count)
}

export function kindLabel(kind: WireSpan['kind']): string {
  return kind === 'invoke_agent' ? 'agent' : kind === 'execute_tool' ? 'tool' : kind
}

export function memberColors(members: readonly string[]): ReadonlyMap<string, string> {
  const colors = ['#1677c8', '#8056c7', '#168b64', '#c46b1a', '#c24d70', '#8a7212']
  return new Map(members.map((member, index) => [member, colors[index % colors.length] as string]))
}

export function spanDetail(span: WireSpan): { name: string; detail: string } {
  const prefix = `${span.kind} `
  const name = span.name.startsWith(prefix) ? span.name.slice(prefix.length) : span.name
  if (span.kind === 'chat') {
    const effort = span.attributes?.['gen_ai.request.reasoning_effort']
    return { name, detail: typeof effort === 'string' ? effort : '' }
  }
  if (span.kind !== 'execute_tool') return { name, detail: '' }
  return { name, detail: typeof span.input === 'string' ? span.input : '' }
}
