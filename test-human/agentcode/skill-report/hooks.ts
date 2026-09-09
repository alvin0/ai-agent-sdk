import type { TurnHooks } from '@alvin0/ai-agent-sdk-core/agent'
import { AgentCodeSkillReportRecorder } from './recorder.ts'

/** Merge recorder checkpoints with existing steering/memory hooks. */
export function withAgentCodeSkillReportHooks(
  recorder: AgentCodeSkillReportRecorder,
  hooks: TurnHooks | undefined,
): TurnHooks {
  return {
    ...hooks,
    checkpoint: async context => {
      await hooks?.checkpoint?.(context)
      recorder.recordCheckpoint(context)
    },
  }
}
