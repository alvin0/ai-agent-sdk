/** Private bridge: observers stay isolated, but progress can detect delivery failure. */
import type { TeamProgressEvent } from './team-progress.ts'

export type ProgressActivity =
  | { kind: 'invocation'; member: string; signal: AbortSignal }
  | { kind: 'tool'; member: string; name: string; args: unknown }
  | { kind: 'settlement'; member: string }
  | { kind: 'run-end'; member: string; status: string }
export interface ProgressChannel {
  readonly signal: AbortSignal
  emit(event: TeamProgressEvent): boolean
}
const channels = new WeakMap<object, ProgressChannel>()
const listeners = new WeakMap<object, Set<(activity: ProgressActivity) => void>>()
export function registerProgressChannel(team: object, channel: ProgressChannel): void { channels.set(team, channel) }
export function progressChannel(team: object): ProgressChannel { return channels.get(team)! }
export function watchProgressActivity(team: object, listener: (activity: ProgressActivity) => void): () => void {
  let set = listeners.get(team)
  if (set === undefined) { set = new Set(); listeners.set(team, set) }
  set.add(listener)
  return () => { set.delete(listener) }
}
export function progressActivity(team: object, activity: ProgressActivity): void {
  for (const listener of listeners.get(team) ?? []) { try { listener(activity) } catch { /* observer isolation */ } }
}

/** The existing team event contract is synchronous. Reject async sinks without unhandled rejections. */
export function deliverProgressEvent(event: TeamProgressEvent,
  observers: readonly (((event: TeamProgressEvent) => void) | undefined)[]): boolean {
  let delivered = true
  for (const observer of observers) {
    try {
      const result: unknown = observer?.(event)
      if (result !== null && typeof result === 'object' && 'then' in result) {
        void Promise.resolve(result).catch(() => undefined)
        delivered = false
      }
    } catch { delivered = false }
  }
  return delivered
}
