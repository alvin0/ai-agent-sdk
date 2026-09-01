/** Declarative agent used by the human acceptance harness. */

import { defineAgent, type DefinedAgent } from '../src/agent/define/index.ts'
import type { HumanCliConfig } from './config.ts'
import { scenarioControls } from './scenarios.ts'

export function createHumanAgent(cli: HumanCliConfig, model: string): DefinedAgent {
  const { nativeTools, toolChoice } = scenarioControls(cli)
  return defineAgent({
    id: 'test-human-cli',
    name: 'Human CLI test',
    description: 'Runs real provider requests through the SDK acceptance harness.',
    provider: cli.provider,
    model,
    effort: cli.effort,
    instructions: [
      'You are the live acceptance-test agent for ai-agent-sdk.',
      'Follow the user request, use available tools when useful, and give a clear final answer.',
    ].join(' '),
    mode: cli.mode,
    nativeTools,
    ...(toolChoice === undefined ? {} : { toolChoice }),
    maxTurns: cli.maxTurns,
    commentary: 'concise',
  })
}
