import {
  FetchObservationExporter,
  flushObservabilityWithWaitUntil,
  type FetchObservationExporterOptions,
  type WaitUntil,
} from '@ai-agent-sdk/observability-fetch'
import {
  BROWSER_OBSERVATION_ERROR_CODES,
  BrowserObservationError,
  IndexedDbObservationExporter,
  installBrowserObservabilityLifecycle,
  type BrowserLifecycleOptions,
  type BrowserObservationErrorCode,
  type BrowserQueueStats,
  type IndexedDbObservationExporterOptions,
} from '@ai-agent-sdk/observability-browser'
import {
  NODE_OBSERVATION_ERROR_CODES,
  JsonlObservationJournalExporter,
  NodeObservationError,
  createDiagnosticWireLogger,
  installNodeObservabilityLifecycle,
  recoverJournal,
  type DiagnosticWireLoggerOptions,
  type JournalDurabilityMode,
  type JournalRecoveryRecord,
  type JournalRecoveryResult,
  type JournalStats,
  type JsonlObservationJournalOptions,
  type NodeLifecycleOptions,
  type NodeLifecycleTarget,
  type NodeObservationErrorCode,
  type ProviderWireLogRecord,
  type ProviderWireLogger,
} from '@ai-agent-sdk/observability-node'
import {
  JsonlObservationJournalExporter as JournalRouteExporter,
  recoverJournal as recoverJournalFromRoute,
} from '@ai-agent-sdk/observability-node/journal'
import {
  createDiagnosticWireLogger as createDiagnosticWireLoggerFromRoute,
  type ProviderWireLogger as DiagnosticRouteLogger,
} from '@ai-agent-sdk/observability-node/diagnostic'
import {
  OTEL_SEMANTIC_CONVENTIONS_COMMIT,
  OpenTelemetryBridgeError,
  createOpenTelemetryBridge,
  type OpenTelemetryBridge,
  type OpenTelemetryBridgeOptions,
  type OpenTelemetryLogEnabledOptions,
  type OpenTelemetryLogRecord,
  type OpenTelemetryLogger,
} from '@ai-agent-sdk/observability-otel'

export type ObservabilityCapabilityTypeInventory = [
  FetchObservationExporterOptions,
  WaitUntil,
  BrowserLifecycleOptions,
  BrowserObservationErrorCode,
  BrowserQueueStats,
  IndexedDbObservationExporterOptions,
  DiagnosticWireLoggerOptions,
  JournalDurabilityMode,
  JournalRecoveryRecord,
  JournalRecoveryResult,
  JournalStats,
  JsonlObservationJournalOptions,
  NodeLifecycleOptions,
  NodeLifecycleTarget,
  NodeObservationErrorCode,
  ProviderWireLogRecord,
  ProviderWireLogger,
  DiagnosticRouteLogger,
  OpenTelemetryBridge,
  OpenTelemetryBridgeOptions,
  OpenTelemetryLogEnabledOptions,
  OpenTelemetryLogRecord,
  OpenTelemetryLogger,
]

export type ObservabilityCapabilityValueInventory = [
  typeof FetchObservationExporter,
  typeof flushObservabilityWithWaitUntil,
  typeof BROWSER_OBSERVATION_ERROR_CODES,
  typeof BrowserObservationError,
  typeof IndexedDbObservationExporter,
  typeof installBrowserObservabilityLifecycle,
  typeof NODE_OBSERVATION_ERROR_CODES,
  typeof JsonlObservationJournalExporter,
  typeof NodeObservationError,
  typeof createDiagnosticWireLogger,
  typeof installNodeObservabilityLifecycle,
  typeof recoverJournal,
  typeof JournalRouteExporter,
  typeof recoverJournalFromRoute,
  typeof createDiagnosticWireLoggerFromRoute,
  typeof OTEL_SEMANTIC_CONVENTIONS_COMMIT,
  typeof OpenTelemetryBridgeError,
  typeof createOpenTelemetryBridge,
]

const fetchOptions: FetchObservationExporterOptions = {
  endpoint: new URL('https://telemetry.example.test/v1/events'),
  maxAttempts: 3,
  maxBatchEvents: 100,
  maxBatchBytes: 1024 * 1024,
}
const fetchExporter = new FetchObservationExporter(fetchOptions)

const browserOptions: IndexedDbObservationExporterOptions = {
  databaseName: 'compatibility-observations',
  maxEvents: 10_000,
  maxBytes: 16 * 1024 * 1024,
}
const browserExporter = new IndexedDbObservationExporter(browserOptions)

const journalOptions: JsonlObservationJournalOptions = {
  rootDir: '/tmp/compatibility-observations',
  mode: 'reliable',
  maxRetainedBytes: 16 * 1024 * 1024,
}
const journal = new JsonlObservationJournalExporter(journalOptions)

export const advancedExporterConstruction = {
  fetchExporter,
  browserExporter,
  journal,
  browserError: new BrowserObservationError(
    BROWSER_OBSERVATION_ERROR_CODES.unavailable,
    'unavailable',
  ),
  nodeError: new NodeObservationError(
    NODE_OBSERVATION_ERROR_CODES.io,
    'io',
  ),
  otelError: new OpenTelemetryBridgeError(),
}

/** Representative current source that must compile unchanged against the target. */
export async function exerciseObservationCapabilities(
  signal: AbortSignal,
  flushable: Parameters<typeof flushObservabilityWithWaitUntil>[0],
  shutdownable: Parameters<typeof installNodeObservabilityLifecycle>[0],
  browserLifecycle: BrowserLifecycleOptions,
  nodeLifecycle: NodeLifecycleOptions,
  bridgeOptions: OpenTelemetryBridgeOptions,
): Promise<void> {
  const waitUntil: WaitUntil = pending => { void pending }
  await flushObservabilityWithWaitUntil(flushable, waitUntil, signal)
  const removeBrowserLifecycle = installBrowserObservabilityLifecycle(
    flushable,
    browserLifecycle,
  )
  const removeNodeLifecycle = installNodeObservabilityLifecycle(
    shutdownable,
    nodeLifecycle,
  )
  const recovery: JournalRecoveryResult = await recoverJournal(journalOptions.rootDir)
  const sameRecovery: typeof recoverJournal = recoverJournalFromRoute
  const sameJournalClass: typeof JsonlObservationJournalExporter = JournalRouteExporter
  const sameLoggerFactory: typeof createDiagnosticWireLogger =
    createDiagnosticWireLoggerFromRoute
  const bridge: OpenTelemetryBridge = createOpenTelemetryBridge(bridgeOptions)
  void recovery.records
  void sameRecovery
  void sameJournalClass
  void sameLoggerFactory
  void bridge.diagnostics()
  removeBrowserLifecycle()
  removeNodeLifecycle()
}
