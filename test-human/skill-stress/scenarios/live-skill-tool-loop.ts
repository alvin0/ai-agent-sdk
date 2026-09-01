import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLiveRegistry, createStressAgent, createStressSession } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume, optionalRead, orderedSubsequence } from './shared.ts'

export async function liveSkillToolLoop(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const artifactProbe = `LIVE_SKILL_STRESS_${context.seed}`
  const observer = new StressObserver(context.paths.report, { artifact: artifactProbe })
  const checks = new InvariantRecorder()
  try {
    await access(context.config.skillsRoot)
    await seedLiveDebugWorkspace(context.paths.workspace)
    const agent = createStressAgent({
      id: `stress_live_${context.seed}`,
      provider: context.config.provider, model: context.config.model, effort: context.config.effort,
      mode: 'deep', skillRoots: [context.config.skillsRoot],
      maxTurns: context.config.maxTurns, maxToolCalls: context.config.maxToolCalls,
      compaction: {
        auto: true,
        maxInputTokens: context.config.maxInputTokens,
        retainTokens: context.config.retainTokens,
        maxSummaryTokens: 2_048,
      },
      observer,
    })
    const session = createStressSession(
      agent, createLiveRegistry(context.config, join(context.paths.report, 'providers')),
      context.paths.workspace, observer,
    )
    const discovered = await session.skills?.discover({ cwd: context.paths.workspace, signal: context.signal }) ?? []
    const selected = discovered.find(skill =>
      skill.id === 'systematic-debugging' && skill.invocation.modelInvocable)
      ?? discovered.find(skill => skill.invocation.modelInvocable)
    if (selected === undefined) throw new Error(`no model-invocable skill found under ${context.config.skillsRoot}`)
    const prompt = [
      `This is an acceptance test. Call load_skill with exactly "${selected.id}" before doing other work.`,
      'The workspace contains a deliberately failing npm test. Run npm test first and observe the failure, diagnose it using the loaded skill, make the smallest source fix, then run npm test again and observe success.',
      `After the green test, create stress-live-proof.txt with write_file and include the exact marker ${artifactProbe}.`,
      'Read stress-live-proof.txt back with read_file, inspect the result, and only then submit completion with concrete evidence.',
      'Do not inspect the skill directory with list_files or read_file.',
    ].join(' ')
    const outcome = await consume(session, prompt, observer, context.signal)
    const toolNames = observer.toolNames()
    const first = observer.requests().find(request => request.kind === 'model')
    const later = observer.requests().find(request => request.messagesHaveSkillContent)
    const artifact = await optionalRead(join(context.paths.workspace, 'stress-live-proof.txt'))
    const toolErrors = observer.events().filter(event => event.type === 'tool-result' && event.result.isError)
    const commandResults = observer.events().flatMap(event =>
      event.type === 'tool-result' && event.call.toolName === 'run_command' && !event.result.isError
        ? [event.result.value] : [])
    const activationIds = observer.skillIo().flatMap(event =>
      event.phase === 'activation' && event.operation === 'read' && event.skillId !== undefined
        ? [event.skillId] : [])

    checks.check('prepared catalog discovers at least one model-invocable skill', selected !== undefined)
    checks.check('initial live request exposes catalog metadata but not loaded skill content',
      first?.systemHasCatalog === true && first.systemHasSkillContent === false
      && first.messagesHaveSkillContent === false)
    checks.check('live model activates the selected skill', toolNames.includes('load_skill'))
    checks.check('filesystem activation reads only the selected skill body',
      activationIds.length > 0 && activationIds.every(id => id === selected.id),
      `activated=${[...new Set(activationIds)].join(',')}`)
    checks.check('loaded skill content appears only in a later request', later !== undefined
      && (later?.ordinal ?? 0) > (first?.ordinal ?? 0))
    checks.check('live model completes the host write/read tool loop', orderedSubsequence(toolNames, [
      'load_skill', 'run_command', 'write_file', 'read_file',
    ]))
    checks.check('live model observes both red and green npm test evidence',
      commandResults.some(result => {
        const code = processExitCode(result)
        return code !== undefined && code !== 0
      }) && commandResults.some(result => processExitCode(result) === 0))
    checks.check('live artifact contains the exact acceptance marker', artifact?.includes(artifactProbe) === true)
    checks.check('live tool calls finish without errors', toolErrors.length === 0,
      toolErrors.flatMap(event => event.type === 'tool-result' && event.result.isError
        ? [event.result.error.message] : []).join('; '))
    checks.check('deep-mode completion gate accepts the result', outcome?.completed === true)
    checks.check('live trace has no missing, duplicate, or orphan spans', observer.traceProblems().length === 0,
      observer.traceProblems().join('; '))
    return {
      invariants: checks.items(),
      metrics: { ...observer.metrics(), discoveredSkills: discovered.length, selectedSkill: selected.id },
    }
  } finally {
    await observer.flush()
  }
}

async function seedLiveDebugWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, 'src'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace, 'package.json'), `${JSON.stringify({
      name: 'skill-stress-debug-fixture', private: true, type: 'module',
      scripts: { test: 'node test.mjs' },
    }, null, 2)}\n`, 'utf8'),
    writeFile(join(workspace, 'src', 'counter.js'), [
      'export function add(left, right) {', '  return left - right', '}', '',
    ].join('\n'), 'utf8'),
    writeFile(join(workspace, 'test.mjs'), [
      "import assert from 'node:assert/strict'",
      "import { add } from './src/counter.js'",
      'assert.equal(add(5, 3), 8)',
      "console.log('counter fixture passed')", '',
    ].join('\n'), 'utf8'),
  ])
}

function processExitCode(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('exitCode' in value)) return undefined
  const exitCode = (value as { exitCode?: unknown }).exitCode
  return typeof exitCode === 'number' ? exitCode : undefined
}
