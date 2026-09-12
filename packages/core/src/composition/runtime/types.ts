import type { JsonObject } from '../../primitives/index.ts'
import type { DeliveryMode, ObservationResourceInput } from '../../observation/index.ts'
import type { LogLevel, SdkLogger } from '../../logging/types.ts'
import type { ContentRedactor, ObservationProcessor } from '../../observation/telemetry-types.ts'
import type { ObservationSpan, OpenObservationSpanInput } from '../../observation/index.ts'
import type { RuntimeDiagnosticSnapshot } from '../observation/port.ts'
import type { RuntimeObservationHealthSnapshot } from '../observation/health.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import type { RuntimeComponentCloseReport } from '../common/errors.ts'
import type { RuntimeOperationCloseSummary } from '../lifecycle/types.ts'
import type { RuntimeProviderInfo } from '../provider/types.ts'
import type { ComposableRuntimeProviderPlugin } from '../embedding/plugin-types.ts'
import type { EmbeddingModelHandle, EmbeddingModelOptions } from '../../embedding/handle.ts'
import type { RuntimeAgent, RuntimeAgentBindingInput } from '../agent/types.ts'
import type { ModelCatalogOptions } from '../../contract/model-info.ts'
import type { RuntimeModelCatalogSnapshot } from '../model-catalog/types.ts'
import type { RuntimeAgentTeam, RuntimeAgentTeamOptions } from '../team/types.ts'

export interface RuntimeOwnerObservabilityOptions {
  readonly mode?: DeliveryMode
  readonly content?: 'none' | 'metadata'
  readonly minimumLogLevel?: LogLevel
  readonly exporters?: readonly RuntimeObservationExporterRegistration[]
  readonly processors?: readonly ObservationProcessor[]
  readonly redactors?: readonly ContentRedactor[]
  readonly includeErrorStacks?: boolean
  readonly openSpan?: (input: OpenObservationSpanInput) => ObservationSpan
  readonly maxQueueEvents?: number
  readonly maxQueueBytes?: number
  readonly maxBatchEvents?: number
  readonly maxBatchBytes?: number
  readonly flushTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
}

export interface RuntimeObservationResourceInput extends ObservationResourceInput {}

/** Internal I3 owner input. Remaining public agent/processor fields join at their composition layer. */
export interface RuntimeOwnerOptions {
  /**
   * Both provider plugin kinds in ONE list, discriminated by `kind` at preflight.
   *
   * A single list rather than a second `embeddingProviders` field is what keeps
   * ordering, preflight failure indexes and the shared rollback list meaningful
   * across kinds: `provider-2` names the third entry the caller wrote, whichever
   * kind it is (Requirement 11.4).
   */
  readonly providers: readonly ComposableRuntimeProviderPlugin[]
  readonly defaultProvider?: string
  readonly signal?: AbortSignal
  readonly resource?: RuntimeObservationResourceInput
  readonly observability?: RuntimeOwnerObservabilityOptions
  readonly closeTimeoutMs?: number
  readonly startupTimeoutMs?: number
  readonly diagnosticMaxEvents?: number
  readonly diagnosticMaxBytes?: number
}

export interface RuntimeCloseReport {
  readonly state: 'closed'
  readonly quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'
  readonly deadlineReached: boolean
  readonly activeRunsAtClose: number
  readonly abortedRuns: number
  readonly unsettledRuns: number
  readonly operations: readonly RuntimeOperationCloseSummary[]
  readonly components: readonly RuntimeComponentCloseReport[]
  readonly observationHealth: RuntimeObservationHealthSnapshot
}

export interface RuntimeCompositionView {
  providers(): readonly RuntimeProviderInfo[]
  modelCatalog(route: string, options?: ModelCatalogOptions): Promise<RuntimeModelCatalogSnapshot>
  /**
   * Resolve one route + model into an {@link EmbeddingModelHandle}, synchronously.
   *
   * Deliberately NOT a promise and deliberately not routed through an agent: it
   * admits, captures the options and resolves an adapter, so a document indexing
   * service pays for none of the agent, team or session machinery
   * (Requirements 3.1, 3.4, 19.4). A route with no embedding adapter — including
   * one that carries only a generation adapter — fails here with
   * `EMBEDDING_ADAPTER_MISSING` rather than at the first `embed()`
   * (Requirement 3.5), and a runtime that has begun closing refuses to hand out
   * a handle at all (Requirement 12.6).
   */
  embeddingModel(options: EmbeddingModelOptions): EmbeddingModelHandle
  agent(definition: RuntimeAgentBindingInput): RuntimeAgent
  team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam
  logger(context?: { readonly scope?: string; readonly fields?: Readonly<JsonObject> }): SdkLogger
  diagnostics(): RuntimeDiagnosticSnapshot
  close(options?: { readonly signal?: AbortSignal }): Promise<RuntimeCloseReport>
}

export interface AgentRuntime extends RuntimeCompositionView {}
export interface AgentRuntimeOptions extends RuntimeOwnerOptions {}
export type DiagnosticSnapshot = RuntimeDiagnosticSnapshot
