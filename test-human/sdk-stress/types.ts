import type { HumanArtifactInvariant, HumanArtifactRecorder } from '../artifacts.ts'

export type SdkStressProfile = 'complex' | 'stress' | 'soak'

export interface SdkStressConfig {
  readonly profile: SdkStressProfile
  readonly scenarioIds: readonly string[]
  readonly repeat: number
  readonly parallel: number
  readonly seed: number
  readonly timeoutMs: number
  readonly runId: string
  readonly resultsRoot: string
  readonly failFast: boolean
  readonly verbose: boolean
  readonly dryRun: boolean
  readonly help: boolean
}

export interface SdkStressContext {
  readonly config: SdkStressConfig
  readonly caseId: string
  readonly repeat: number
  readonly seed: number
  readonly iterations: number
  readonly signal: AbortSignal
  readonly artifact: HumanArtifactRecorder
  readonly random: () => number
}

export interface SdkStressScenarioResult {
  readonly invariants: readonly HumanArtifactInvariant[]
  readonly metrics: Readonly<Record<string, unknown>>
}

export interface SdkStressScenario {
  readonly id: string
  readonly description: string
  readonly weight?: number
  run(context: SdkStressContext): Promise<SdkStressScenarioResult>
}

export interface SdkStressCaseResult {
  readonly caseId: string
  readonly scenarioId: string
  readonly repeat: number
  readonly seed: number
  readonly iterations: number
  readonly status: 'passed' | 'failed' | 'aborted'
  readonly durationMs: number
  readonly artifact: string
  readonly invariants: readonly HumanArtifactInvariant[]
  readonly metrics?: Readonly<Record<string, unknown>>
  readonly error?: string
}

export interface SdkStressSummary {
  readonly schemaVersion: 1
  readonly runId: string
  readonly profile: SdkStressProfile
  readonly seed: number
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly passed: number
  readonly failed: number
  readonly aborted: number
  readonly totalIterations: number
  readonly resultsRoot: string
  readonly cases: readonly SdkStressCaseResult[]
}

