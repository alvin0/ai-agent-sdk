import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentTeam,
  createDefinedAgentTeam,
  createManagedAgentTeam,
} from '@alvin0/ai-agent-sdk-core/agent'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentCompactionOptions } from '@alvin0/ai-agent-sdk-core/agent'
import { createHumanModelRegistry } from '../providers.ts'
import type { A2AStressConfig } from './config.ts'
import { humanConfigForA2AStress } from './config.ts'
import { a2aStressPaths, prepareA2AStressFixture } from './fixture.ts'
import { A2AStressObserver } from './observer.ts'
import {
  DEFINED_STRESS_PROMPT,
  MANAGED_STRESS_PROMPT,
  MANAGED_WORKER_INSTRUCTIONS,
  specialistInstructions,
} from './prompts.ts'
import { verifyA2AStress, type A2AStressVerification } from './verify.ts'
import { createA2AStressTools, type A2AStressActor } from './security.ts'

export interface A2AStressRunResult {
  readonly verification: A2AStressVerification
  readonly workspace: string
  readonly results: string
  readonly finalText: string
}

export async function runManagedA2AStress(
  config: A2AStressConfig,
  signal: AbortSignal,
): Promise<A2AStressRunResult> {
  const paths = a2aStressPaths(config.runId, 'managed')
  await prepareA2AStressFixture(paths)
  const observer = new A2AStressObserver(paths.results)
  const registry = createHumanModelRegistry(humanConfigForA2AStress(config), {
    requestLogRoot: join(paths.results, 'provider-logs'),
    aggregateRequestLogs: false,
  })
  const coordinatorTools = createA2AStressTools(paths.workspace, 'coordinator')
  const compaction = compactionOptions(config)
  const lead = defineAgent({
    id: 'managed_coordinator',
    name: 'LaunchPad Dynamic Lead Engineer',
    provider: config.provider,
    model: config.model,
    effort: config.effort,
    instructions: [
      'You own the integrated LaunchPad Ops website and its release gates.',
      'Use dynamic workers for independent vertical slices and integrate only verified code artifacts.',
      'Follow every orchestration constraint in the user objective.',
    ].join(' '),
    maxTurns: config.maxTurns,
    maxToolCalls: config.maxToolCalls,
    commentary: 'concise',
    compaction,
  })
  const workerTemplate = defineAgent({
    id: 'launchpad_worker_template',
    name: 'LaunchPad Dynamic Product Engineer',
    provider: config.provider,
    model: config.model,
    effort: config.effort,
    instructions: MANAGED_WORKER_INSTRUCTIONS,
    maxTurns: config.maxTurns,
    maxToolCalls: config.maxToolCalls,
    commentary: 'concise',
    compaction,
  })
  const harness = createManagedAgentTeam({
    registry,
    lead,
    leadName: 'coordinator',
    workerTemplate,
    maxWorkers: 3,
    team: {
      id: `human-managed-${config.runId}`,
      maxMembers: 4,
      onEvent: event => observer.recordTeam(event),
    },
    leadSessionOptions: { tools: coordinatorTools, compaction },
    workerSessionOptions: { compaction },
    workerSessionOptionsFactory: request => ({
      tools: createA2AStressTools(paths.workspace, stressActor(request.name)),
    }),
    onWorkerEvent: (worker, event) => { observer.recordAgent(worker, event) },
  })

  await persistInputs(paths.results, config, MANAGED_STRESS_PROMPT)
  let finalText = ''
  try {
    const response = await harness.run(MANAGED_STRESS_PROMPT, {
      signal,
      onEvent: event => { observer.recordAgent('coordinator', event) },
    })
    finalText = response.text
    const verification = await verifyA2AStress({
      mode: 'managed', paths, observer, team: harness.team,
    })
    await observer.flush({ verification, roster: harness.team.members(), workers: harness.workers() })
    return { verification, workspace: paths.workspace, results: paths.results, finalText }
  } catch (error: unknown) {
    await observer.flush({ error: errorMessage(error), roster: harness.team.members(), workers: harness.workers() })
    throw error
  } finally {
    await harness.team.dispose(new Error('managed A2A stress run finished'))
  }
}

export async function runDefinedA2AStress(
  config: A2AStressConfig,
  signal: AbortSignal,
): Promise<A2AStressRunResult> {
  const paths = a2aStressPaths(config.runId, 'defined')
  await prepareA2AStressFixture(paths)
  const observer = new A2AStressObserver(paths.results)
  const registry = createHumanModelRegistry(humanConfigForA2AStress(config), {
    requestLogRoot: join(paths.results, 'provider-logs'),
    aggregateRequestLogs: false,
  })
  const compaction = compactionOptions(config)
  const team = new AgentTeam({
    id: `human-defined-${config.runId}`,
    maxMembers: 4,
    onEvent: event => observer.recordTeam(event),
    onAgentEvent: (member, event) => { observer.recordAgent(member, event) },
  })
  const composed = createDefinedAgentTeam({
    registry,
    team,
    sessionOptions: { compaction },
    members: [
      {
        agent: defineAgent({
          id: 'defined_coordinator',
          name: 'LaunchPad Stable Lead Engineer',
          provider: config.provider,
          model: config.model,
          effort: config.effort,
          instructions: [
            'Coordinate only the predefined LaunchPad product engineers.',
            'Delegate their standing vertical slices, wait for completion, verify attributed code handoffs, and own integration.',
          ].join(' '),
          maxTurns: config.maxTurns,
          maxToolCalls: config.maxToolCalls,
          commentary: 'concise',
          compaction,
        }),
        name: 'coordinator',
        role: 'lead',
        sessionOptions: { tools: createA2AStressTools(paths.workspace, 'coordinator') },
      },
      ...(['delivery', 'analytics', 'collaboration'] as const).map(name => ({
        agent: defineAgent({
          id: `defined_${name}`,
          name: `LaunchPad ${name} product engineer`,
          provider: config.provider,
          model: config.model,
          effort: config.effort,
          instructions: specialistInstructions(name),
          maxTurns: config.maxTurns,
          maxToolCalls: config.maxToolCalls,
          commentary: 'concise' as const,
          compaction,
        }),
        name,
        role: 'peer' as const,
        sessionOptions: { tools: createA2AStressTools(paths.workspace, name) },
      })),
    ],
  })

  await persistInputs(paths.results, config, DEFINED_STRESS_PROMPT)
  let finalText = ''
  try {
    const response = await composed.run('coordinator', DEFINED_STRESS_PROMPT, {
      signal,
      onEvent: event => { observer.recordAgent('coordinator', event) },
    })
    finalText = response.text
    await Promise.all(['delivery', 'analytics', 'collaboration'].map(name =>
      team.whenIdle(name, signal)))
    const verification = await verifyA2AStress({ mode: 'defined', paths, observer, team })
    await observer.flush({ verification, roster: team.members() })
    return { verification, workspace: paths.workspace, results: paths.results, finalText }
  } catch (error: unknown) {
    await observer.flush({ error: errorMessage(error), roster: team.members() })
    throw error
  } finally {
    await team.dispose(new Error('defined A2A stress run finished'))
  }
}

function compactionOptions(config: A2AStressConfig): AgentCompactionOptions {
  return {
    auto: true,
    maxInputTokens: config.maxInputTokens,
    retainTokens: config.retainTokens,
    maxSummaryTokens: 1_200,
    maxSummaryInputChars: 16_000,
    maxToolResultChars: 20_000,
    compactionRetries: 1,
    maxOverflowRetries: 1,
  }
}

async function persistInputs(
  results: string,
  config: A2AStressConfig,
  prompt: string,
): Promise<void> {
  await mkdir(results, { recursive: true })
  await Promise.all([
    writeFile(join(results, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8'),
    writeFile(join(results, 'prompt.md'), `${prompt}\n`, 'utf8'),
  ])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stressActor(value: string): A2AStressActor {
  if (value === 'delivery' || value === 'analytics' || value === 'collaboration') return value
  throw new Error(`managed A2A worker name is not allowlisted: ${value}`)
}
