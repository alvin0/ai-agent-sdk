/** Session configuration helpers shared by immediate and queued worker setup. */
import { cloneAgent, type DefinedAgent } from '../define/definition.ts'
import type { AgentSession, AgentSessionOptions } from '../define/session.ts'
import { History } from '../history/index.ts'
import { completedHistoryPrefix } from './managed-history.ts'
import type { ManagedAgentTeamOptions, ResolvedManagedAgentSpawnRequest } from './managed-types.ts'

type ScopedSessionOptions = Awaited<ReturnType<NonNullable<ManagedAgentTeamOptions['workerSessionOptionsFactory']>>>

export function mergeWorkerSessionOptions(
  base: ManagedAgentTeamOptions['workerSessionOptions'], scoped: ScopedSessionOptions | undefined,
): NonNullable<ManagedAgentTeamOptions['workerSessionOptions']> {
  // Omitted scoped values must not erase base tool restrictions or policy hooks.
  return { ...base, ...Object.fromEntries(Object.entries(scoped ?? {}).filter(([, value]) => value !== undefined)) }
}

/** Fork only the completed prefix, using the worker's configured history limits. */
export function forkWorkerHistory(lead: AgentSession, limits: AgentSessionOptions['historyLimits']): History {
  return History.fromSnapshot({ version: 1, entries: completedHistoryPrefix(lead.snapshot().history) }, limits ?? {})
}

export async function workerDefinition(options: ManagedAgentTeamOptions,
  request: ResolvedManagedAgentSpawnRequest): Promise<DefinedAgent> {
  if (options.workerFactory !== undefined) return options.workerFactory(request)
  const template = options.workerTemplate ?? {
    ...options.lead,
    // Clear the source allowlist too, so explicit worker session skills remain usable.
    ...(options.inheritLeadTools === false ? { nativeTools: [], skills: [], skillIds: undefined } : {}),
  }
  const specialty = request.specialty === undefined ? '' : ` Your specialization is: ${request.specialty}.`
  return cloneAgent(template, { id: request.name, name: request.name, instructions: template.instructions + specialty })
}
