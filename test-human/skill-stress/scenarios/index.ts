import type { StressScenario } from '../types.ts'
import { cancellationRecovery } from './cancellation-recovery.ts'
import { compactionTrace } from './compaction-trace.ts'
import { definedAgentWebSkills } from './defined-agent-web-skills.ts'
import { harnessFolderRounds } from './harness-folder-rounds.ts'
import { liveSkillToolLoop } from './live-skill-tool-loop.ts'
import { preparedCorpusProgressive } from './prepared-corpus-progressive.ts'
import { progressiveToolLoop } from './progressive-tool-loop.ts'
import { steeringMultiTurn } from './steering-multi-turn.ts'

export function skillStressScenarios(): readonly StressScenario[] {
  return Object.freeze([
    {
      id: 'progressive-tool-loop', kind: 'offline',
      description: 'Proves metadata-only discovery, selected activation, targeted resource I/O, and host tools.',
      run: progressiveToolLoop,
    },
    {
      id: 'harness-folder-rounds', kind: 'offline',
      description: 'Rediscovers one configured skill folder across turns while preserving selected context.',
      run: harnessFolderRounds,
    },
    {
      id: 'defined-agent-web-skills', kind: 'offline',
      description: 'Scopes a session-provided web skill store to ids declared by one reusable agent.',
      run: definedAgentWebSkills,
    },
    {
      id: 'compaction-trace', kind: 'offline',
      description: 'Forces a checkpoint and verifies memory, catalog, and compact trace ancestry.',
      run: compactionTrace,
    },
    {
      id: 'steering-multi-turn', kind: 'offline',
      description: 'Queues steering after a skill tool result and continues through a second user turn.',
      run: steeringMultiTurn,
    },
    {
      id: 'cancellation-recovery', kind: 'offline',
      description: 'Aborts a running host tool, verifies paired history/trace, then reuses the session.',
      run: cancellationRecovery,
    },
    {
      id: 'prepared-corpus-progressive', kind: 'registry',
      description: 'Runs progressive disclosure against the pinned skills.sh corpus without a live provider.',
      run: preparedCorpusProgressive,
    },
    {
      id: 'live-skill-tool-loop', kind: 'live',
      description: 'Asks a real provider to activate a prepared skills.sh skill and verify a workspace artifact.',
      run: liveSkillToolLoop,
    },
  ])
}
