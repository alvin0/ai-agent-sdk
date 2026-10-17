/** Benchmark policy: an early lead finish is an SDK finding, not a harness exception. */
export interface CompletionTeam {
  workers(): readonly { name: string; status: string }[]
  team: { members(): readonly { name: string; status: string }[] }
  whenQuiet(signal?: AbortSignal): Promise<void>
}
export function outstandingWorkers(team: CompletionTeam): number {
  return new Set([...team.workers(), ...team.team.members()]
    .filter(worker => worker.name !== 'lead' && ['running', 'pending'].includes(worker.status))
    .map(worker => worker.name)).size
}
export async function settleCompletion(team: CompletionTeam,
  outcome: { completed: boolean; reason: { kind: string } }, signal: AbortSignal, graceMs: number) {
  if (!outcome.completed && outcome.reason.kind !== 'completed') {
    throw new Error(`Lead incomplete: ${JSON.stringify(outcome.reason)}`)
  }
  const orphanWorkers = outstandingWorkers(team)
  const orphaned = orphanWorkers > 0 || !outcome.completed
  const grace = new AbortController()
  const timer = orphaned ? setTimeout(() => grace.abort(new Error('Orphan settlement grace expired')), graceMs)
    : undefined
  try { await team.whenQuiet(AbortSignal.any([signal, grace.signal])) }
  catch (error) {
    if (signal.aborted || !grace.signal.aborted) throw error
  } finally { clearTimeout(timer) }
  return { status: orphaned ? 'completed-orphans' as const : 'completed' as const,
    orphanWorkers, orphanWorkersAfterGrace: outstandingWorkers(team) }
}
