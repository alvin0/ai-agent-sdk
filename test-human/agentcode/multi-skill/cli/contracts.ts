import type { AgentCodeCliConfig } from '../../config.ts'
import type { AgentRunOutcome } from '@alvin0/ai-agent-sdk-core/agent'
import type { SignalDeskVerificationReport } from '../verify.ts'

export interface MultiSkillCliConfig {
  readonly agent: AgentCodeCliConfig
  readonly model: string
  readonly reportDirectory: string
  readonly repairTurns: number
}

export interface MultiSkillAcceptance {
  readonly baselineRed: boolean
  readonly functionalVerifier: boolean
  readonly expectedSkillsBehaviorallyApplied: boolean
  readonly skillEvidenceComplete: boolean
  readonly traceComplete: boolean
  readonly deepOutcomeCompleted: boolean
  readonly compactionCompleted: boolean
}

export interface MultiSkillRunSummary {
  readonly schemaVersion: 1
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly passed: boolean
  readonly config: {
    readonly provider: string
    readonly model: string
    readonly effort: string
    readonly maxTurns: number
    readonly maxToolCalls: number
    readonly maxInputTokens: number
    readonly retainTokens: number
    readonly workspace: string
    readonly reportDirectory: string
    readonly providerLogs: string | null
    readonly repairTurns: number
  }
  readonly requiredSkills: readonly string[]
  readonly discoveredSkills: readonly string[]
  readonly skillsCache?: { readonly root: string; readonly reused: boolean; readonly sources: readonly string[] }
  readonly preparation?: { readonly passed: boolean; readonly dependenciesReady: boolean; readonly browserReady: boolean; readonly report: string }
  readonly baseline?: { readonly red: boolean; readonly exitCode: number | null; readonly timedOut: boolean; readonly aborted: boolean; readonly report: string }
  readonly runs: readonly MultiSkillTurnSummary[]
  readonly verifications: readonly { readonly attempt: number; readonly passed: boolean; readonly failedChecks: readonly string[]; readonly commands: Readonly<Record<string, number | null>>; readonly report: string }[]
  readonly acceptance: MultiSkillAcceptance
  readonly skillReport: string
  readonly errors: readonly string[]
}

export interface MultiSkillTurnSummary {
  readonly label: string
  readonly completed: boolean
  readonly reason?: string
  readonly steps?: number
  readonly toolCalls?: number
  readonly traceId?: string
  readonly error?: string
}

export interface HarnessFlags {
  readonly reportDirectory: string
  readonly repairTurns: number
  readonly agentArgs: readonly string[]
}

export interface TurnResult {
  readonly label: string
  readonly outcome?: AgentRunOutcome
  readonly error?: string
}

export type VerificationItem = { readonly report: SignalDeskVerificationReport; readonly path: string }
