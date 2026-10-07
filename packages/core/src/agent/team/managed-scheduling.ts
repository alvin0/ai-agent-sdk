/** Schedules dependencies while retaining write claims for unfinished follow-ups. */
import type { AgentTeam } from './team.ts'
import type { ManagedAgentTeamOptions, ResolvedManagedAgentSpawnRequest, WorkerRuntime } from './managed-types.ts'
import { memberName, scopesOverlap, SETTLED_WORKER_STATUS } from './managed-support.ts'

interface ManagedSchedulingHost {
  readonly options: ManagedAgentTeamOptions
  readonly team: AgentTeam
  readonly signal: AbortSignal
  readonly workers: ReadonlyMap<string, WorkerRuntime>
  preparing(): Iterable<{ readonly request: ResolvedManagedAgentSpawnRequest }>
  startWorker(runtime: WorkerRuntime): Promise<void>
}

export class ManagedWorkerScheduling {
  /** Closed roster entries may still own an in-flight follow-up after a bounded close. */
  private readonly drainingWrites = new Set<WorkerRuntime>()

  constructor(private readonly host: ManagedSchedulingHost) {}

  retainWrites(runtime: WorkerRuntime): void { this.drainingWrites.add(runtime) }

  releaseWrites(runtime: WorkerRuntime): void { this.drainingWrites.delete(runtime) }

  /**
   * Check the named dependencies and return them deduplicated.
   *
   * A dependency can only name a worker that already exists, and a new worker
   * is not yet nameable by anything, so the graph cannot contain a cycle by
   * construction — no cycle check is needed here, and a `dependsOn` that could
   * name a future worker would need one.
   */
  resolveDependencies(names: readonly string[]): readonly string[] {
    return [...new Set(names.map((name) => {
      const address = memberName(name)
      if (!this.host.workers.has(address)) {
        throw new Error(
          `unknown dependency '${address}'; a worker can only depend on one that already exists`,
        )
      }
      return address
    }))]
  }

  /**
   * Judge a new worker's write scopes against the ones already in flight.
   *
   * Only workers that could run AT THE SAME TIME conflict. One that this
   * worker depends on, directly or through others, writes its files before
   * this one begins, so sharing a scope with it is ordinary sequential work —
   * and is in fact the fix the refusal points at.
   * @param request - The resolved spawn request.
   * @returns Warnings to record; throws instead under the `reject` policy.
   */
  checkWriteScopes(request: ResolvedManagedAgentSpawnRequest,
    dependencies: readonly WorkerRuntime[]): readonly string[] {
    const policy = this.host.options.writeScopePolicy ?? 'reject'
    if (policy === 'off' || request.writes.length === 0) return []
    const ancestors = this.ancestorsOf(dependencies)
    const found: string[] = []
    const runningRoster = new Set(this.host.team.members().filter(member => member.status === 'running')
      .map(member => member.conversationId))
    const others = [
      ...[...this.host.workers.values()].filter(other => other.status === 'pending' || other.status === 'running'
        || this.workerHasWork(other, runningRoster))
        .filter(other => !ancestors.has(other)),
      ...this.drainingWrites,
      ...[...this.host.preparing()].filter(other => other.request.name !== request.name),
    ]
    for (const other of others) {
      const clash = request.writes.filter(mine =>
        other.request.writes.some(theirs => scopesOverlap(mine, theirs)))
      if (clash.length === 0) continue
      const detail = `'${other.request.name}' also writes ${clash.join(', ')}`
      if (policy === 'reject') {
        throw new Error(
          `worker '${request.name}' would write files another running worker writes: ${detail}.`
          + ` Add '${other.request.name}' to dependsOn so it runs after, or narrow the scopes`
          // Observed in a real run: four read-only researchers each declared the
          // same placeholder scope and collided over a file none of them would
          // ever write. The refusal used to offer only dependsOn and narrowing,
          // which sends a worker that writes nothing looking for a better fake
          // path instead of dropping the field.
          + ' — or omit writes entirely if this worker only reads.',
        )
      }
      found.push(detail)
    }
    return found
  }

  /** Every worker reachable through `dependsOn`, transitively. */
  private ancestorsOf(workers: readonly WorkerRuntime[], seen = new Set<WorkerRuntime>()): Set<WorkerRuntime> {
    for (const runtime of workers) {
      if (seen.has(runtime)) continue
      seen.add(runtime)
      this.ancestorsOf(runtime.dependencies, seen)
    }
    return seen
  }

  /** Includes team-owned follow-ups queued between session runs. */
  workerHasWork(runtime: WorkerRuntime, runningRoster?: ReadonlySet<string | undefined>): boolean {
    return runtime.session.isRunning || this.drainingWrites.has(runtime)
      || (runningRoster === undefined
        ? this.host.team.members().some(member => member.name === runtime.request.name
          && member.conversationId === runtime.session.conversationId && member.status === 'running')
        : runningRoster.has(runtime.session.conversationId))
  }

  /** Whether every named worker has reached a final state without conflicting active writes. */
  dependenciesSettled(workers: readonly WorkerRuntime[], writes: readonly string[] = []): boolean {
    return workers.every(runtime => SETTLED_WORKER_STATUS.has(runtime.status)
      && !((this.host.options.writeScopePolicy ?? 'reject') === 'reject'
        && writes.some(mine => runtime.request.writes.some(theirs => scopesOverlap(mine, theirs)))
        && this.workerHasWork(runtime)))
  }

  /**
   * Start whatever was waiting on the worker that just settled.
   *
   * Dependents are released when their dependencies SETTLE, not when they
   * succeed. Requiring success would let one failed worker strand every step
   * planned after it, and a plan that stalls silently is worse than one whose
   * later stages are told the earlier ones broke — which is exactly what they
   * are told: each dependent starts with what its dependencies produced.
   */
  async releaseDependents(finished: WorkerRuntime): Promise<void> {
    if (this.host.signal.aborted) return
    const ready = [...this.host.workers.values()].filter(runtime =>
      runtime.status === 'pending'
      && !runtime.closing
      && runtime.dependencies.includes(finished)
      && this.dependenciesSettled(runtime.dependencies, runtime.request.writes))
    for (const runtime of ready) {
      await this.host.startWorker(runtime)
    }
  }

}
