/**
 * Default bound on getting one worker RUNNING, overridable per harness with
 * {@link ManagedAgentTeamOptions.spawnTimeoutMs}.
 *
 * Not the worker's deadline — that is `workerTimeoutMs`. This bounds only the
 * setup, so a lead cannot be held for minutes by a call that no longer waits
 * for any work.
 */
export const DEFAULT_SPAWN_SETUP_TIMEOUT_MS = 30_000

/** Default bound on stopping one worker; see {@link ManagedAgentTeamOptions.closeTimeoutMs}. */
export const DEFAULT_WORKER_CLOSE_TIMEOUT_MS = 30_000

/** @deprecated Retained for compatibility; event-driven coordination ignores holdWaitMs. */
export const DEFAULT_HOLD_WAIT_MS = 15_000
