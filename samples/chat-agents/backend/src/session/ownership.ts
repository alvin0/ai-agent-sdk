import type { ChatSession } from './types'

/**
 * The lead's address in a dynamic team.
 *
 * Shared with `agent-runtime`'s `createManagedAgentTeam({ leadName: 'lead' })`:
 * the team reports every member through one observer, and this is how the
 * agent the user talks to is told apart from the workers it created.
 */
export const LEAD_NAME = 'lead'

/**
 * Runs a newer prompt took over, marked at the moment of takeover.
 *
 * A `WeakSet` rather than a flag on the session: the displaced run needs the
 * answer about ITSELF, long after the session has moved on to another run.
 */
export const displacedRuns = new WeakSet<AbortController>()

// Retain ownership independently so a subsequent prompt still supersedes it.
export const runOwners = new WeakMap<ChatSession, AbortController>()
