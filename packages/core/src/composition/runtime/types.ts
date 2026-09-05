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
import type { ComposableModelProviderPlugin, RuntimeProviderInfo } from '../provider/types.ts'
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
  readonly providers: readonly ComposableModelProviderPlugin[]
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
  agent(definition: RuntimeAgentBindingInput): RuntimeAgent
  team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam
  logger(context?: { readonly scope?: string; readonly fields?: Readonly<JsonObject> }): SdkLogger
  diagnostics(): RuntimeDiagnosticSnapshot
  close(options?: { readonly signal?: AbortSignal }): Promise<RuntimeCloseReport>
}

export interface AgentRuntime extends RuntimeCompositionView {}
export interface AgentRuntimeOptions extends RuntimeOwnerOptions {}
export type DiagnosticSnapshot = RuntimeDiagnosticSnapshot
