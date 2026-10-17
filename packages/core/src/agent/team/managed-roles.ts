import type { ManagedAgentRole } from './managed-types.ts'

/**
 * Opt-in roles. Hosts identify tools whose entire behavior is read-only; names alone cannot prove that.
 * No readOnlyTools means explorer/reviewer have no application tools. Worker retains the host's toolset.
 * Role allowlists intersect available host tools, and never supply implementations or widen authority.
 */
export function managedAgentRolePresets(
  options: { readonly readOnlyTools?: readonly string[] } = {},
): readonly ManagedAgentRole[] {
  const readOnlyTools = Object.freeze([...(options.readOnlyTools ?? [])])
  return Object.freeze([
    Object.freeze({
      name: 'explorer', description: 'Read-only investigation and evidence gathering.',
      whenToUse: 'An independent question can be answered without editing files.',
      instructions: 'Inspect and report evidence with file references. Do not modify the workspace.',
      tools: readOnlyTools,
    }),
    Object.freeze({
      name: 'worker', description: 'Implement and verify a bounded task within its assigned write scope.',
      whenToUse: 'A concrete implementation can run in parallel with disjoint writes.',
    }),
    Object.freeze({
      name: 'reviewer', description: 'Read-only review with fresh context.',
      whenToUse: 'An artifact exists and needs an independent correctness check.',
      instructions: 'Review independently. Report actionable findings with evidence; do not edit files.',
      tools: readOnlyTools, context: 'fresh' as const,
    }),
  ])
}
