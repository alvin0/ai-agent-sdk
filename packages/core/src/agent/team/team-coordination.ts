import { AgentSdkError } from '../../errors/index.ts'

type CoordinationHost = {
  waitEdges: Map<string, Map<string, number>>
  requireAddress: (name: string) => unknown
}

export function beginWait(host: CoordinationHost, sender: string, targets: readonly string[]): () => void {
  for (const target of targets) {
    host.requireAddress(target)
    if (target === sender || hasWaitPath(host.waitEdges, target, sender, new Set())) {
      throw new AgentSdkError('wait_agents would create a coordination cycle', 'TEAM_WAIT_CYCLE')
    }
  }
  const outgoing = host.waitEdges.get(sender) ?? new Map<string, number>()
  host.waitEdges.set(sender, outgoing)
  for (const target of targets) outgoing.set(target, (outgoing.get(target) ?? 0) + 1)
  let active = true
  return () => {
    if (!active) return
    active = false
    const edges = host.waitEdges.get(sender)
    if (edges === undefined) return
    for (const target of targets) {
      const count = edges.get(target) ?? 0
      if (count <= 1) edges.delete(target); else edges.set(target, count - 1)
    }
    if (edges.size === 0) host.waitEdges.delete(sender)
  }
}

function hasWaitPath(
  edges: Map<string, Map<string, number>>, from: string, target: string, visited: Set<string>,
): boolean {
  if (from === target) return true
  if (visited.has(from)) return false
  visited.add(from)
  for (const next of edges.get(from)?.keys() ?? []) {
    if (hasWaitPath(edges, next, target, visited)) return true
  }
  return false
}
