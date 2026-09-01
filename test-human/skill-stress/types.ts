import type { HumanProvider } from '../config.ts'

export type StressSuite = 'offline' | 'registry' | 'live' | 'all'
export type StressScenarioKind = 'offline' | 'registry' | 'live'

export interface SkillStressConfig {
  readonly suite: StressSuite
  readonly scenarioIds: readonly string[]
  readonly parallel: number
  readonly repeat: number
  readonly seed: number
  readonly timeoutMs: number
  readonly runId: string
  readonly workspaceRoot: string
  readonly resultsRoot: string
  readonly skillsRoot: string
  readonly provider: HumanProvider
  readonly model: string
  readonly effort: string
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly maxInputTokens: number
  readonly retainTokens: number
  readonly logs: boolean
  readonly keepWorkspaces: boolean
  readonly failFast: boolean
  readonly verboseEvents: boolean
  readonly help: boolean
  readonly dryRun: boolean
}

export interface StressCasePaths {
  readonly root: string
  readonly workspace: string
  readonly skills: string
  readonly report: string
}

export interface StressInvariant {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface StressScenarioResult {
  readonly invariants: readonly StressInvariant[]
  readonly metrics?: Readonly<Record<string, unknown>>
}

export interface StressCaseContext {
  readonly config: SkillStressConfig
  readonly caseId: string
  readonly repeat: number
  readonly seed: number
  readonly paths: StressCasePaths
  readonly signal: AbortSignal
}

export interface StressScenario {
  readonly id: string
  readonly kind: StressScenarioKind
  readonly description: string
  run(context: StressCaseContext): Promise<StressScenarioResult>
}

export interface StressCaseResult {
  readonly caseId: string
  readonly scenarioId: string
  readonly kind: StressScenarioKind
  readonly repeat: number
  readonly seed: number
  readonly status: 'passed' | 'failed' | 'aborted'
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly paths: StressCasePaths
  readonly invariants: readonly StressInvariant[]
  readonly metrics?: Readonly<Record<string, unknown>>
  readonly error?: string
}

export interface StressRunSummary {
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly passed: number
  readonly failed: number
  readonly aborted: number
  readonly resultsRoot: string
  readonly cases: readonly StressCaseResult[]
}

export interface StressProgressEvent {
  readonly type: 'case-start' | 'case-end'
  readonly caseId: string
  readonly scenarioId: string
  readonly status?: StressCaseResult['status']
}
