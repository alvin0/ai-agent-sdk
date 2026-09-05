export type Runtime = 'universal' | 'browser' | 'node'

export interface PackageRule {
  readonly runtime: Runtime
  readonly declarationDir: string
  readonly specifiers: readonly string[]
  readonly manifestRoles: readonly string[]
  readonly corePeer: 'none' | 'required'
  readonly normalWorkspaceDependencies: readonly string[]
  readonly optionalWorkspacePeers: readonly string[]
  readonly specifierPeerRequirements?: Readonly<Record<string, string>>
  readonly externalRuntimeDependencies: readonly string[]
  readonly requiredExternalRuntimePeers?: readonly string[]
  readonly optionalExternalRuntimePeers?: readonly string[]
}

export interface JourneyRule {
  readonly id: string
  readonly file: string
  readonly runtime: Runtime
  readonly packages: readonly string[]
  readonly directExternalPackages?: readonly string[]
}

export interface RemovalMigrationRule {
  readonly action:
    | 'merge-into-core-and-remove'
    | 'remove'
    | 'remove-or-time-bounded-compatibility'
  readonly expectedImportFiles: readonly string[]
  readonly replacementSpecifiers?: Readonly<Record<string, string>>
}

export interface Phase0Decision {
  readonly id: string
  readonly topic: string
  readonly recommendation: string
  readonly status: 'pending-owner-approval' | 'approved'
  readonly approvedBy?: string
  readonly approvedAt?: string
}

export interface Phase0Decisions {
  readonly schemaVersion: 1
  readonly overallStatus: 'pending-owner-approval' | 'approved'
  readonly targetPackageCount: number
  readonly targetSpecifierCount: number
  readonly coreRootExportCount: number
  readonly diagnosticsProposal: {
    readonly maxEvents: number
    readonly maxBytes: number
    readonly existingPerEventHardMaxBytes: number
  }
  readonly decisions: readonly Phase0Decision[]
}

export interface ApiRemovalRule {
  readonly symbol: string
  readonly decisionId: string
  readonly replacement: string
  readonly consumerMigration: string
}

export interface ApiMigrationSource {
  readonly declaration: string
  readonly declarationSha256: string
  readonly targetSpecifier: string
  readonly exports: readonly string[]
  readonly remove: readonly ApiRemovalRule[]
}

export interface ApiMigration {
  readonly schemaVersion: 1
  readonly policy: {
    readonly defaultAction: 'preserve'
    readonly removalRequires: readonly string[]
    readonly currentCoreRoot: 'retain-root'
    readonly movedPackageRoot: 'assigned-target-subpath'
    readonly focusedSubpaths: 'reexport-canonical-only'
    readonly forbidDuplicateDeclarations: true
  }
  readonly canonicalCollisions: readonly {
    readonly symbol: string
    readonly sourcePackages: readonly string[]
    readonly canonicalSpecifier: string
    readonly reexportSpecifiers: readonly string[]
  }[]
  readonly sources: Readonly<Record<string, ApiMigrationSource>>
}

export interface ProviderApiBaseline {
  readonly schemaVersion: 1
  readonly policy: 'preserve-unless-owner-approved'
  readonly sources: Readonly<Record<string, ApiMigrationSource>>
}

export interface RetainedPackageApiSource {
  readonly declaration: string
  readonly declarationSha256: string
  readonly exports: readonly string[]
  readonly targetSpecifiers: readonly string[]
  readonly action: 'preserve' | 'split-with-owner-approval' | 'preserve-via-optional-peer-view'
  readonly decisionId?: string
  readonly movedExports?: Readonly<Record<string, readonly string[]>>
}

export interface RetainedPackageApiBaseline {
  readonly schemaVersion: 1
  readonly policy: 'preserve-unless-owner-approved'
  readonly targetAudit: {
    readonly evidence: 'exact-sorted-source-specifier-and-missing-symbol-sha256'
    readonly expectedEntrypointCount: number
    readonly expectedBaselineSymbolCount: number
    readonly expectedMissingSymbolCount: number
    readonly expectedMissingSha256: string
    readonly expectedMissingByEntrypoint: Readonly<Record<string, number>>
  }
  readonly sources: Readonly<Record<string, RetainedPackageApiSource>>
}

export interface ManifestConditionalExport {
  readonly types: string
  readonly import: string
  readonly default: string
}

export interface ManifestBlueprintPackage {
  readonly runtime: Runtime
  readonly canonicalOwnerExported: false
  readonly rootFacadeExportCount?: number
  readonly identityRoutes?: readonly string[]
  readonly optionalPeerRoutes?: Readonly<Record<string, string>>
  readonly exports: Readonly<Record<string, string | ManifestConditionalExport>>
}

export interface ManifestBlueprints {
  readonly schemaVersion: 1
  readonly policy: {
    readonly explicitExportsOnly: true
    readonly wildcardExports: false
    readonly requireCondition: false
    readonly packageJsonExport: true
  }
  readonly packages: Readonly<Record<string, ManifestBlueprintPackage>>
}

export interface InstallClosureBaseline {
  readonly schemaVersion: 1
  readonly policy: {
    readonly optionalPeersExcludedUntilExplicitlySelected: true
    readonly requiredCorePeerMustBeDirect: true
    readonly externalSelectionsInclude: 'runtime-dependencies-and-required-peers'
  }
  readonly journeys: Readonly<Record<string, {
    readonly workspaceClosure: readonly string[]
    readonly externalClosure: readonly string[]
    readonly effectiveRuntime: Runtime
  }>>
  readonly packageProbes: Readonly<Record<string, {
    readonly workspaceClosure: readonly string[]
    readonly externalClosure: readonly string[]
    readonly effectiveRuntime: Runtime
  }>>
}

export interface SourceMigrationBaseline {
  readonly schemaVersion: 1
  readonly policy: {
    readonly state: 'phase-tracked'
    readonly moveNotCopy: true
    readonly preserveRelativePaths: true
    readonly eliminateMovedSelfPackageImports: true
    readonly bridgeImplementation: 're-export-only'
    readonly bridgeManifest: 'private-esm-side-effect-free-core-only-runtime-dependency'
    readonly newBridgeConsumers: 'forbidden'
    readonly partialCrossRootOwnership: 'forbidden'
    readonly migrationOrder: readonly string[]
  }
  readonly roots: Readonly<Record<string, {
    readonly state: 'pending' | 'moved'
    readonly implementationSlice: 'I1' | 'I2'
    readonly sourcePackage: string
    readonly sourceRoot: string
    readonly targetRoot: string
    readonly packageManifest: string
    readonly deletionSlice: 'I7'
    readonly bridgeEntrypoints: Readonly<Record<string, {
      readonly sourceFile: string
      readonly canonicalTarget: string
      readonly emittedBase: string
    }>>
    readonly fileCount: number
    readonly fileListSha256: string
    readonly files: readonly string[]
    readonly selfCoreImportFileCount: number
    readonly selfCoreImportFileListSha256: string
    readonly dependencyFirstGroups: readonly string[]
    readonly targetCollisions: Readonly<Record<
      string,
      'merge-exports-into-existing-target-then-delete-source'
    >>
  }>>
}

export interface DocumentationMigrationBaseline {
  readonly schemaVersion: 1
  readonly state: 'pending' | 'active-guides-migrated' | 'complete'
  readonly policy: {
    readonly implementationSlice: 'I6'
    readonly facadeDeletionSlice: 'I7'
    readonly scanRoots: readonly string[]
    readonly surface: 'fenced-code-inline-code-and-install-command'
    readonly pendingInventory: 'exact'
    readonly newRemovedPackageExamples: 'forbidden'
    readonly stateOrder: readonly ['pending', 'active-guides-migrated', 'complete']
    readonly targetRewriteFiles: 'zero-removed-package-examples-from-I6'
    readonly humanJourneyCoupling: 'all-target-achieved-at-I6'
    readonly retiredPackageReadmes: 'present-through-I6-deleted-with-package-at-I7'
    readonly historicalRecords: 'may-name-removed-packages-with-explicit-status'
    readonly targetPackageReadmes: 'core-plus-all-recommended-composition-entrypoints'
  }
  readonly removedPackages: Readonly<Record<string, {
    readonly replacementRoutes: Readonly<Record<string, string | null>>
    readonly expectedExampleFiles: readonly string[]
  }>>
  readonly fileDispositions: {
    readonly rewrite: readonly string[]
    readonly deleteWithPackage: readonly string[]
    readonly supersededCurrentDesign: readonly string[]
    readonly retainedMigrationRecord: readonly string[]
  }
  readonly targetCoreReadmeSymbols: readonly string[]
}
