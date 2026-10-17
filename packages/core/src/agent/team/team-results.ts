/** Exactly-once compact delivery per recipient and outcome instance. */
import type { AgentMemberOutcome, AgentTeamMember } from './types.ts'
import { truncate } from './managed-report-text.ts'

export function statusOnly(member: AgentTeamMember): Omit<AgentTeamMember, 'outcome'> {
  const { outcome: _outcome, ...metadata } = member
  return metadata
}

export class TeamResults {
  private readonly delivered = new Map<string, Map<string, AgentMemberOutcome>>()

  take(recipient: string, members: readonly AgentTeamMember[], maxBytes?: number) {
    const budget = maxBytes ?? Math.max(256,
      Math.min(8192, Math.floor(46 * 1024 / Math.max(1, members.length)) - 256))
    let delivered = this.delivered.get(recipient)
    if (delivered === undefined) this.delivered.set(recipient, delivered = new Map())
    return members.flatMap(member => {
      const outcome = member.outcome
      if (outcome === undefined || member.status === 'pending' || member.status === 'running'
        || delivered.get(member.name) === outcome) return []
      delivered.set(member.name, outcome)
      return [{ worker: member.name, status: outcome.status ?? outcome.kind,
        ...compactOutcome(outcome, budget) }]
    })
  }

  isDelivered(recipient: string, member: AgentTeamMember): boolean {
    return member.outcome !== undefined && this.delivered.get(recipient)?.get(member.name) === member.outcome
  }

  private readonly collectors = new Set<(members: readonly AgentTeamMember[]) => void>()

  /** An active join claims evidence synchronously at publication, before automatic notices. */
  capture(recipient: string, members: readonly AgentTeamMember[], targets: readonly string[], retained = true) {
    const captured: ReturnType<TeamResults['take']> = []
    const claims: { name: string; outcome: AgentMemberOutcome }[] = []
    const budget = Math.max(256, Math.min(8192, Math.floor(46 * 1024 / Math.max(1, targets.length)) - 256))
    const collect = (current: readonly AgentTeamMember[]) => {
      const selected = retained ? this.select(current, targets)
        : current.filter(member => targets.includes(member.name))
      const taken = this.take(recipient, selected, budget)
      captured.push(...taken)
      for (const result of taken) {
        const member = selected.find(member => member.name === result.worker)!
        claims.push({ name: member.name, outcome: member.outcome! })
      }
    }
    collect(members)
    this.collectors.add(collect)
    return {
      take: () => { claims.length = 0; return captured.splice(0) },
      release: () => {
        const delivered = this.delivered.get(recipient)
        for (const { name, outcome } of claims) {
          if (delivered?.get(name) === outcome) delivered.delete(name)
        }
        claims.length = 0
        captured.length = 0
      },
      close: () => { this.collectors.delete(collect) },
    }
  }

  publish(members: readonly AgentTeamMember[]): void {
    for (const collect of this.collectors) collect(members)
  }

  private readonly archived = new Map<string, AgentTeamMember>()

  archive(member: AgentTeamMember): void { this.archived.set(member.name, { ...member, status: 'idle' }) }
  forget(name: string): void { this.archived.delete(name) }
  retained(name: string): AgentTeamMember | undefined { return this.archived.get(name) }
  select(members: readonly AgentTeamMember[], targets: readonly string[]): readonly AgentTeamMember[] {
    return targets.flatMap(name => {
      const member = members.find(candidate => candidate.name === name) ?? this.archived.get(name)
      return member === undefined ? [] : [member]
    })
  }
  clear(): void { this.delivered.clear(); this.archived.clear(); this.collectors.clear() }
}

/** Shared compact result shape for lean waits and batch joins on either model surface. */
export function modelResults(results: ReturnType<TeamResults['take']>) {
  return results.map(({ worker, status, text, error, ...fields }) => ({ target: worker, status, ...fields,
    ...(status === 'completed' ? { result: text } : { partial_result: text, error: error ?? status }),
  }))
}

/** Bound serialized fields together, including JSON escaping overhead. */
function compactOutcome(outcome: AgentMemberOutcome, maxBytes: number) {
  let budget = Math.min(6144, Math.max(4, maxBytes - 32))
  for (;;) {
    const fields = { text: truncate(outcome.text ?? '', budget),
      ...(outcome.kind === 'failed' ? { error: truncate(outcome.message, budget) } : {}),
      ...(outcome.structured === undefined ? {} : compactStructured(outcome.structured, budget)) }
    if (new TextEncoder().encode(JSON.stringify(fields)).byteLength <= maxBytes || budget <= 4) return fields
    budget = Math.max(4, Math.floor(budget * 0.75))
  }
}

function compactStructured(value: Exclude<AgentMemberOutcome['structured'], undefined>, maxBytes: number) {
  const serialized = JSON.stringify(value)
  return new TextEncoder().encode(serialized).byteLength <= maxBytes
    ? { structured: value } : { structuredTruncated: true, structuredPreview: truncate(serialized, maxBytes) }
}
