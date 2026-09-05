import type { JourneyRule, PackageRule, RemovalMigrationRule } from './types.mts'

export interface Topology {
  readonly modelDefaultsPolicy: Readonly<Record<string, string>>
  readonly schemaVersion: 5
  readonly manifestPolicy: {
    readonly moduleFormat: 'esm-only'
    readonly type: 'module'
    readonly sideEffects: false
    readonly privateUntilPublicationConfigured: true
    readonly basePackedFiles: readonly string[]
    readonly additionalPackedFiles: Readonly<Record<string, readonly string[]>>
    readonly binaryEntrypoints: Readonly<Record<string, Readonly<Record<string, string>>>>
    readonly legacyRootFields: 'mirror-root-import-and-types'
    readonly nodeEngineScope: 'node-runtime-packages-only'
    readonly requiredExportConditions: readonly string[]
    readonly forbiddenExportConditions: readonly string[]
    readonly includePackageJsonExport: true
    readonly forbidUndeclaredDeepImports: true
    readonly dependencyEncoding: {
      readonly normalWorkspaceDependencies: 'dependencies-workspace-caret'
      readonly corePeer: 'peerDependencies-workspace-caret-plus-devDependency'
      readonly optionalWorkspacePeers: 'peerDependencies-workspace-caret-plus-peerDependenciesMeta-optional'
      readonly externalRuntimeDependencies: 'dependencies-catalog-exact'
      readonly requiredExternalRuntimePeers: 'peerDependencies-compatible-range-plus-dev-catalog-exact'
      readonly optionalExternalRuntimePeers: 'peerDependencies-compatible-range-plus-meta-optional-plus-dev-catalog-exact'
    }
    readonly capabilityMetadata: {
      readonly field: 'aiAgentSdk'
      readonly runtime: 'from-package-rule'
      readonly coreApi: 1
      readonly rolesField: 'roles'
      readonly nonExecutable: true
      readonly allowedRoles: readonly string[]
    }
    readonly blueprint: 'manifest-blueprints.json'
    readonly blueprintPackages: readonly string[]
    readonly corePeerRange: string
    readonly nodeEngine: string
  }
  readonly automatedEvidencePolicy: {
    readonly allowed: readonly string[]
    readonly manualOnly: readonly string[]
    readonly knownBroadCommandHazards: Readonly<Record<string, readonly string[]>>
    readonly quarantinedHistoricalTests: Readonly<Record<string, readonly string[]>>
    readonly broadCommandsAllowedForAi: boolean
  }
  readonly capabilityObjectPolicy: {
    readonly families: readonly string[]
    readonly helperReturnsNewWrapper: true
    readonly helperResultFrozen: true
    readonly runtimeMutatesCallerObject: false
    readonly captureAtPreflight: readonly string[]
    readonly rereadIdentityAfterPreflight: false
    readonly rereadMethodsAfterPreflight: false
    readonly captureReturnedCleanupImmediately: true
    readonly capabilityOwnedStateMayMutate: true
    readonly dynamicDataChangesThroughFamilyMethodsOnly: true
    readonly hostileProxyIsSecurityBoundary: false
  }
  readonly providerLifecyclePolicy: {
    readonly setup: 'synchronous-only'
    readonly cleanup: 'synchronous-only'
    readonly asyncResult: 'reject-and-contain'
    readonly registrarAfterSetup: 'sealed'
    readonly topologyRemovalBeforeCleanup: true
    readonly startedCleanupCanBePreemptedByDeadline: false
  }
  readonly coreIdentityPolicy: {
    readonly officialPackedClosure: 'single-physical-core-resolution'
    readonly runtimeCoreNormalDependency: 'forbidden'
    readonly crossPackageProtocolValidation: 'structural-family-marker-and-validated-data'
    readonly crossPackageInstanceofGate: 'forbidden'
    readonly modelAdapterClassRole: 'authoring-convenience-not-runtime-nominal-gate'
    readonly foreignFailurePolicy: 'validated-data-envelope'
    readonly globalDuplicateCoreDetector: 'forbidden'
    readonly publicReexports: 'canonical-value-identity'
    readonly currentNominalBoundaryInventory: Readonly<
      Record<string, Readonly<Record<string, number>>>
    >
  }
  readonly coreRootFacadePolicy: {
    readonly canonicalDeclaration: 'packages/core/index.d.ts'
    readonly publicRootDeclaration: 'packages/core/root.d.ts'
    readonly canonicalOwnerVisibility: 'internal-not-package-export'
    readonly normalApplicationImports: 'curated-root'
    readonly packageAuthorImports: 'focused-subpaths'
    readonly currentCoreBaselineCount: 184
    readonly expectedRootExportCount: 264
    readonly ergonomicAdditions: readonly string[]
  }
  readonly httpHeaderPolicy: {
    readonly normalization: 'lowercase-case-insensitive'
    readonly merge: 'reject-cross-layer-collision'
    readonly layers: readonly string[]
    readonly transportReserved: readonly string[]
    readonly sdkReservedHeaders: readonly string[]
    readonly sdkReservedPrefixes: readonly string[]
    readonly endpointStaticSensitiveHeaders: 'forbidden-use-auth-scheme'
    readonly authenticationHeadersSensitiveByProvenance: true
    readonly wireLogRedaction: 'auth-provenance-plus-sensitive-name-policy'
    readonly credentialResolution: 'once-per-prepared-logical-call'
    readonly retryCredentialBehavior: 'reuse-prepared-connection-snapshot'
    readonly crossOriginCredentialForwarding: false
    readonly redirectValidation: 'before-each-hop'
  }
  readonly modelCatalogPolicy: {
    readonly cacheScope: 'provider-plugin-instance-and-route'
    readonly states: readonly string[]
    readonly staticModelsBypassDiscovery: true
    readonly failureStoredAsSuccessfulEmpty: false
    readonly lastGoodSnapshotPreservedOnFailure: true
    readonly concurrentRefresh: 'singleflight-per-cache-key'
    readonly callerAbort: 'detach-waiter-without-aborting-other-waiters'
    readonly allWaitersAbort: 'abort-shared-refresh'
    readonly failureBackoff: 'bounded-configurable-separate-from-success-ttl'
    readonly defaultFreshTtlMs: 300000
    readonly defaultStaleTtlMs: 0
    readonly defaultFailureBackoffMs: 5000
    readonly maxFailureBackoffMs: 60000
    readonly explicitModelInvocationRequiresCatalogMembership: false
    readonly accountSwitchRequiresNewProviderInstance: true
    readonly highLevelRuntimeSurface: readonly string[]
  }
  readonly providerDiscoveryIdentityPolicy: {
    readonly rowScope: 'one-row-per-route'
    readonly modelTargetKey: 'route'
    readonly instanceKey: 'pluginId'
    readonly familyKey: 'family'
    readonly officialFamily: 'fixed-by-provider-package'
    readonly customFamilyFallback: 'plugin-id'
    readonly legacyAliases: { readonly id: 'route'; readonly name: 'adapter-display-name' }
    readonly multiRoutePlugin: 'rows-share-plugin-id-and-family'
    readonly catalogLookupKey: 'route'
    readonly credentialDerivedIdentityForbidden: true
  }
  readonly officialProviderFactoryPolicy: {
    readonly normalInstall: 'core-plus-one-official-provider'
    readonly supportPackages: 'transitive-hidden-from-normal-consumer-imports'
    readonly factory: 'synchronous-side-effect-free-no-credential-resolution-or-io'
    readonly defaultInstanceId: 'provider-family'
    readonly defaultRoutes: 'single-instance-id-route'
    readonly explicitRoutes: 'nonempty-unique-alias-claims'
    readonly customInstanceErgonomics: 'id-alone-selects-default-route'
    readonly pluginOptions: 'adapter-options-plus-id-routes-and-injected-fetch'
    readonly providerSpecificOptions: 'preserved-through-recommended-plugin-factory'
    readonly credentialOwnership: 'required-injected-web-safe-capability-no-env-read'
    readonly advancedAdapter: 'retained-but-not-required-for-normal-composition'
    readonly family: 'fixed-by-official-package-not-user-configurable'
    readonly instanceScopedPromptCacheKey: 'never-described-as-conversation-boundary'
  }
  readonly additiveCapabilityCompositionPolicy: {
    readonly normalShape: 'named-factory-or-explicit-connect-then-typed-slot'
    readonly skillFilesystem: 'preserved-advanced-plus-versioned-lazy-borrowed-plugin-node'
    readonly mcpConnection: 'async-connected-borrowed-tool-source-caller-close'
    readonly observationExporter: 'inert-exporter-explicit-owned-or-borrowed-registration'
    readonly openTelemetry: 'caller-owned-bridge-open-span-plus-processor-not-exporter'
    readonly openTelemetryProviderShutdown: 'caller-owned-never-runtime'
    readonly factoryOptions: 'preserve-operational-bounds-and-injected-host-functions'
    readonly runtimeElevation: 'selected-capability-package-not-core'
    readonly implicitEnvironmentOrFilesystem: false
    readonly catchAllPluginArray: false
  }
  readonly capabilityOperationLoggingPolicy: {
    readonly coreLifecycleEvidence: 'start-terminal-error-independent-of-plugin-logging'
    readonly requiredBoundLoggerContexts: readonly string[]
    readonly legacyOptionalLoggerContexts: readonly string[]
    readonly exporterLoggerInjection: 'forbidden-recursion-boundary'
    readonly correlationAuthority: 'runtime-generated-not-plugin-overridable'
    readonly sensitiveFields: 'credentials-content-and-raw-errors-forbidden'
    readonly accountingAuthority: 'terminal-ledger-never-plugin-log'
    readonly loggerFailure: 'contained-observation-health-never-primary-operation-error'
  }
  readonly callerOwnedIntegrationLoggingPolicy: {
    readonly bootstrapOrder: 'runtime-then-connect-with-bound-logger'
    readonly cleanupOrder: 'runtime-quiesce-close-before-integration-close'
    readonly loggerOption: 'optional-for-advanced-direct-use-required-in-recommended-runtime-journeys'
    readonly coveredIntegrations: readonly string[]
    readonly operationEvidence: Readonly<Record<string, readonly string[]>>
    readonly correlationChannels: Readonly<Record<string, string>>
    readonly evidenceShape: 'runtime-active-one-start-and-one-terminal-per-logical-operation-with-support-safe-error'
    readonly physicalAttemptEvidence: 'every-network-or-process-attempt-linked-to-logical-operation'
    readonly accountingRole: 'operational-only-never-token-or-billing-authority'
    readonly contentPolicy: 'metadata-only-no-credentials-headers-bodies-prompts-results-or-card-content'
    readonly postRuntimeTeardownEvidence: Readonly<Record<string, string>>
    readonly postRuntimeLogger: 'closed-no-op-never-used-as-teardown-proof'
    readonly failedConnectRollback: 'bounded-closeWithReport-primary-failure-preserved'
    readonly failedConnectError: 'McpConnectionError-with-support-safe-failure-and-cleanup-report'
    readonly fieldContract: 'core-observability.IntegrationOperationEvidenceFields'
    readonly fieldBounds: {
      readonly integrationFamilyMaxChars: 64
      readonly integrationOperationMaxChars: 64
      readonly operationOrAttemptIdMaxChars: 128
      readonly errorCodeMaxChars: 128
      readonly attemptNumberMinimum: 1
      readonly durationMs: 'finite-nonnegative'
      readonly message: 'static-no-user-data'
    }
    readonly runtimeActiveLogLevels: 'start-success-info-failure-error'
    readonly runtimeHealthProjection: 'RuntimeObservationHealthSnapshot-integration-accepted-filtered-dropped-rejected'
    readonly completenessClaim: 'only-when-zero-filtered-dropped-rejected-and-required-delivery-complete'
    readonly completenessReconciliation: 'expected-operation-attempt-pairs-and-event-id-acks-plus-teardown-reports'
    readonly criticalDeliverySummary: 'insufficient-for-normal-priority-integration-log-completeness'
    readonly healthCounterScope: 'runtime-lifetime-cumulative-not-per-run-delivery-receipts'
    readonly baseDiagnosticRing: 'evictable-support-view-never-complete-audit-log'
    readonly absentLogger: 'supported-no-implicit-console-sink'
    readonly correlationAuthority: 'runtime-generated-not-integration-overridable'
    readonly cleanupFailure: 'support-safe-report-never-replaces-primary-failure'
  }
  readonly recommendedCompositionEntrypoints: Readonly<Record<string, {
    readonly specifier: string
    readonly symbol: string
    readonly compositionPoint:
      | 'runtime.providers'
      | 'provider-author.adapter'
      | 'provider-author.protocol'
      | 'runtime-agent.toolSources'
      | 'host.mcp-server'
      | 'runtime-agent.skills'
      | 'runtime.observability.exporters'
      | 'runtime.observability.openSpan-processors'
      | 'provider-factory.credentials'
      | 'runtime-team.linkAgent'
    readonly lifecycle:
      | 'inert-runtime-owned-registration'
      | 'inert-value'
      | 'connected-caller-owned'
      | 'inert-host-mounted'
      | 'host-owned'
      | 'borrowed-caller-owned'
      | 'explicit-owned-or-borrowed'
    readonly audience: 'application' | 'authoring-support'
    readonly proofFile: string
    readonly proofFragments: readonly string[]
  }>>
  readonly providerRouteClaimPolicy: {
    readonly normalRuntimeInput: 'composable-model-provider-plugin'
    readonly legacyPluginSurface: 'advanced-registry-only'
    readonly claimVisibility: 'inert-routes-before-setup'
    readonly preflightOrder: 'all-plugin-ids-and-routes-before-any-setup'
    readonly helperRegistrar: 'scoped-to-declared-route-claims'
    readonly setupCoverage: 'every-claim-registered-exactly-once-by-return'
    readonly undeclaredRegistration: 'reject-and-rollback'
    readonly routeMutation: 'setup-and-runtime-owned-rollback-close-within-claims-only'
  }
  readonly skillReferencePolicy: {
    readonly catalogShape: 'opaque-revision-plus-candidates'
    readonly referenceCreation: 'runtime-stamps-candidate-with-catalog-revision'
    readonly locatorType: 'bounded-json-value'
    readonly candidateProvider: 'must-equal-skill-provider-id'
    readonly loadAndResourceInput: 'exact-skill-reference'
    readonly resumeValidation: 'schema-bounds-provider-identity-then-provider-validation'
    readonly unavailableReference: 'fail-closed-before-model-or-resource-use'
    readonly snapshotContent: 'reference-only-no-loaded-instructions-or-resource-content'
    readonly locatorInDiagnostics: false
    readonly resourcePathValidation: 'provider-relative-bounded-no-traversal'
  }
  readonly toolSourceSnapshotPolicy: {
    readonly acquisition: 'synchronous-once-per-source-per-agent-invocation'
    readonly signal: 'required-before-source-method-access'
    readonly revision: 'bounded-nonempty-string'
    readonly payload: 'bounded-tool-definitions'
    readonly toolMethodCapture: 'identity-schema-and-executable-references-from-one-snapshot'
    readonly refresh: 'source-owned-explicit-visible-next-invocation'
    readonly compatibilityCatalog: 'direct-caller-only-core-never-reads'
    readonly snapshotFailure: 'fail-invocation-no-implicit-stale-fallback'
    readonly terminalEvidence: 'source-id-and-revision-per-run'
    readonly catalogContentInDiagnosticsOrReports: false
  }
  readonly localToolDefinitionPolicy: {
    readonly marker: 'none-core-owned-leaf-contract'
    readonly directObjectLiteral: 'allowed-runtime-captures'
    readonly defineTool: 'side-effect-free-new-frozen-wrapper'
    readonly callerObjectMutationOrFreeze: false
    readonly captureAt: 'runtime-agent-or-session-binding-before-model-dispatch'
    readonly capturedFields: readonly string[]
    readonly methodReceiver: 'original-tool-definition'
    readonly rereadAfterCapture: false
    readonly postCaptureMutation: 'no-effect-on-bound-tool'
    readonly collisionScope: 'one-agent-invocation-local-plus-source-tools'
  }
  readonly nativeToolPolicy: {
    readonly vocabulary: 'merge-extensible-native-tool-schema-map'
    readonly builtins: readonly string[]
    readonly arbitraryUnknownIndexSignature: false
    readonly configuration: 'bounded-deep-detached-json-safe'
    readonly captureAt: 'agent-definition-before-model-resolution'
    readonly modelCapability: 'absent-unknown-explicit-list-is-allowlist'
    readonly executionOwner: 'provider-not-host-tool-scheduler'
    readonly approvalPipeline: 'not-host-tool-approval-use-provider-policy'
    readonly toolChoice: 'typed-host-or-native-discriminated-union'
    readonly progressEvents: 'distinct-correlated-assistant-native-tool'
    readonly progressPayload: 'bounded-json-value-caller-stream-content-not-default-observation'
    readonly postCaptureMutation: 'no-effect-on-bound-agent'
  }
  readonly wireRequestBodyPolicy: {
    readonly v1BodyKind: 'json-object-only'
    readonly serialization: 'synchronous-pure-protocol-method'
    readonly validation: 'finite-json-deep-detached-bounded-before-dispatch'
    readonly encodeAt: 'once-per-prepared-logical-call'
    readonly physicalRetryBody: 'reuse-identical-encoded-bytes'
    readonly contentType: 'application-json-transport-owned'
    readonly unsupportedValue: 'stable-pre-dispatch-failure-no-provider-attempt'
    readonly defaultObservationBody: false
    readonly compatibilityWireLogger: 'explicit-high-risk-bounded-exact-json-body-redacted-headers'
  }
  readonly sseTransportPolicy: {
    readonly owner: 'provider-http-not-core-or-protocol-package'
    readonly parserDependency: 'exact-eventsource-parser-4.1.0-under-adr-0001'
    readonly mediaType: 'text-event-stream-required-parameters-allowed-before-parser'
    readonly utf8: 'whatwg-streaming-replacement-semantics'
    readonly activity: 'every-nonempty-body-read-including-comment-heartbeats'
    readonly idleDeadline: 'single-resettable-deadline-per-physical-attempt'
    readonly eventCount: 'configurable-default-100000'
    readonly eventBufferChars: 'configurable-default-1048576'
    readonly queueDrain: 'linear-cursor-never-array-shift'
    readonly reconnect: 'never-parser-retry-field-ignored'
    readonly terminal: 'exactly-one-finish-last-eof-before-finish-stream-closed'
    readonly retryAfterOutput: 'forbidden'
    readonly teardown: 'bounded-cancel-primary-failure-preserved'
  }
  readonly edgeWebDeploymentPolicy: {
    readonly defaultExecutionOwner: 'edge-worker'
    readonly browserDefaultSdkPackages: 'none-static-sse-client'
    readonly providerCredentials: 'worker-injected-never-browser-originated-or-returned'
    readonly principalSource: 'trusted-host-auth-context-never-request-json'
    readonly conversationAuthorization: 'principal-plus-conversation-id-or-server-issued-opaque-handle'
    readonly hermeticPrincipal: 'explicit-fixed-test-principal-only'
    readonly sessionIdentity: 'one-session-per-principal-conversation-mode-excluded'
    readonly deepSearchActivation: 'host-mapped-bounded-run-scoped-additional-instructions'
    readonly deepSearchExecution: 'agent-instruction-driven-adaptive-not-host-workflow'
    readonly forwardRequestInstructions: false
    readonly concurrentRun: 'stable-409-without-second-run'
    readonly cancellation: 'owned-controller-combines-request-abort-response-cancel-and-runtime-close'
    readonly disconnectSettlement: 'abort-and-bounded-await-no-surviving-provider-or-tool-operation'
    readonly eventEnvelope: 'schema-version-run-id-monotonic-sequence-type'
    readonly terminal: 'exactly-one-complete-failed-or-aborted-with-run-report'
    readonly errorExposure: 'support-safe-code-stage-message-no-raw-thrown-error'
    readonly toolProjection: 'explicit-public-json-safe-bounded'
    readonly eofWithoutTerminal: 'client-visible-incomplete-never-success'
    readonly automaticReplay: 'forbidden-without-explicit-resume-protocol'
    readonly requestBoundary: 'same-origin-default-bounded-json-before-agent-admission'
    readonly credentialedAcceptance: 'owner-authorized-targeted'
  }
  readonly runInstructionPolicy: {
    readonly surface: 'optional-host-owned-string'
    readonly maxUtf8Bytes: 65536
    readonly validation: 'synchronous-before-run-admission-history-ledger-or-capability-method'
    readonly emptyOrWhitespace: 'stable-rejection'
    readonly contentNormalization: 'none-preserve-exact-captured-string'
    readonly capture: 'once-at-run-admission'
    readonly systemOrder: 'agent-skill-catalog-team-run-overlay-core-mode'
    readonly application: 'every-model-request-in-run-including-retry-and-post-compaction'
    readonly persistence: 'never-history-memory-snapshot-resume-or-later-run'
    readonly manualCompaction: 'base-instructions-only-outside-run'
    readonly privacy: 'provider-request-only-no-default-observation-diagnostics-error-or-artifact'
    readonly accounting: 'included-in-provider-input-usage-and-local-estimation-request'
    readonly retry: 'reuse-exact-captured-overlay'
    readonly sessionIdentity: 'unchanged-agent-session-conversation-and-memory-binding'
    readonly authority: 'not-auth-approval-tool-or-resource-policy'
    readonly untrustedTransportForwarding: false
    readonly errorCode: 'RUN_ADDITIONAL_INSTRUCTIONS_INVALID'
  }
  readonly runHandleCancellationPolicy: {
    readonly execution: 'eager-at-stream-call-single-consumer-events'
    readonly identity: 'stable-run-id-before-first-event'
    readonly abort: 'synchronous-idempotent-owned-controller-signal'
    readonly abortReason: 'never-raw-observed-serialized-or-used-as-support-message'
    readonly afterTerminal: 'abort-noop'
    readonly iteratorEarlyReturn: 'abort-and-bounded-settle'
    readonly result: 'resolve-success-reject-stable-agent-run-error-with-report'
    readonly report: 'independently-awaitable-on-success-error-or-abort'
    readonly eventTerminal: 'exactly-one-usage-or-support-safe-error-with-same-report'
    readonly idle: 'session-idle-only-after-result-report-and-event-stream-settled'
    readonly unhandledRejection: 'internally-contained-without-hiding-caller-promises'
    readonly errorCode: 'AGENT_RUN_ABORTED'
  }
  readonly invocationObserverPolicy: {
    readonly surface: 'preserved-agent-invocation-options-on-event'
    readonly runAndGenerate: 'drain-handle-sequentially-await-observer-before-next-event'
    readonly stream: 'callback-not-invoked-caller-consumes-handle'
    readonly compact: 'callback-not-invoked-no-run-events'
    readonly timeout: 'runtime-limit-observer-timeout-default-30000ms'
    readonly failure: 'abort-run-settle-and-reject-convenience-method-stable-error'
    readonly report: 'canonical-report-remains-attached-and-independently-accounted'
    readonly privacy: 'raw-callback-failure-not-support-message-or-observation-content'
    readonly durability: 'application-observer-not-observation-exporter-or-ack'
    readonly errorCode: 'AGENT_EVENT_OBSERVER_FAILED'
  }
  readonly targetApiParityPolicy: {
    readonly status: 'pending-target-declaration-coverage'
    readonly defaultAction: 'preserve-unless-explicit-approved-removal'
    readonly inventory: 'exact-sorted-missing-symbol-count-and-sha256'
    readonly phase0ApprovalRequiresZeroMissing: true
    readonly sources: Readonly<Record<string, {
      readonly targetSpecifier: string
      readonly missingCount: number
      readonly missingSha256: string
    }>>
  }
  readonly observabilityCompatibilityPolicy: {
    readonly advancedSpecifier: '@ai-agent-sdk/core/observability'
    readonly legacySurface: 'preserve-current-names-and-source-assignability'
    readonly legacyExporter: 'marker-free-caller-owned-observation-bus'
    readonly runtimeExporter: 'marker-based-observation-exporter-plugin'
    readonly runtimeRegistration: 'explicit-owned-or-borrowed'
    readonly eventEnvelope: 'preserve-current-correlated-schema-v1'
    readonly resourceIdentity: 'preserve-sdk-name-runtime-and-add-new-fields-optional'
    readonly deliveryBatch: 'new-name-with-atomic-run-terminal-records'
    readonly deliveryAck: 'new-name-with-event-and-run-id-acknowledgment'
    readonly sameNameSemanticRepurpose: false
    readonly signatureEvidence: 'compile-current-module-against-target-advanced-subpath'
  }
  readonly observabilityCapabilityCompatibilityPolicy: {
    readonly advancedExporters: 'preserve-marker-free-classes-and-lifecycle-controls'
    readonly runtimeFactories: 'additive-adapters-not-same-name-repurposing'
    readonly focusedCoreTypes: readonly string[]
    readonly sameNameSemanticRepurpose: false
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly entrypoints: readonly string[]
  }
  readonly coreMessageCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly coveredSymbols: readonly string[]
  }
  readonly coreProviderCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly coveredSymbols: readonly string[]
    readonly signatureSensitiveExistingSymbols: readonly string[]
  }
  readonly protocolCompatibilityPolicy: {
    readonly advancedProtocol: 'preserve-marker-free-protocol-definition'
    readonly runtimeProtocol: 'add-marker-based-intersection-view-on-same-value'
    readonly sameNameSemanticRepurpose: false
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly packages: Readonly<Record<string, {
      readonly source: string
      readonly currentConfig: string
      readonly targetConfig: string
    }>>
  }
  readonly mcpCompatibilityPolicy: {
    readonly universalClientOwner: '@ai-agent-sdk/mcp'
    readonly universalServerOwner: '@ai-agent-sdk/mcp-server'
    readonly nodeClientOwner: '@ai-agent-sdk/mcp-node'
    readonly nodeServerOwner: '@ai-agent-sdk/mcp-node-server'
    readonly legacyServerRoute: '@ai-agent-sdk/mcp/server'
    readonly legacyServerRouteKind: 'optional-peer-reexport-view'
    readonly rootMovesRequireDecision: 'P0-14'
    readonly advancedClose: 'close-returns-promise-void'
    readonly reportedClose: 'distinct-closeWithReport-method'
    readonly internalErrorField: 'error'
    readonly supportSafeErrorField: 'supportError'
    readonly sameNameSemanticRepurpose: false
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-route-compile'
    readonly entrypoints: readonly string[]
  }
  readonly authCompatibilityPolicy: {
    readonly envRootClosure: 'core-plus-auth-node-only'
    readonly codexRoute: 'optional-provider-codex-peer'
    readonly legacyEnvResult: 'callable-zero-argument-string-resolver'
    readonly runtimeEnvResult: 'credential-source-intersection-on-same-callable-value'
    readonly legacyCodexStore: 'preserve-read-write-contract'
    readonly runtimeCodexStore: 'distinct-codex-credential-store-with-revisioned-read-commit'
    readonly legacyNodeFactory: 'preserve-codex-node-adapter-and-plugin'
    readonly runtimeNodeFactory: 'distinct-codex-node-provider-plugin'
    readonly sameNameSemanticRepurpose: false
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-route-compile'
    readonly entrypoints: readonly string[]
  }
  readonly a2aCompatibilityPolicy: {
    readonly root: 'combined-client-server-compatibility-view'
    readonly client: 'same-specifier-client-owner'
    readonly server: 'same-specifier-server-owner'
    readonly sameNameSemanticRepurpose: false
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-route-compile'
    readonly entrypoints: readonly string[]
  }
  readonly runtimeTeamRemoteLinkPolicy: {
    readonly bridge: 'structural-linkAgent-contract'
    readonly transportOwnership: 'borrowed-caller-owned'
    readonly teamClose: 'unlink-only-never-close-transport'
    readonly unlink: 'synchronous-idempotent'
    readonly messageAdmission: 'team-operation-lease-with-bounds-and-support-safe-errors'
    readonly remoteRun: 'sendMessage-not-session-or-run'
    readonly a2aCompatibility: 'legacy-and-runtime-team-structural-acceptance'
  }
  readonly agentToolCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly coveredSymbols: readonly string[]
    readonly signatureSensitiveExistingSymbols: readonly string[]
  }
  readonly agentSkillCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly legacyProvider: 'preserve-current-candidate-list-load-resource-contract'
    readonly runtimeProvider: 'distinct-versioned-skill-provider-plugin-with-revision-reference'
    readonly sameNameSemanticRepurpose: false
    readonly coveredSymbols: readonly string[]
    readonly signatureSensitiveExistingSymbols: readonly string[]
  }
  readonly agentMemoryHistoryCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly coveredSymbols: readonly string[]
    readonly signatureSensitiveExistingSymbols: readonly string[]
  }
  readonly agentAccountingTraceCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly coveredSymbols: readonly string[]
    readonly signatureSensitiveExistingSymbols: readonly string[]
  }
  readonly agentLoopDefinitionCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly legacyEventProtocol: 'preserve-current-agent-and-agent-run-events'
    readonly runtimeEventProtocol: 'distinct-runtime-agent-run-event'
    readonly legacyDefinitionProtocol: 'preserve-current-defined-agent-and-session'
    readonly runtimeDefinitionProtocol: 'distinct-runtime-agent-definition-and-session'
    readonly runtimeDefinitionDiscriminant: 'required-model-target-object'
    readonly legacyDefinitionDiscriminant: 'model-string-or-omitted'
    readonly normalRuntimeEntry: 'runtime-agent-accepts-runtime-definition-input-directly'
    readonly factorySideEffects: 'none'
    readonly sameNameSemanticRepurpose: false
    readonly coveredSymbols: readonly string[]
    readonly signatureSensitiveExistingSymbols: readonly string[]
  }
  readonly agentTeamCompatibilityPolicy: {
    readonly source: string
    readonly currentConfig: string
    readonly targetConfig: string
    readonly evidence: 'same-source-dual-current-target-compile'
    readonly legacyTeamProtocol: 'preserve-current-local-remote-control-plane'
    readonly runtimeTeamProtocol: 'distinct-runtime-agent-team'
    readonly sameNameSemanticRepurpose: false
    readonly coveredSymbols: readonly string[]
    readonly signatureSensitiveExistingSymbols: readonly string[]
  }
  readonly localExecutableLeafPolicy: {
    readonly families: readonly string[]
    readonly marker: 'none-core-owned-leaf-contracts'
    readonly captureAt: 'agent-session-binding-before-run'
    readonly capturedConfiguration: 'detached-bounded-readonly'
    readonly capturedMethods: 'runtime-used-function-references-once'
    readonly methodReceiver: 'original-leaf-object'
    readonly operationalStateMayMutate: true
    readonly callerObjectMutationOrFreeze: false
    readonly rereadRuntimeMethodsAfterCapture: false
    readonly postCaptureReplacement: 'no-effect-on-bound-session'
    readonly requiredCancellation: 'broker-and-hook-context-signals'
  }
  readonly deterministicTestEvidencePolicy: {
    readonly privacyAssertion: 'structural-field-absence-or-unique-non-id-sentinel'
    readonly randomIdentifierFields: 'never-global-substring-asserted-with-short-sentinel'
    readonly rerunAfterRandomCollision: 'classify-flake-and-retain-initial-failure'
    readonly focusedPass: 'diagnostic-evidence-not-erasure-of-suite-failure'
    readonly liveNetworkProviderEvidence: 'owner-authorized-targeted'
  }
  readonly memoryBindingPolicy: {
    readonly compositionPrecedence: 'session-false-or-binding-then-agent-binding-then-none'
    readonly ownership: 'always-borrowed-caller-owned-store'
    readonly scopeKinds: readonly string[]
    readonly conversationKey: 'versioned-collision-free-tuple-of-namespace-agent-id-conversation-id'
    readonly fixedSharing: 'requires-shared-across-sessions-true'
    readonly snapshotIdentity: 'support-safe-binding-id-only'
    readonly resumeBinding: 'exact-binding-id-match-required'
    readonly keyAndNamespaceInDiagnostics: false
    readonly keyAndNamespaceInSnapshot: false
  }
  readonly runtimeOperationPolicy: {
    readonly trackedKinds: readonly string[]
    readonly admissionVsClose: 'one-atomic-state-transition'
    readonly operationSignal: 'caller-plus-runtime-root-plus-operation-deadline'
    readonly closeOrder: 'reject-abort-quiesce-seal-dispose-flush'
    readonly providerCleanupAfterOperationQuiescence: true
    readonly lateResultPublication: 'discard-after-generation-seal'
    readonly readOnlyAfterClose: readonly string[]
    readonly rejectAfterClose: readonly string[]
    readonly loggerAfterClose: 'closed-noop-never-reopens-observation'
    readonly closeReportPerKind: true
    readonly closeReportRows: 'fixed-order-including-zero'
    readonly closeReportInvariant: 'active-equals-settled-plus-unsettled'
    readonly legacyRunCounters: 'projection-of-agent-run-row'
    readonly concurrentClose: 'first-call-starts-one-shared-terminal-task'
    readonly closeCallerSignal: 'accelerates-quiescence-never-cancels-cleanup-or-rejects-close'
    readonly deadlineReached: 'projection-of-quiescence-end-timeout'
  }
  readonly runtimeBaselines: {
    readonly universal: { readonly requiredFeatures: readonly string[] }
    readonly browser: {
      readonly extends: 'universal'
      readonly requiredFeatures: readonly string[]
    }
    readonly node: {
      readonly extends: 'universal'
      readonly minimumVersion: string
      readonly requiredFeatures: readonly string[]
    }
  }
  readonly forbiddenPackages: readonly string[]
  readonly removalMigrationInventory: Readonly<Record<string, RemovalMigrationRule>>
  readonly packages: Readonly<Record<string, PackageRule>>
  readonly journeys: readonly JourneyRule[]
}
