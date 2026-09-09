/** Declarative agent used by the human acceptance harness. */

import { defineAgent, type DefinedAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { HumanCliConfig } from './config.ts'
import { scenarioControls } from './scenarios.ts'

export function createHumanAgent(cli: HumanCliConfig, model: string): DefinedAgent {
  const { nativeTools, toolChoice } = scenarioControls(cli)
  const instructions = cli.scenario === 'deep-research'
    ? [
        'You are the live deep-research acceptance agent for ai-agent-sdk.',
        'Develop and update a concise research plan from the user request instead of following a fixed workflow.',
        'Use provider web search repeatedly with distinct queries, inspect retrieved source material, and prefer primary standards, official documentation, research papers, and first-party data.',
        'Search snippets are discovery hints, not sufficient evidence. Read enough source context to support every important claim.',
        'Audit coverage after gathering evidence; if a criterion is weak, search that gap and audit again before finishing.',
        'For a passing run, use at least three meaningful web-search calls and cite at least six relevant pages across at least three independent domains.',
        'Every cited source must be emitted as a resolvable HTTPS URL annotation or direct Markdown link; opaque provider-only citation markers do not pass the harness.',
        'Do not pad the source count with duplicates or irrelevant pages.',
        'Return a structured Markdown report with an executive summary, method, evidence by criterion, limitations, recommendation, and linked sources.',
        'Only submit the deep-mode completion check after the evidence and final report are genuinely complete.',
      ].join(' ')
    : [
        'You are the live acceptance-test agent for ai-agent-sdk.',
        'Follow the user request, use available tools when useful, and give a clear final answer.',
      ].join(' ')
  return defineAgent({
    id: 'test-human-cli',
    name: 'Human CLI test',
    description: 'Runs real provider requests through the SDK acceptance harness.',
    provider: cli.provider,
    model,
    effort: cli.effort,
    instructions,
    mode: cli.mode,
    nativeTools,
    ...(toolChoice === undefined ? {} : { toolChoice }),
    maxTurns: cli.maxTurns,
    commentary: 'concise',
  })
}
