/**
 * Cleanup bound after a failed spawn: how long cancelling the half-started worker may take.
 * Spawn setup itself has no default deadline; hosts opt in with
 * {@link ManagedAgentTeamOptions.spawnTimeoutMs}, which then also bounds this cleanup.
 */
export const DEFAULT_SPAWN_SETUP_TIMEOUT_MS = 30_000

/** Default bound on stopping one worker; see {@link ManagedAgentTeamOptions.closeTimeoutMs}. */
export const DEFAULT_WORKER_CLOSE_TIMEOUT_MS = 30_000
