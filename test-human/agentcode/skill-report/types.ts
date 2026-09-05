export type SkillEvidenceStatus =
  | 'not-loaded'
  | 'load-failed'
  | 'loaded'
  | 'instructions-in-context'
  | 'behaviorally-applied'
  | 'resource-informed'

export interface AgentCodeSkillReportOptions {
  /** Destination for {@link AgentCodeSkillReportRecorder.flush}. */
  readonly reportPath: string
  /** Skills the exercise intends to use. Missing skills remain visible in the report. */
  readonly expectedSkillIds?: readonly string[]
  /** Timeline entries retained in memory and JSON. Defaults to 2,000. */
  readonly maxTimelineEntries?: number
  /** Distinct skills retained in memory and JSON. Defaults to 128. */
  readonly maxTrackedSkills?: number
  /** Simultaneous calls, unexposed results, and spans retained. Defaults to 4,096. */
  readonly maxPendingRecords?: number
  /** Problems retained verbatim after redaction. Defaults to 200. */
  readonly maxProblems?: number
  /** Maximum length of any externally supplied string in the report. Defaults to 320. */
  readonly maxStringChars?: number
  /** Injectable clock for deterministic tests. */
  readonly now?: () => string
}

export interface AgentCodeSkillEvidence {
  readonly skillId: string
  readonly expected: boolean
  readonly status: SkillEvidenceStatus
  readonly loadAttempts: number
  readonly successfulLoads: number
  readonly failedLoads: number
  readonly instructionExposureRequests: number
  readonly resourceAttempts: number
  readonly successfulResourceCalls: number
  readonly resourceExposureRequests: number
  readonly successfulApplicationActions: number
  readonly failedApplicationAttempts: number
  readonly resourceInformedActions: number
  readonly activationIoEvents: number
  readonly activationBytesRead: number
  readonly resourceIoEvents: number
  readonly resourceBytesRead: number
  readonly applicationTools: readonly string[]
  readonly firstLoadSequence?: number
  readonly firstInstructionExposureSequence?: number
  readonly firstApplicationSequence?: number
}

export interface AgentCodeSkillReportSummary {
  readonly eventsObserved: number
  readonly modelRequestsObserved: number
  readonly catalogRequestsObserved: number
  readonly runsObserved: number
  readonly turnsObserved: number
  readonly compactionsStarted: number
  readonly compactionsCompleted: number
  readonly successfulApplicationActions: number
  readonly skillIoEvents: number
  readonly skillIoBytesRead: number
  readonly discoveryIoEvents: number
  readonly activationIoEvents: number
  readonly resourceIoEvents: number
  readonly skillsLoaded: number
  readonly skillsInstructionExposed: number
  readonly skillsBehaviorallyApplied: number
  readonly skillsResourceInformed: number
  readonly expectedSkills: number
  readonly expectedSkillsBehaviorallyApplied: number
  readonly allExpectedSkillsBehaviorallyApplied: boolean
  readonly multipleSkillsBehaviorallyApplied: boolean
  readonly orderProblems: number
  readonly trace: {
    readonly spansStarted: number
    readonly spansEnded: number
    readonly openSpans: number
    readonly duplicateStarts: number
    readonly duplicateEnds: number
    readonly endsWithoutStart: number
    readonly orphanStarts: number
    readonly auditComplete: boolean
  }
}

export interface AgentCodeSkillReport {
  /** v2 narrows behavioral application to material actions. */
  readonly schemaVersion: 2
  readonly generatedAt: string
  readonly summary: AgentCodeSkillReportSummary
  readonly skills: readonly AgentCodeSkillEvidence[]
  readonly problems: readonly string[]
  readonly timeline: readonly Readonly<Record<string, unknown>>[]
  readonly omitted: {
    readonly timelineEntries: number
    readonly problems: number
    readonly skills: number
    readonly pendingRecords: number
  }
  readonly proofLimits: readonly string[]
}

/** Whether a report is complete enough to serve as release-acceptance evidence. */
export function isAgentCodeSkillEvidenceComplete(report: AgentCodeSkillReport): boolean {
  return report.summary.allExpectedSkillsBehaviorallyApplied
    && report.summary.orderProblems === 0
    && report.problems.length === 0
    && report.omitted.timelineEntries === 0
    && report.omitted.problems === 0
    && report.omitted.skills === 0
    && report.omitted.pendingRecords === 0
}

export interface MutableSkillEvidence {
  skillId: string
  expected: boolean
  loadAttempts: number
  successfulLoads: number
  failedLoads: number
  instructionExposureRequests: number
  resourceAttempts: number
  successfulResourceCalls: number
  resourceExposureRequests: number
  successfulApplicationActions: number
  failedApplicationAttempts: number
  resourceInformedActions: number
  activationIoEvents: number
  activationBytesRead: number
  resourceIoEvents: number
  resourceBytesRead: number
  applicationTools: Set<string>
  firstLoadSequence?: number
  firstInstructionExposureSequence?: number
  firstApplicationSequence?: number
}

export interface PendingCall {
  readonly toolName: string
  readonly sequence: number
  readonly skillId?: string
  readonly resourcePath?: string
  readonly applicationSkills?: readonly string[]
  readonly resourceInformedSkills?: readonly string[]
}

export interface PendingExposure {
  readonly skillId: string
  readonly sequence: number
}

export interface PendingRequestResult {
  readonly requestSequence: number
  readonly textChars: number
  readonly skillMarkers: ReadonlySet<string>
}

export interface RunObservation {
  readonly id: string
  readonly ordinal: number
  readonly startedSequence: number
  eventCount: number
}

export interface TraceCounters {
  started: number
  ended: number
  duplicateStarts: number
  duplicateEnds: number
  endsWithoutStart: number
  orphanStarts: number
  auditComplete: boolean
}

/**
 * Record a privacy-preserving proof chain for skill use.
 *
 * A successful `load_skill` alone is deliberately insufficient. A skill becomes
 * `instructions-in-context` only after a later model request contains both that
 * call's tool result and its exact `<skill_content id>` marker. It becomes
 * `behaviorally-applied` only when a later material AgentCode action succeeds.
 * Workspace inspection and unknown app tools are deliberately ignored, so they
 * neither prove application nor consume evidence that can be attributed to a
 * later write, replacement, command, or explicitly successful native action.
 * The recorder proves ordering and observable behavior, not semantic compliance
 * with every sentence of a skill.
 */
