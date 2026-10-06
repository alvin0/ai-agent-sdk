import type { RuntimeAgentRunEvent } from './types.ts'

/** A runtime event as it may leave the host: the terminal run report removed. */
export type PublicRuntimeAgentRunEvent = RuntimeAgentRunEvent extends infer E
  ? E extends { readonly report: unknown } ? Omit<E, 'report'> : E
  : never

/**
 * Strips the run report from the terminal `usage` and `error` events.
 *
 * The report lists every model call, tool call and usage counter of the run;
 * it is for the host (it stays on `handle.report` and the result). A host that
 * forwards events to a browser or another tenant passes them through this, so
 * the support-safe `error` and the `usage` totals go out without it. Every
 * other event is returned unchanged.
 */
export function withoutRunReport(event: RuntimeAgentRunEvent): PublicRuntimeAgentRunEvent {
  if (!('report' in event)) return event as PublicRuntimeAgentRunEvent
  const { report: _report, ...rest } = event
  return Object.freeze(rest) as PublicRuntimeAgentRunEvent
}
