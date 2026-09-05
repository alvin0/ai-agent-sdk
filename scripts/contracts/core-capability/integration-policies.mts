// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'

export function validateIntegrationPolicies(ctx: ContractContext): void {
  const { workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
  } = ctx
  const {
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
  } = makeHelpers(workspace, topology)
  const { readFileSync, existsSync } = fs
  const { join, resolve } = path
  void [workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
    readFileSync, existsSync, join, resolve]
  const callerOwnedIntegrationLoggingPolicy = topology.callerOwnedIntegrationLoggingPolicy
if (callerOwnedIntegrationLoggingPolicy.bootstrapOrder !== 'runtime-then-connect-with-bound-logger'
  || callerOwnedIntegrationLoggingPolicy.cleanupOrder !== 'runtime-quiesce-close-before-integration-close'
  || callerOwnedIntegrationLoggingPolicy.loggerOption !== 'optional-for-advanced-direct-use-required-in-recommended-runtime-journeys'
  || callerOwnedIntegrationLoggingPolicy.evidenceShape !== 'runtime-active-one-start-and-one-terminal-per-logical-operation-with-support-safe-error'
  || callerOwnedIntegrationLoggingPolicy.physicalAttemptEvidence !== 'every-network-or-process-attempt-linked-to-logical-operation'
  || callerOwnedIntegrationLoggingPolicy.accountingRole !== 'operational-only-never-token-or-billing-authority'
  || callerOwnedIntegrationLoggingPolicy.contentPolicy !== 'metadata-only-no-credentials-headers-bodies-prompts-results-or-card-content'
  || callerOwnedIntegrationLoggingPolicy.postRuntimeLogger !== 'closed-no-op-never-used-as-teardown-proof'
  || callerOwnedIntegrationLoggingPolicy.failedConnectRollback !== 'bounded-closeWithReport-primary-failure-preserved'
  || callerOwnedIntegrationLoggingPolicy.failedConnectError !== 'McpConnectionError-with-support-safe-failure-and-cleanup-report'
  || callerOwnedIntegrationLoggingPolicy.fieldContract !== 'core-observability.IntegrationOperationEvidenceFields'
  || callerOwnedIntegrationLoggingPolicy.runtimeActiveLogLevels !== 'start-success-info-failure-error'
  || callerOwnedIntegrationLoggingPolicy.runtimeHealthProjection !== 'RuntimeObservationHealthSnapshot-integration-accepted-filtered-dropped-rejected'
  || callerOwnedIntegrationLoggingPolicy.completenessClaim !== 'only-when-zero-filtered-dropped-rejected-and-required-delivery-complete'
  || callerOwnedIntegrationLoggingPolicy.completenessReconciliation !== 'expected-operation-attempt-pairs-and-event-id-acks-plus-teardown-reports'
  || callerOwnedIntegrationLoggingPolicy.criticalDeliverySummary !== 'insufficient-for-normal-priority-integration-log-completeness'
  || callerOwnedIntegrationLoggingPolicy.healthCounterScope !== 'runtime-lifetime-cumulative-not-per-run-delivery-receipts'
  || callerOwnedIntegrationLoggingPolicy.baseDiagnosticRing !== 'evictable-support-view-never-complete-audit-log'
  || callerOwnedIntegrationLoggingPolicy.absentLogger !== 'supported-no-implicit-console-sink'
  || callerOwnedIntegrationLoggingPolicy.correlationAuthority !== 'runtime-generated-not-integration-overridable'
  || callerOwnedIntegrationLoggingPolicy.cleanupFailure !== 'support-safe-report-never-replaces-primary-failure') {
  fail('caller-owned integration logging policy drifted')
}
const integrationFieldBounds = callerOwnedIntegrationLoggingPolicy.fieldBounds
if (integrationFieldBounds.integrationFamilyMaxChars !== 64
  || integrationFieldBounds.integrationOperationMaxChars !== 64
  || integrationFieldBounds.operationOrAttemptIdMaxChars !== 128
  || integrationFieldBounds.errorCodeMaxChars !== 128
  || integrationFieldBounds.attemptNumberMinimum !== 1
  || integrationFieldBounds.durationMs !== 'finite-nonnegative'
  || integrationFieldBounds.message !== 'static-no-user-data') {
  fail('caller-owned integration evidence field bounds drifted')
}
const integrationCoreDeclaration = readFileSync(
  join(contractRoot, 'packages/core/index.d.ts'),
  'utf8',
)
for (const fragment of [
  'export type IntegrationOperationEvidenceFields =',
  "readonly kind: 'logical-start'",
  "readonly kind: 'attempt-start'",
  "readonly kind: 'attempt-terminal'",
  "readonly kind: 'logical-terminal'",
  'readonly attemptNumber: number',
  'readonly status: OperationStatus',
  'readonly durationMs: number',
  'readonly errorCode?: string',
  'export interface RuntimeObservationHealthSnapshot extends ObservationHealthSnapshot',
  'readonly integrationEvidence:',
  'readonly filtered: number',
  'readonly dropped: number',
  'readonly rejected: number',
]) {
  if (!integrationCoreDeclaration.includes(fragment)) {
    fail(`integration operation evidence declaration lacks '${fragment}'`)
  }
}
if ((integrationCoreDeclaration.match(
  /readonly observationHealth: RuntimeObservationHealthSnapshot/g,
) ?? []).length !== 2) {
  fail('runtime diagnostics and close reports must use integration-aware health')
}
assertSameSet(
  'caller-owned integration logger coverage',
  new Set(callerOwnedIntegrationLoggingPolicy.coveredIntegrations),
  new Set([
    'mcp-http-client',
    'mcp-stdio-client',
    'mcp-web-server',
    'mcp-stdio-server',
    'a2a-client-link',
    'a2a-server',
  ]),
)
assertSameSet(
  'caller-owned integration operation families',
  new Set(Object.keys(callerOwnedIntegrationLoggingPolicy.operationEvidence)),
  new Set(callerOwnedIntegrationLoggingPolicy.coveredIntegrations),
)
const expectedIntegrationOperations = new Set([
  'mcp-http-client=connect',
  'mcp-http-client=authenticate',
  'mcp-http-client=catalog-refresh',
  'mcp-http-client=reconnect',
  'mcp-http-client=tool-call',
  'mcp-http-client=close',
  'mcp-stdio-client=connect',
  'mcp-stdio-client=catalog-refresh',
  'mcp-stdio-client=reconnect',
  'mcp-stdio-client=tool-call',
  'mcp-stdio-client=close',
  'mcp-web-server=request',
  'mcp-web-server=tool-call',
  'mcp-web-server=agent-call',
  'mcp-stdio-server=request',
  'mcp-stdio-server=tool-call',
  'mcp-stdio-server=agent-call',
  'mcp-stdio-server=close',
  'a2a-client-link=agent-card-resolve',
  'a2a-client-link=link',
  'a2a-client-link=send',
  'a2a-client-link=stream',
  'a2a-client-link=unlink',
  'a2a-server=request',
  'a2a-server=execute',
  'a2a-server=cancel',
  'a2a-server=dispose',
])
const integrationOperations = Object.entries(callerOwnedIntegrationLoggingPolicy.operationEvidence)
  .flatMap(([family, operations]) => operations.map(operation => `${family}=${operation}`))
if (new Set(integrationOperations).size !== integrationOperations.length) {
  fail('caller-owned integration operation evidence contains duplicates')
}
assertSameSet(
  'caller-owned integration operation evidence',
  new Set(integrationOperations),
  expectedIntegrationOperations,
)
assertSameSet(
  'caller-owned integration correlation channels',
  new Set(Object.entries(callerOwnedIntegrationLoggingPolicy.correlationChannels)
    .map(([operation, source]) => `${operation}=${source}`)),
  new Set([
    'mcp-client-lifecycle=connection-options-logger',
    'mcp-tool-call=runtime-tool-run-context-logger',
    'mcp-server-request=server-options-logger-child',
    'a2a-link-lifecycle=link-options-logger',
    'a2a-send=runtime-team-linked-send-input-logger',
    'a2a-server-request=executor-options-logger-child-and-agent-run-context',
  ]),
)
assertSameSet(
  'caller-owned post-runtime teardown evidence',
  new Set(Object.entries(callerOwnedIntegrationLoggingPolicy.postRuntimeTeardownEvidence)
    .map(([operation, report]) => `${operation}=${report}`)),
  new Set([
    'mcp-http-client.close=McpCloseReport',
    'mcp-stdio-client.close=McpCloseReport',
    'mcp-stdio-server.close=McpNodeServerCloseReport',
    'a2a-client-link.unlink=A2AUnlinkReport',
    'a2a-server.dispose=A2ADisposeReport',
  ]),
)
const providerRouteClaimPolicy = topology.providerRouteClaimPolicy
if (providerRouteClaimPolicy.normalRuntimeInput !== 'composable-model-provider-plugin'
  || providerRouteClaimPolicy.legacyPluginSurface !== 'advanced-registry-only'
  || providerRouteClaimPolicy.claimVisibility !== 'inert-routes-before-setup'
  || providerRouteClaimPolicy.preflightOrder !== 'all-plugin-ids-and-routes-before-any-setup'
  || providerRouteClaimPolicy.helperRegistrar !== 'scoped-to-declared-route-claims'
  || providerRouteClaimPolicy.setupCoverage !== 'every-claim-registered-exactly-once-by-return'
  || providerRouteClaimPolicy.undeclaredRegistration !== 'reject-and-rollback'
  || providerRouteClaimPolicy.routeMutation !== 'setup-and-runtime-owned-rollback-close-within-claims-only') {
  fail('provider route claim/preflight policy drifted')
}
const skillReferencePolicy = topology.skillReferencePolicy
if (skillReferencePolicy.catalogShape !== 'opaque-revision-plus-candidates'
  || skillReferencePolicy.referenceCreation !== 'runtime-stamps-candidate-with-catalog-revision'
  || skillReferencePolicy.locatorType !== 'bounded-json-value'
  || skillReferencePolicy.candidateProvider !== 'must-equal-skill-provider-id'
  || skillReferencePolicy.loadAndResourceInput !== 'exact-skill-reference'
  || skillReferencePolicy.resumeValidation !== 'schema-bounds-provider-identity-then-provider-validation'
  || skillReferencePolicy.unavailableReference !== 'fail-closed-before-model-or-resource-use'
  || skillReferencePolicy.snapshotContent !== 'reference-only-no-loaded-instructions-or-resource-content'
  || skillReferencePolicy.locatorInDiagnostics !== false
  || skillReferencePolicy.resourcePathValidation !== 'provider-relative-bounded-no-traversal') {
  fail('skill catalog/reference resume policy drifted')
}
const toolSourceSnapshotPolicy = topology.toolSourceSnapshotPolicy
if (toolSourceSnapshotPolicy.acquisition !== 'synchronous-once-per-source-per-agent-invocation'
  || toolSourceSnapshotPolicy.signal !== 'required-before-source-method-access'
  || toolSourceSnapshotPolicy.revision !== 'bounded-nonempty-string'
  || toolSourceSnapshotPolicy.payload !== 'bounded-tool-definitions'
  || toolSourceSnapshotPolicy.toolMethodCapture !== 'identity-schema-and-executable-references-from-one-snapshot'
  || toolSourceSnapshotPolicy.refresh !== 'source-owned-explicit-visible-next-invocation'
  || toolSourceSnapshotPolicy.compatibilityCatalog !== 'direct-caller-only-core-never-reads'
  || toolSourceSnapshotPolicy.snapshotFailure !== 'fail-invocation-no-implicit-stale-fallback'
  || toolSourceSnapshotPolicy.terminalEvidence !== 'source-id-and-revision-per-run'
  || toolSourceSnapshotPolicy.catalogContentInDiagnosticsOrReports !== false) {
  fail('tool-source atomic snapshot policy drifted')
}
const localToolDefinitionPolicy = topology.localToolDefinitionPolicy
if (localToolDefinitionPolicy.marker !== 'none-core-owned-leaf-contract'
  || localToolDefinitionPolicy.directObjectLiteral !== 'allowed-runtime-captures'
  || localToolDefinitionPolicy.defineTool !== 'side-effect-free-new-frozen-wrapper'
  || localToolDefinitionPolicy.callerObjectMutationOrFreeze !== false
  || localToolDefinitionPolicy.captureAt !== 'runtime-agent-or-session-binding-before-model-dispatch'
  || localToolDefinitionPolicy.methodReceiver !== 'original-tool-definition'
  || localToolDefinitionPolicy.rereadAfterCapture !== false
  || localToolDefinitionPolicy.postCaptureMutation !== 'no-effect-on-bound-tool'
  || localToolDefinitionPolicy.collisionScope !== 'one-agent-invocation-local-plus-source-tools') {
  fail('local tool definition capture policy drifted')
}
assertSameSet(
  'local tool captured fields',
  new Set(localToolDefinitionPolicy.capturedFields),
  new Set([
    'name',
    'description',
    'parameters-detached-bounded-snapshot',
    'parse',
    'execute',
    'render',
    'meta',
    'timeoutMs',
    'isConcurrencySafe',
  ]),
)
const nativeToolPolicy = topology.nativeToolPolicy
if (nativeToolPolicy.vocabulary !== 'merge-extensible-native-tool-schema-map'
  || nativeToolPolicy.arbitraryUnknownIndexSignature !== false
  || nativeToolPolicy.configuration !== 'bounded-deep-detached-json-safe'
  || nativeToolPolicy.captureAt !== 'agent-definition-before-model-resolution'
  || nativeToolPolicy.modelCapability !== 'absent-unknown-explicit-list-is-allowlist'
  || nativeToolPolicy.executionOwner !== 'provider-not-host-tool-scheduler'
  || nativeToolPolicy.approvalPipeline !== 'not-host-tool-approval-use-provider-policy'
  || nativeToolPolicy.toolChoice !== 'typed-host-or-native-discriminated-union'
  || nativeToolPolicy.progressEvents !== 'distinct-correlated-assistant-native-tool'
  || nativeToolPolicy.progressPayload !== 'bounded-json-value-caller-stream-content-not-default-observation'
  || nativeToolPolicy.postCaptureMutation !== 'no-effect-on-bound-agent') {
  fail('provider-native tool composition policy drifted')
}
assertSameSet(
  'provider-native built-in tools',
  new Set(nativeToolPolicy.builtins),
  new Set(['web-search', 'image-generation']),
)
const wireRequestBodyPolicy = topology.wireRequestBodyPolicy
if (wireRequestBodyPolicy.v1BodyKind !== 'json-object-only'
  || wireRequestBodyPolicy.serialization !== 'synchronous-pure-protocol-method'
  || wireRequestBodyPolicy.validation !== 'finite-json-deep-detached-bounded-before-dispatch'
  || wireRequestBodyPolicy.encodeAt !== 'once-per-prepared-logical-call'
  || wireRequestBodyPolicy.physicalRetryBody !== 'reuse-identical-encoded-bytes'
  || wireRequestBodyPolicy.contentType !== 'application-json-transport-owned'
  || wireRequestBodyPolicy.unsupportedValue !== 'stable-pre-dispatch-failure-no-provider-attempt'
  || wireRequestBodyPolicy.defaultObservationBody !== false
  || wireRequestBodyPolicy.compatibilityWireLogger !== 'explicit-high-risk-bounded-exact-json-body-redacted-headers') {
  fail('HTTP wire request body policy drifted')
}
const sseTransportPolicy = topology.sseTransportPolicy
if (sseTransportPolicy.owner !== 'provider-http-not-core-or-protocol-package'
  || sseTransportPolicy.parserDependency !== 'exact-eventsource-parser-4.1.0-under-adr-0001'
  || sseTransportPolicy.mediaType !== 'text-event-stream-required-parameters-allowed-before-parser'
  || sseTransportPolicy.utf8 !== 'whatwg-streaming-replacement-semantics'
  || sseTransportPolicy.activity !== 'every-nonempty-body-read-including-comment-heartbeats'
  || sseTransportPolicy.idleDeadline !== 'single-resettable-deadline-per-physical-attempt'
  || sseTransportPolicy.eventCount !== 'configurable-default-100000'
  || sseTransportPolicy.eventBufferChars !== 'configurable-default-1048576'
  || sseTransportPolicy.queueDrain !== 'linear-cursor-never-array-shift'
  || sseTransportPolicy.reconnect !== 'never-parser-retry-field-ignored'
  || sseTransportPolicy.terminal !== 'exactly-one-finish-last-eof-before-finish-stream-closed'
  || sseTransportPolicy.retryAfterOutput !== 'forbidden'
  || sseTransportPolicy.teardown !== 'bounded-cancel-primary-failure-preserved') {
  fail('HTTP SSE transport policy drifted')
}
const edgeWebDeploymentPolicy = topology.edgeWebDeploymentPolicy
if (edgeWebDeploymentPolicy.defaultExecutionOwner !== 'edge-worker'
  || edgeWebDeploymentPolicy.browserDefaultSdkPackages !== 'none-static-sse-client'
  || edgeWebDeploymentPolicy.providerCredentials !== 'worker-injected-never-browser-originated-or-returned'
  || edgeWebDeploymentPolicy.principalSource !== 'trusted-host-auth-context-never-request-json'
  || edgeWebDeploymentPolicy.conversationAuthorization !== 'principal-plus-conversation-id-or-server-issued-opaque-handle'
  || edgeWebDeploymentPolicy.hermeticPrincipal !== 'explicit-fixed-test-principal-only'
  || edgeWebDeploymentPolicy.sessionIdentity !== 'one-session-per-principal-conversation-mode-excluded'
  || edgeWebDeploymentPolicy.deepSearchActivation !== 'host-mapped-bounded-run-scoped-additional-instructions'
  || edgeWebDeploymentPolicy.deepSearchExecution !== 'agent-instruction-driven-adaptive-not-host-workflow'
  || edgeWebDeploymentPolicy.forwardRequestInstructions !== false
  || edgeWebDeploymentPolicy.concurrentRun !== 'stable-409-without-second-run'
  || edgeWebDeploymentPolicy.cancellation !== 'owned-controller-combines-request-abort-response-cancel-and-runtime-close'
  || edgeWebDeploymentPolicy.disconnectSettlement !== 'abort-and-bounded-await-no-surviving-provider-or-tool-operation'
  || edgeWebDeploymentPolicy.eventEnvelope !== 'schema-version-run-id-monotonic-sequence-type'
  || edgeWebDeploymentPolicy.terminal !== 'exactly-one-complete-failed-or-aborted-with-run-report'
  || edgeWebDeploymentPolicy.errorExposure !== 'support-safe-code-stage-message-no-raw-thrown-error'
  || edgeWebDeploymentPolicy.toolProjection !== 'explicit-public-json-safe-bounded'
  || edgeWebDeploymentPolicy.eofWithoutTerminal !== 'client-visible-incomplete-never-success'
  || edgeWebDeploymentPolicy.automaticReplay !== 'forbidden-without-explicit-resume-protocol'
  || edgeWebDeploymentPolicy.requestBoundary !== 'same-origin-default-bounded-json-before-agent-admission'
  || edgeWebDeploymentPolicy.credentialedAcceptance !== 'owner-authorized-targeted') {
  fail('Edge website deployment/session/stream policy drifted')
}
const runInstructionPolicy = topology.runInstructionPolicy
if (runInstructionPolicy.surface !== 'optional-host-owned-string'
  || runInstructionPolicy.maxUtf8Bytes !== 65536
  || runInstructionPolicy.validation !== 'synchronous-before-run-admission-history-ledger-or-capability-method'
  || runInstructionPolicy.emptyOrWhitespace !== 'stable-rejection'
  || runInstructionPolicy.contentNormalization !== 'none-preserve-exact-captured-string'
  || runInstructionPolicy.capture !== 'once-at-run-admission'
  || runInstructionPolicy.systemOrder !== 'agent-skill-catalog-team-run-overlay-core-mode'
  || runInstructionPolicy.application !== 'every-model-request-in-run-including-retry-and-post-compaction'
  || runInstructionPolicy.persistence !== 'never-history-memory-snapshot-resume-or-later-run'
  || runInstructionPolicy.manualCompaction !== 'base-instructions-only-outside-run'
  || runInstructionPolicy.privacy !== 'provider-request-only-no-default-observation-diagnostics-error-or-artifact'
  || runInstructionPolicy.accounting !== 'included-in-provider-input-usage-and-local-estimation-request'
  || runInstructionPolicy.retry !== 'reuse-exact-captured-overlay'
  || runInstructionPolicy.sessionIdentity !== 'unchanged-agent-session-conversation-and-memory-binding'
  || runInstructionPolicy.authority !== 'not-auth-approval-tool-or-resource-policy'
  || runInstructionPolicy.untrustedTransportForwarding !== false
  || runInstructionPolicy.errorCode !== 'RUN_ADDITIONAL_INSTRUCTIONS_INVALID') {
  fail('run-scoped additional instruction policy drifted')
}
const runHandleCancellationPolicy = topology.runHandleCancellationPolicy
if (runHandleCancellationPolicy.execution !== 'eager-at-stream-call-single-consumer-events'
  || runHandleCancellationPolicy.identity !== 'stable-run-id-before-first-event'
  || runHandleCancellationPolicy.abort !== 'synchronous-idempotent-owned-controller-signal'
  || runHandleCancellationPolicy.abortReason !== 'never-raw-observed-serialized-or-used-as-support-message'
  || runHandleCancellationPolicy.afterTerminal !== 'abort-noop'
  || runHandleCancellationPolicy.iteratorEarlyReturn !== 'abort-and-bounded-settle'
  || runHandleCancellationPolicy.result !== 'resolve-success-reject-stable-agent-run-error-with-report'
  || runHandleCancellationPolicy.report !== 'independently-awaitable-on-success-error-or-abort'
  || runHandleCancellationPolicy.eventTerminal !== 'exactly-one-usage-or-support-safe-error-with-same-report'
  || runHandleCancellationPolicy.idle !== 'session-idle-only-after-result-report-and-event-stream-settled'
  || runHandleCancellationPolicy.unhandledRejection !== 'internally-contained-without-hiding-caller-promises'
  || runHandleCancellationPolicy.errorCode !== 'AGENT_RUN_ABORTED') {
  fail('agent run-handle cancellation/settlement policy drifted')
}
const invocationObserverPolicy = topology.invocationObserverPolicy
if (invocationObserverPolicy.surface !== 'preserved-agent-invocation-options-on-event'
  || invocationObserverPolicy.runAndGenerate !== 'drain-handle-sequentially-await-observer-before-next-event'
  || invocationObserverPolicy.stream !== 'callback-not-invoked-caller-consumes-handle'
  || invocationObserverPolicy.compact !== 'callback-not-invoked-no-run-events'
  || invocationObserverPolicy.timeout !== 'runtime-limit-observer-timeout-default-30000ms'
  || invocationObserverPolicy.failure !== 'abort-run-settle-and-reject-convenience-method-stable-error'
  || invocationObserverPolicy.report !== 'canonical-report-remains-attached-and-independently-accounted'
  || invocationObserverPolicy.privacy !== 'raw-callback-failure-not-support-message-or-observation-content'
  || invocationObserverPolicy.durability !== 'application-observer-not-observation-exporter-or-ack'
  || invocationObserverPolicy.errorCode !== 'AGENT_EVENT_OBSERVER_FAILED') {
  fail('agent invocation observer policy drifted')
}
const targetApiParityPolicy = topology.targetApiParityPolicy
if (targetApiParityPolicy.status !== 'pending-target-declaration-coverage'
  || targetApiParityPolicy.defaultAction !== 'preserve-unless-explicit-approved-removal'
  || targetApiParityPolicy.inventory !== 'exact-sorted-missing-symbol-count-and-sha256'
  || targetApiParityPolicy.phase0ApprovalRequiresZeroMissing !== true) {
  fail('target API parity policy drifted')
}
const observabilityCompatibilityPolicy = topology.observabilityCompatibilityPolicy
if (observabilityCompatibilityPolicy.advancedSpecifier !== '@ai-agent-sdk/core/observability'
  || observabilityCompatibilityPolicy.legacySurface !== 'preserve-current-names-and-source-assignability'
  || observabilityCompatibilityPolicy.legacyExporter !== 'marker-free-caller-owned-observation-bus'
  || observabilityCompatibilityPolicy.runtimeExporter !== 'marker-based-observation-exporter-plugin'
  || observabilityCompatibilityPolicy.runtimeRegistration !== 'explicit-owned-or-borrowed'
  || observabilityCompatibilityPolicy.eventEnvelope !== 'preserve-current-correlated-schema-v1'
  || observabilityCompatibilityPolicy.resourceIdentity !== 'preserve-sdk-name-runtime-and-add-new-fields-optional'
  || observabilityCompatibilityPolicy.deliveryBatch !== 'new-name-with-atomic-run-terminal-records'
  || observabilityCompatibilityPolicy.deliveryAck !== 'new-name-with-event-and-run-id-acknowledgment'
  || observabilityCompatibilityPolicy.sameNameSemanticRepurpose !== false
  || observabilityCompatibilityPolicy.signatureEvidence !== 'compile-current-module-against-target-advanced-subpath') {
  fail('advanced/runtime observability compatibility policy drifted')
}
const observabilityCapabilityPolicy = topology.observabilityCapabilityCompatibilityPolicy
if (observabilityCapabilityPolicy.advancedExporters
    !== 'preserve-marker-free-classes-and-lifecycle-controls'
  || observabilityCapabilityPolicy.runtimeFactories
    !== 'additive-adapters-not-same-name-repurposing'
  || observabilityCapabilityPolicy.sameNameSemanticRepurpose !== false
  || observabilityCapabilityPolicy.source
    !== 'consumers/observability-capability-api-compatibility.ts'
  || observabilityCapabilityPolicy.currentConfig
    !== 'tsconfig.current-observability-capabilities.json'
  || observabilityCapabilityPolicy.targetConfig !== 'tsconfig.json'
  || observabilityCapabilityPolicy.evidence !== 'same-source-dual-current-target-compile') {
  fail('observability capability compatibility policy drifted')
}
assertSameSet(
  'observability capability focused core types',
  new Set(observabilityCapabilityPolicy.focusedCoreTypes),
  new Set(['JsonObject', 'JsonValue']),
)
assertSameSet(
  'observability capability compatibility entrypoints',
  new Set(observabilityCapabilityPolicy.entrypoints),
  new Set([
    '@ai-agent-sdk/observability-fetch',
    '@ai-agent-sdk/observability-browser',
    '@ai-agent-sdk/observability-node',
    '@ai-agent-sdk/observability-node/journal',
    '@ai-agent-sdk/observability-node/diagnostic',
    '@ai-agent-sdk/observability-otel',
  ]),
)
const observabilityCapabilitySource = readFileSync(
  join(contractRoot, observabilityCapabilityPolicy.source),
  'utf8',
)
for (const entrypoint of observabilityCapabilityPolicy.entrypoints) {
  const baseline = retainedPackageApiBaseline.sources[entrypoint]
  if (baseline === undefined) fail(`observability capability lacks baseline '${entrypoint}'`)
  for (const symbol of baseline.exports) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`\\b${escaped}\\b`).test(observabilityCapabilitySource)) {
      fail(`observability capability fixture does not cover '${entrypoint}:${symbol}'`)
    }
  }
}
const focusedObservabilityDeclaration = readFileSync(
  join(contractRoot, 'packages/core/observability.d.ts'),
  'utf8',
)
for (const typeName of observabilityCapabilityPolicy.focusedCoreTypes) {
  if (!new RegExp(`\\b${typeName}\\b`).test(focusedObservabilityDeclaration)) {
    fail(`core/observability does not expose package-author type '${typeName}'`)
  }
}
for (const typeName of [
  'IntegrationOperationEvidenceFields',
  'RuntimeObservationHealthSnapshot',
]) {
  if (!focusedObservabilityDeclaration.includes(typeName)) {
    fail(`core/observability does not expose integration evidence type '${typeName}'`)
  }
}

}
// @ts-nocheck
