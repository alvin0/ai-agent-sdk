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

/**
 * Default bound on holding the lead's turn open for news from a worker; see
 * {@link ManagedAgentTeamOptions.holdWaitMs}.
 *
 * Long enough that a lead is not re-prompted about work that has visibly just
 * started, short enough that it keeps control of its own run: at the deadline
 * the turn comes back and the lead decides whether to wait again, close a
 * worker, or answer with what it has.
 */
export const DEFAULT_HOLD_WAIT_MS = 15_000

