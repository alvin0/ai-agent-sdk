/** Bounded behavioral evidence for skill use in long-running agentcode sessions. */

import type { AgentCodeSkillReport } from './skill-report/types.ts'
export { AgentCodeSkillReportRecorder } from './skill-report/recorder.ts'
export { withAgentCodeSkillReportHooks } from './skill-report/hooks.ts'
export type {
  SkillEvidenceStatus,
  AgentCodeSkillReportOptions,
  AgentCodeSkillEvidence,
  AgentCodeSkillReportSummary,
  AgentCodeSkillReport,
} from './skill-report/types.ts'

export function isAgentCodeSkillEvidenceComplete(report: AgentCodeSkillReport): boolean {
  return report.summary.allExpectedSkillsBehaviorallyApplied
    && report.summary.orderProblems === 0
    && report.problems.length === 0
    && report.omitted.timelineEntries === 0
    && report.omitted.problems === 0
    && report.omitted.skills === 0
    && report.omitted.pendingRecords === 0
}
