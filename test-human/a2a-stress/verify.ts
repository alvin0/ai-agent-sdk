import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentTeam } from '@ai-agent-sdk/core/agent'
import type { A2AStressMode } from './config.ts'
import { verifyA2AStressFixtureIntegrity, type A2AStressPaths } from './fixture.ts'
import { A2AStressObserver } from './observer.ts'
import { EXPECTED_SIGNALS, EXPECTED_WORKERS, FINAL_DECISION } from './prompts.ts'
import { resolveA2AStressCommand } from './security.ts'

export interface A2AStressInvariant {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface A2AStressVerification {
  readonly mode: A2AStressMode
  readonly passed: boolean
  readonly invariants: readonly A2AStressInvariant[]
}

interface FeatureContract {
  readonly marker: string
  readonly exports: readonly string[]
  readonly behaviorTokens: readonly string[]
}

const FEATURE_CONTRACTS: Readonly<Record<typeof EXPECTED_WORKERS[number], FeatureContract>> = {
  delivery: {
    marker: 'data-feature="delivery-board"',
    exports: ['mountDelivery', 'filterTasks', 'nextStatus'],
    behaviorTokens: ['store.update', 'addEventListener', 'blocked', 'due', 'activity'],
  },
  analytics: {
    marker: 'data-feature="forecast-lab"',
    exports: ['mountAnalytics', 'calculateMetrics', 'forecastWeeks'],
    behaviorTokens: ['store.update', '<svg', 'weeklyCapacity', 'riskMultiplier'],
  },
  collaboration: {
    marker: 'data-feature="decision-center"',
    exports: ['mountCollaboration', 'filterActivity', 'serializeSnapshot'],
    behaviorTokens: ['store.update', 'Blob', 'createObjectURL', 'activity', 'decisions'],
  },
}

export async function verifyA2AStress(input: {
  readonly mode: A2AStressMode
  readonly paths: A2AStressPaths
  readonly observer: A2AStressObserver
  readonly team: AgentTeam
}): Promise<A2AStressVerification> {
  const checks: A2AStressInvariant[] = []
  const check = (name: string, passed: boolean, detail?: string): void => {
    checks.push(Object.freeze({ name, passed, ...(detail === undefined ? {} : { detail }) }))
  }

  for (const [index, worker] of EXPECTED_WORKERS.entries()) {
    const signal = EXPECTED_SIGNALS[index]
    const contract = FEATURE_CONTRACTS[worker]
    const sourcePath = join(input.paths.workspace, 'src', 'features', `${worker}.js`)
    const testPath = join(input.paths.workspace, 'tests', `${worker}.test.mjs`)
    const handoffPath = join(input.paths.workspace, 'docs', `${worker}.md`)
    const [source, test, handoff] = await Promise.all([
      optionalRead(sourcePath), optionalRead(testPath), optionalRead(handoffPath),
    ])

    check(`${worker} completed as a real agent`, input.observer.completed(worker))
    for (const tool of ['list_files', 'grep_files', 'read_file', 'write_file', 'run_command']) {
      check(`${worker} called ${tool}`, input.observer.toolCount(worker, tool) > 0)
    }
    check(`${worker} crossed and completed automatic compaction`,
      input.observer.compactions(worker).starts > 0
      && input.observer.compactions(worker).ends > 0,
      JSON.stringify(input.observer.compactions(worker)))
    check(`${worker} produced a substantial website feature`,
      (source?.length ?? 0) >= 1_200 && source?.includes(contract.marker) === true,
      `chars=${source?.length ?? 0}; marker=${contract.marker}`)
    for (const exported of contract.exports) {
      check(`${worker} exports ${exported}`, hasNamedExport(source, exported))
    }
    check(`${worker} implements its required browser interactions`,
      contract.behaviorTokens.every(token => source?.includes(token) === true),
      `required=${contract.behaviorTokens.join(',')}`)
    check(`${worker} produced an executable unit test`,
      (test?.length ?? 0) >= 300
      && test?.includes(`../src/features/${worker}.js`) === true
      && test?.includes('node:assert') === true
      && (test?.match(/\btest\s*\(/g)?.length ?? 0) >= 2)
    check(`${worker} wrote merge-ready handoff ${String(signal)}`,
      (handoff?.length ?? 0) >= 120 && handoff?.includes(String(signal)) === true)
  }

  const coordinator = 'coordinator'
  check('coordinator completed', input.observer.completed(coordinator))
  check('coordinator wrote integration source, design, and MVP report',
    input.observer.toolCount(coordinator, 'write_file') >= 3,
    `write_file=${input.observer.toolCount(coordinator, 'write_file')}`)
  check('coordinator inspected worker code and handoffs',
    input.observer.toolCount(coordinator, 'read_file') >= 9,
    `read_file=${input.observer.toolCount(coordinator, 'read_file')}`)
  check('coordinator invoked full test and build gates',
    input.observer.toolCount(coordinator, 'run_command') >= 2,
    `run_command=${input.observer.toolCount(coordinator, 'run_command')}`)

  if (input.mode === 'managed') {
    check('managed coordinator spawned exactly three product engineers',
      input.observer.toolCount(coordinator, 'spawn_agent') === 3,
      `spawn_agent=${input.observer.toolCount(coordinator, 'spawn_agent')}`)
    check('all feature results returned through the coordinator tool loop',
      input.observer.toolResultCount(coordinator, 'spawn_agent') === 3,
      `spawn results=${input.observer.toolResultCount(coordinator, 'spawn_agent')}`)
    for (const worker of EXPECTED_WORKERS) {
      check(`managed task provenance reached ${worker}`,
        input.team.messages().some(message =>
          message.sender === coordinator && message.target === worker && message.delivery === 'quiet'))
    }
  } else {
    check('defined coordinator delegated to all three product engineers',
      input.observer.toolCount(coordinator, 'followup_task') === 3,
      `followup_task=${input.observer.toolCount(coordinator, 'followup_task')}`)
    check('defined coordinator waited for every feature slice',
      input.observer.toolCount(coordinator, 'wait_agents') > 0)
    for (const [index, worker] of EXPECTED_WORKERS.entries()) {
      const signal = EXPECTED_SIGNALS[index]
      check(`${worker} returned an attributed code handoff`,
        input.team.messages().some(message =>
          message.sender === worker && message.target === coordinator
          && JSON.stringify(message.content).includes(String(signal))))
    }
  }

  const [app, styles, final] = await Promise.all([
    optionalRead(join(input.paths.workspace, 'src', 'app.js')),
    optionalRead(join(input.paths.workspace, 'src', 'styles.css')),
    optionalRead(join(input.paths.workspace, 'docs', 'mvp-report.md')),
  ])
  check('integrated app is a real LaunchPad Ops shell',
    (app?.length ?? 0) >= 1_000
    && app?.includes('data-app="launchpad-ops"') === true
    && EXPECTED_WORKERS.every(worker => app.includes(`features/${worker}.js`)))
  check('all vertical slices are mounted by the coordinator',
    ['mountDelivery', 'mountAnalytics', 'mountCollaboration']
      .every(mount => app?.includes(mount) === true))
  check('responsive visual design artifact exists',
    (styles?.length ?? 0) >= 2_000
    && styles?.includes('@media') === true
    && styles?.includes(':focus') === true)
  check(`MVP report states ${FINAL_DECISION}`, final?.includes(FINAL_DECISION) === true)
  for (const signal of EXPECTED_SIGNALS) {
    check(`MVP report preserves ${signal}`, final?.includes(signal) === true)
  }

  const integrity = await verifyA2AStressFixtureIntegrity(input.paths)
  check('host-owned fixture and acceptance scripts remain unchanged',
    integrity.passed, integrity.detail)
  const unitGate = await runAllowedGate(input.paths.workspace, ['test'])
  check('permission-isolated website unit gate passes', unitGate.passed, unitGate.detail)
  const buildGate = await runAllowedGate(input.paths.workspace, ['run', 'build'])
  check('permission-isolated host build gate passes', buildGate.passed, buildGate.detail)
  check('dist/ contains the built website',
    await isNonEmptyFile(join(input.paths.workspace, 'dist', 'index.html'))
    && await isNonEmptyFile(join(input.paths.workspace, 'dist', 'src', 'app.js')))
  check('no roster member ended in failed state',
    input.team.members().every(member => member.status !== 'failed'),
    JSON.stringify(input.team.members()))

  const verification = Object.freeze({
    mode: input.mode,
    passed: checks.every(item => item.passed),
    invariants: Object.freeze(checks),
  })
  await writeFile(
    join(input.paths.results, 'verification.json'),
    `${JSON.stringify(verification, null, 2)}\n`,
    'utf8',
  )
  return verification
}

async function optionalRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return undefined
    throw error
  }
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() && (await stat(path)).size > 0 }
  catch { return false }
}

function runAllowedGate(cwd: string, npmArgs: readonly string[]): Promise<{ passed: boolean; detail: string }> {
  const invocation = resolveA2AStressCommand('coordinator', {
    command: 'npm', args: npmArgs, cwd, workspaceRoot: cwd, timeoutMs: 120_000,
  })
  return new Promise(resolveRun => {
    execFile(invocation.executable, [...invocation.args], {
      cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      ...(invocation.env === undefined ? {} : { env: invocation.env }),
    }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim()
      resolveRun({
        passed: error === null,
        detail: `${invocation.executable} ${invocation.args.join(' ')}\n${output}`.slice(0, 8_000),
      })
    })
  })
}

function hasNamedExport(source: string | undefined, name: string): boolean {
  if (source === undefined) return false
  return new RegExp(`export\\s+(?:(?:async\\s+)?function|const|let|class)\\s+${name}\\b`)
    .test(source)
}
