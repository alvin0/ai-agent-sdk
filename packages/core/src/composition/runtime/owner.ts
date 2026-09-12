import { ModelRegistry } from '../../runtime/registry.ts'
import { EmbeddingRegistry } from '../embedding/registry.ts'
import { RuntimeEmbedding } from '../embedding/manager.ts'
import type { EmbeddingModelHandle, EmbeddingModelOptions } from '../../embedding/handle.ts'
import { createRuntimePlatform, type RuntimePlatform } from '../../platform/adapter.ts'
import { RuntimeResources } from '../../platform/resources.ts'
import { createRuntimeResource } from '../delivery/resource.ts'
import { RuntimeObservationPort, type RuntimeDiagnosticSnapshot } from '../observation/port.ts'
import { preflightRuntimeCapabilities } from '../preflight.ts'
import { providerTopology } from '../provider/model-selection.ts'
import type { ProviderRegistration } from '../provider/activation.ts'
import type { RuntimeProviderInfo } from '../provider/types.ts'
import { activateRuntimeCapabilities } from '../startup.ts'
import { RuntimeOperations } from '../lifecycle/operations.ts'
import type { QuiescenceReport } from '../lifecycle/types.ts'
import type { RuntimeComponentCloseReport } from '../common/errors.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type { RuntimeLoggerContext } from '../logging/logger.ts'
import { captureCloseSignal, captureRuntimeOwnerOptions } from './config.ts'
import type { RuntimeCloseReport, RuntimeCompositionView, RuntimeOwnerOptions } from './types.ts'
import { bindRuntimeAgentDefinition } from '../agent/definition.ts'
import { createRuntimeAgent } from '../agent/session.ts'
import type { RuntimeAgent, RuntimeAgentBindingInput } from '../agent/types.ts'
import type { ProviderSelection } from '../provider/types.ts'
import { RuntimeModelCatalog } from '../model-catalog/manager.ts'
import type { ModelCatalogOptions } from '../../contract/model-info.ts'
import type { RuntimeModelCatalogSnapshot } from '../model-catalog/types.ts'
import { createRuntimeAgentTeam } from '../team/runtime.ts'
import type { RuntimeAgentTeam, RuntimeAgentTeamOptions, RuntimeTeamRegistration } from '../team/types.ts'

/** Internal composition owner used to finish lifecycle semantics before the public agent surface is exported. */
export class RuntimeCompositionOwner implements RuntimeCompositionView {
  readonly registry: ModelRegistry
  readonly operations: RuntimeOperations
  private closing: Promise<RuntimeCloseReport> | undefined
  private readonly catalogs: RuntimeModelCatalog
  private readonly embeddings: RuntimeEmbedding
  private readonly teams: RuntimeTeamRegistration[] = []
  private readonly closedTeams: RuntimeComponentCloseReport[] = []

  constructor(
    registry: ModelRegistry,
    operations: RuntimeOperations,
    private readonly platform: RuntimePlatform,
    readonly resources: RuntimeResources,
    readonly observation: RuntimeObservationPort,
    readonly resource: import('../delivery/resource.ts').RuntimeObservationResource,
    private readonly topology: readonly RuntimeProviderInfo[],
    /** Read by the agent surface so a per-invocation model override resolves against these routes. */
    readonly selection: ProviderSelection,
    private readonly providersOwned: readonly ProviderRegistration[],
    private readonly exporters: Awaited<ReturnType<typeof activateRuntimeCapabilities>>['exporters'],
    private readonly closeTimeoutMs: number,
    /**
     * Runtime-owned embedding topology. Present even with zero embedding plugins,
     * so a generation-only runtime resolves nothing rather than failing on a
     * missing registry (Requirement 11.8).
     */
    readonly embeddingRegistry: EmbeddingRegistry = new EmbeddingRegistry(),
  ) {
    this.registry = registry
    this.operations = operations
    this.catalogs = new RuntimeModelCatalog(registry, operations, resources, topology)
    // Constructed unconditionally, exactly like the catalog manager: a runtime
    // with zero embedding plugins resolves nothing and reports
    // `EMBEDDING_ADAPTER_MISSING`, which is a better answer than a missing
    // manager (Requirement 11.8). The runtime observation port and resource are
    // forwarded so every handle emits its call and batch spans into this
    // runtime's trace when the caller supplies no context of its own.
    this.embeddings = new RuntimeEmbedding({
      registry: this.embeddingRegistry, operations, observation, resource,
    })
  }

  providers(): readonly RuntimeProviderInfo[] { return this.topology }
  modelCatalog(route: string, options?: ModelCatalogOptions): Promise<RuntimeModelCatalogSnapshot> {
    return this.catalogs.get(route, options)
  }
  /**
   * Synchronous adapter resolution; admission is checked by the manager FIRST,
   * before any option is read, and nothing agent-shaped is constructed.
   */
  embeddingModel(options: EmbeddingModelOptions): EmbeddingModelHandle {
    return this.embeddings.model(options)
  }
  agent(input: RuntimeAgentBindingInput): RuntimeAgent {
    this.operations.assertActive()
    return createRuntimeAgent(this, bindRuntimeAgentDefinition(input, this.selection))
  }
  team(input: RuntimeAgentTeamOptions): RuntimeAgentTeam {
    const registration = createRuntimeAgentTeam(this, input, closed => this.retireTeam(closed))
    this.teams.push(registration)
    return registration.view
  }
  logger(context?: RuntimeLoggerContext): SdkLogger { return this.observation.logger(context) }
  diagnostics(): RuntimeDiagnosticSnapshot { return this.observation.diagnostics() }

  close(input?: { readonly signal?: AbortSignal }): Promise<RuntimeCloseReport> {
    if (this.closing !== undefined) return this.closing
    const signal = captureCloseSignal(input)
    let resolve!: (report: RuntimeCloseReport) => void
    let reject!: (error: unknown) => void
    this.closing = new Promise((done, fail) => { resolve = done; reject = fail })
    const shared = this.closing
    try {
      const quiescence = this.operations.beginClose({ timeoutMs: this.closeTimeoutMs, ...(signal === undefined ? {} : { signal }) })
      this.observation.stopAdmission()
      void this.finishClose(quiescence).then(resolve, reject)
      return shared
    } catch (error) {
      this.closing = undefined
      throw error
    }
  }

  private async finishClose(quiescenceTask: Promise<QuiescenceReport>): Promise<RuntimeCloseReport> {
    const quiescence = await quiescenceTask
    // Every embedding operation has settled or been abandoned by now, so the
    // remembered handles and the registry subscription behind them are dead
    // weight. Dropping them here — before provider registrations unwind — keeps
    // no handle pointing at an adapter that is about to be torn down.
    this.embeddings.dispose()
    const deadlineAt = this.operations.closeDeadlineAt()
    const components: RuntimeComponentCloseReport[] = [...this.closedTeams]
    for (const team of [...this.teams].reverse()) components.push(await team.closeForRuntime(deadlineAt))
    for (const [reverseIndex, registration] of [...this.providersOwned].reverse().entries()) {
      const originalIndex = this.providersOwned.length - reverseIndex - 1
      if (this.platform.monotonicNow() >= deadlineAt) components.push(timedOutProvider(originalIndex))
      else components.push(registration.close({ at: deadlineAt, now: () => this.platform.monotonicNow() }))
    }
    const observationDeadline = this.observation.observationDeadline(deadlineAt)
    await this.observation.flushUntil(observationDeadline)
    this.observation.seal()
    components.push(...await this.exporters.close(observationDeadline))
    this.operations.finishClose()
    return Object.freeze({ state: 'closed', ...quiescence, components: Object.freeze(components),
      observationHealth: this.observation.health() })
  }

  private retireTeam(registration: RuntimeTeamRegistration): void {
    const index = this.teams.indexOf(registration)
    if (index < 0) return
    this.teams.splice(index, 1)
    this.closedTeams.push(Object.freeze({ kind: 'agent-team', id: registration.id, status: 'closed' }))
    // Reporting metadata is intentionally bounded independently of heavyweight
    // team state. Older tombstones can be omitted from a later runtime report.
    if (this.closedTeams.length > 1_024) this.closedTeams.shift()
  }
}

/** Web preflight and whole-input identity validation both precede runtime-owned allocations. */
export async function createRuntimeCompositionOwner(
  input: RuntimeOwnerOptions,
  host: typeof globalThis = globalThis,
): Promise<RuntimeCompositionOwner> {
  const platform = createRuntimePlatform(host)
  const options = captureRuntimeOwnerOptions(input)
  const plan = preflightRuntimeCapabilities(options.providers, options.observability.exporters,
    options.defaultProvider, options.signal)
  const resources = new RuntimeResources(platform)
  let observation: RuntimeObservationPort | undefined
  try {
    const resource = createRuntimeResource(options.resource, platform)
    observation = new RuntimeObservationPort(resource, plan.exporters, platform, resources, {
      mode: options.observability.mode,
      ...(options.observability.content === undefined ? {} : { content: options.observability.content }),
      ...(options.observability.minimumLogLevel === undefined ? {} : { minimumLogLevel: options.observability.minimumLogLevel }),
      ...(options.observability.processors === undefined ? {} : { processors: options.observability.processors }),
      ...(options.observability.redactors === undefined ? {} : { redactors: options.observability.redactors }),
      ...(options.observability.includeErrorStacks === undefined ? {} : { includeErrorStacks: options.observability.includeErrorStacks }),
      ...(options.observability.openSpan === undefined ? {} : { openSpan: options.observability.openSpan }),
      ...(options.observability.maxQueueEvents === undefined ? {} : { maxEvents: options.observability.maxQueueEvents }),
      ...(options.observability.maxQueueBytes === undefined ? {} : { maxBytes: options.observability.maxQueueBytes }),
      ...(options.observability.maxBatchEvents === undefined ? {} : { maxBatchEvents: options.observability.maxBatchEvents }),
      ...(options.observability.maxBatchBytes === undefined ? {} : { maxBatchBytes: options.observability.maxBatchBytes }),
      ...(options.observability.flushTimeoutMs === undefined ? {} : { flushTimeoutMs: options.observability.flushTimeoutMs }),
      ...(options.observability.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.observability.shutdownTimeoutMs }),
      ...(options.diagnosticMaxEvents === undefined ? {} : { diagnosticMaxEvents: options.diagnosticMaxEvents }),
      ...(options.diagnosticMaxBytes === undefined ? {} : { diagnosticMaxBytes: options.diagnosticMaxBytes }),
    })
    const registry = new ModelRegistry({ observation, observationResource: resource })
    const capabilities = await activateRuntimeCapabilities(plan, registry,
      observation.logger({ scope: 'sdk.provider.setup' }), resources, {
        startupTimeoutMs: options.startupTimeoutMs, rollbackTimeoutMs: options.closeTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    return new RuntimeCompositionOwner(registry, new RuntimeOperations(resources), platform, resources,
      observation, resource, providerTopology(plan.selection), plan.selection,
      capabilities.providers, capabilities.exporters, options.closeTimeoutMs,
      capabilities.embeddingRegistry)
  } catch (error) {
    observation?.seal()
    resources.close()
    throw error
  }
}

function timedOutProvider(index: number): RuntimeComponentCloseReport {
  return Object.freeze({ kind: 'provider-registration', id: `provider-${index}`, status: 'timed-out',
    error: Object.freeze({ code: 'CAPABILITY_CLEANUP_TIMEOUT', stage: 'provider-cleanup',
      message: 'Provider cleanup did not start before the runtime close deadline' }) })
}
