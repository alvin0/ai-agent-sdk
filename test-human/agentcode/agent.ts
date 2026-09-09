/** Declarative code agent configured to exercise tools, durable memory, and compaction. */

import { defineAgent, type DefinedAgent } from '@ai-agent-sdk/core/agent'
import {
  fileSystemSkills,
  type FileSystemSkillIoEvent,
} from '@ai-agent-sdk/skill-filesystem'
import type { AgentCodeCliConfig } from './config.ts'

export interface CreateAgentCodeAgentOptions {
  /** Optional shallow/activation/resource telemetry for human acceptance reports. */
  readonly onSkillIo?: (event: FileSystemSkillIoEvent) => void
}

export function createAgentCodeAgent(
  config: AgentCodeCliConfig,
  model: string,
  options: CreateAgentCodeAgentOptions = {},
): DefinedAgent {
  const objective = config.prompt ?? 'Build and verify the requested application.'
  const preparedSkillRoots = config.skillRoots ?? []
  return defineAgent({
    id: 'test-human-agentcode',
    name: 'AgentCode acceptance test',
    description: 'Builds a real project while exercising host tools, task memory, and context compaction.',
    provider: config.provider,
    model,
    effort: config.effort,
    mode: 'deep',
    maxTurns: config.maxTurns,
    maxToolCalls: config.maxToolCalls,
    commentary: 'concise',
    skills: [
      fileSystemSkills({
        cwd: config.workdir,
        includeProjectAgents: true,
        includeProjectDsh: true,
        includeUserAgents: false,
        ...(options.onSkillIo === undefined ? {} : { onIo: options.onSkillIo }),
      }),
      ...(preparedSkillRoots.length === 0 ? [] : [fileSystemSkills({
        id: 'skills-sh-filesystem',
        roots: preparedSkillRoots.map((path, index) => ({
          path,
          source: `skills-sh-${index + 1}`,
        })),
        ...(options.onSkillIo === undefined ? {} : { onIo: options.onSkillIo }),
      })]),
    ],
    instructions: [
      'You are AgentCode, a long-running coding acceptance-test agent.',
      'Work only through the provided workspace tools. First inspect the workspace, then make a small plan and implement the request completely.',
      'Use list_files and read_file to understand existing work. Use write_file for new files and replace_in_file for precise edits. Use grep_files to locate symbols and run_command for npm scaffolding, installs, tests, and builds.',
      'Do not use shell syntax in run_command args. Never assume a command succeeded: inspect its exitCode and fix failures.',
      'Use the available skill catalog when it materially matches the task. Load only the relevant skills, follow their workflows, and read individual skill resources only when their instructions require them.',
      'Keep files focused and production-readable. Follow the active task and existing workspace domain; do not carry assumptions from the default Todo example into a different project.',
      'Before completion, run an appropriate build or test and report concrete evidence. If the workspace already contains partial work, preserve and improve it.',
      'Do not reread unchanged files after their relevant contents are known. Avoid broad searches over dependency metadata, move from inspection to edits promptly, and reserve the final tool calls for tests, build, and lint.',
      'The original objective and constraints are pinned in task memory. After compaction, continue from the checkpoint without restarting completed work.',
    ].join(' '),
    memory: {
      autoCaptureObjective: true,
      maxInjectedChars: 8_000,
      seed: [
        { id: 'agentcode-objective', kind: 'objective', content: objective },
        { id: 'workspace-boundary', kind: 'constraint', content: 'All created and edited project files must remain inside the configured agentcode workspace.' },
        { id: 'verification-required', kind: 'constraint', content: 'Do not claim completion until an npm build or test has succeeded and its result has been observed.' },
      ],
    },
    compaction: {
      auto: true,
      maxInputTokens: config.maxInputTokens,
      retainTokens: config.retainTokens,
      maxSummaryTokens: 2_048,
      maxSummaryInputChars: 10_000,
      maxToolResultChars: 12_000,
      compactionRetries: 1,
      maxOverflowRetries: 1,
    },
  })
}
