/**
 * Session store and the SDK-event → wire-event projection.
 *
 * A "session" is the live half of a conversation: the hydrated agent history,
 * the user-input broker that lets a parked question be answered by a later
 * request, and the abort handle. Everything durable — history snapshot,
 * transcript, model, mode, workspace — lives in SQLite (`conversations.ts`).
 */

export type { ChatSession } from './session/types'
export type { Doorbell, RunStep } from './session/streams'
export { runSteps, createDoorbell } from './session/streams'
export type { MemberFeed } from './session/members'
export { createMemberFeed, followWorkers } from './session/members'
export { session, forgetSession } from './session/store'
export { answer, approve, steer, pendingApprovals, pendingQuestions, abortRun } from './session/controls'
export { runPrompt } from './session/prompt'
