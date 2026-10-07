import type { RunAccountingPort } from '../../accounting/contracts.ts'
import { SkillCatalog, type SkillLookupOptions } from '../../skill/index.ts'
import type { AgentDefinition } from '../definition.ts'
import { type AgentSessionActivatedSkillSnapshot } from './types.ts'
import type { AgentSessionSnapshot } from './types.ts'
import { AgentSdkError } from '../../../errors/agent-sdk-error.ts'
import { captureSkillReference } from '../../skill/provider/snapshot.ts'

export function captureResumedSkillActivations(
  skills: AgentSessionSnapshot['skills'],
  catalog: SkillCatalog | undefined,
): readonly AgentSessionActivatedSkillSnapshot[] {
  const activations = Object.freeze([...skills?.activated ?? []].map((activation): AgentSessionActivatedSkillSnapshot =>
    activation.catalogRevision === undefined ? Object.freeze({
      id: activation.id, provider: activation.provider, source: activation.source,
      ...activation.resourceBase === undefined ? {} : {
        resourceBase: Object.freeze({ ...activation.resourceBase }),
      },
    }) : captureSkillReference(activation)))
  for (const activation of activations) {
    if (activation.catalogRevision === undefined) continue
    if (catalog === undefined) {
      throw new AgentSdkError('Persisted skill reference has no matching provider', 'SKILL_REFERENCE_INVALID')
    }
    catalog.validateReferenceOwner(activation)
  }
  return activations
}

function validatePendingOwners(catalog: SkillCatalog, pending: readonly AgentSessionActivatedSkillSnapshot[]): void {
  for (const activation of pending) {
    if (activation.catalogRevision !== undefined) catalog.validateReferenceOwner(activation)
  }
}

function validateLegacyActivation(catalog: SkillCatalog, activation: AgentSessionActivatedSkillSnapshot): void {
  const summary = catalog.summaries().find(candidate => candidate.id === activation.id)
  if (summary === undefined) {
    throw new Error(`cannot restore activated skill '${activation.id}'; it is no longer available`)
  }
  if (summary.provider !== activation.provider || summary.source !== activation.source) {
    throw new Error(
      `cannot restore activated skill '${activation.id}'; its provider or source changed`,
    )
  }
  if (summary.resourceBase?.kind !== activation.resourceBase?.kind
    || summary.resourceBase?.value !== activation.resourceBase?.value) {
    throw new Error(
      `cannot restore activated skill '${activation.id}'; its resource location changed`,
    )
  }
}

function endSkillOperation(accounting: RunAccountingPort | undefined, operation: string | undefined,
  status: 'success' | 'aborted' | 'error', input?: { error: unknown }): void {
  if (operation === undefined) return
  if (input === undefined) accounting?.endOperation(operation, status)
  else accounting?.endOperation(operation, status, input)
}

function failSkillPreparation(catalog: SkillCatalog | undefined, accounting: RunAccountingPort | undefined,
  operation: string | undefined, failure: { operationSignal: AbortSignal; error: unknown }): void {
  catalog?.clearActivations()
  if (operation !== undefined) endSkillOperation(accounting, operation,
    failure.operationSignal.aborted ? 'aborted' : 'error', { error: failure.error })
}

interface SkillPreparationContext {
  readonly skillLookup: (signal?: AbortSignal) => SkillLookupOptions
  readonly clearPending: () => void
  readonly signal?: AbortSignal | undefined
  readonly accounting?: RunAccountingPort | undefined
}

export async function prepareSkills(
  definition: AgentDefinition,
  catalog: SkillCatalog | undefined,
  pending: readonly AgentSessionActivatedSkillSnapshot[],
  context: SkillPreparationContext,
): Promise<void> {
  const { skillLookup, clearPending, signal, accounting } = context
  const operation = accounting?.startOperation('skill', { data: { action: 'discover-and-restore' } })
  const operationSignal = AbortSignal.any([
    AbortSignal.timeout(definition.skillOptions.operationTimeoutMs),
    ...signal === undefined ? [] : [signal],
  ])
  try {
    if (catalog === undefined) {
      if (pending.length > 0) {
        throw new Error(`agent '${definition.id}' cannot restore activated skills without skill sources`)
      }
      endSkillOperation(accounting, operation, 'success')
      return
    }
    validatePendingOwners(catalog, pending)
    const lookup = skillLookup(operationSignal)
    await catalog.discover(lookup)
    if (pending.length === 0) {
      endSkillOperation(accounting, operation, 'success')
      return
    }
    for (const activation of pending) {
      if (activation.catalogRevision !== undefined) {
        await catalog.restoreReference(activation, lookup)
        continue
      }
      validateLegacyActivation(catalog, activation)
      if (await catalog.activate(activation.id, lookup) === undefined) {
        throw new Error(`cannot restore activated skill '${activation.id}'; its definition is unavailable`)
      }
    }
    clearPending()
    endSkillOperation(accounting, operation, 'success')
  } catch (error: unknown) {
    failSkillPreparation(catalog, accounting, operation, { operationSignal, error })
    throw error
  }
}
