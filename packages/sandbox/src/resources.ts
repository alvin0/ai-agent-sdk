/**
 * Resource limits — a third axis, and the one this package enforces weakest.
 *
 * A filesystem boundary can be completely correct while the host falls over: a
 * fork storm, a growing allocation, or a loop that never ends costs nothing in
 * file effects. Measured against the current backends, 150 processes, 2 GB of
 * memory and 20 000 files met no resistance at all.
 *
 * What a host can actually promise differs so much that the promise has to be
 * reported rather than assumed. A real quota needs cgroup v2 or a Job Object;
 * without one, limits can still be observed and acted on, which stops a runaway
 * but does not prevent the spike that precedes it.
 */

/** What a confined execution may consume. Every field is optional. */
export interface ResourceLimits {
  /** Wall-clock time before the execution is ended. */
  readonly wallClockMs?: number
  /** Resident memory across the whole process tree. */
  readonly memoryBytes?: number
  /** Processes in the tree, including the sandbox process itself. */
  readonly processes?: number
  /** Accumulated CPU time across the tree. */
  readonly cpuMs?: number
}

/**
 * How a host enforces those limits.
 *
 * `quota` means the kernel refuses to exceed them. `monitor` means they are
 * sampled and the execution is ended once exceeded — which bounds a runaway but
 * not the spike between two samples. `none` means nothing is watching.
 */
export type ResourceEnforcement = 'quota' | 'monitor' | 'none'

/** Why a supervised execution was ended. */
export type ResourceBreach = 'wall-clock' | 'memory' | 'processes' | 'cpu'

/** What a supervised execution actually consumed. */
export interface ResourceUsage {
  /** Highest resident memory observed across the tree. */
  readonly peakMemoryBytes: number
  /** Highest process count observed in the tree. */
  readonly peakProcesses: number
  /** Highest accumulated CPU time observed. */
  readonly cpuMs: number
  /** Wall-clock time the execution ran for. */
  readonly wallClockMs: number
}

/** Whether any limit is set at all, so a caller can skip supervision entirely. */
export function hasResourceLimits(limits: ResourceLimits): boolean {
  return limits.wallClockMs !== undefined || limits.memoryBytes !== undefined
    || limits.processes !== undefined || limits.cpuMs !== undefined
}

/**
 * The first limit the usage exceeds, or `undefined` while it is within them.
 * Checked in the order a runaway usually announces itself.
 */
export function breachedLimit(
  usage: ResourceUsage,
  limits: ResourceLimits,
): ResourceBreach | undefined {
  if (limits.wallClockMs !== undefined && usage.wallClockMs > limits.wallClockMs) return 'wall-clock'
  if (limits.processes !== undefined && usage.peakProcesses > limits.processes) return 'processes'
  if (limits.memoryBytes !== undefined && usage.peakMemoryBytes > limits.memoryBytes) return 'memory'
  if (limits.cpuMs !== undefined && usage.cpuMs > limits.cpuMs) return 'cpu'
  return undefined
}
