import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOfflineRegistry, createStressAgent, createStressSession } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import { ScriptedStressAdapter } from '../scripted-adapter.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume } from './shared.ts'

const FIRST_ID = 'folder-round-one'
const SECOND_ID = 'folder-round-two'
const FIRST_BODY = 'HARNESS_FOLDER_BODY_FIRST_81cb7e'
const SECOND_BODY = 'HARNESS_FOLDER_BODY_SECOND_28a4df'

/**
 * Harness acceptance: one explicit folder is rediscovered on every user turn.
 * Existing selected instructions stay in conversation history, while a newly
 * added folder contributes metadata only until the model selects it.
 */
export async function harnessFolderRounds(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const observer = new StressObserver(context.paths.report, {
    firstBody: FIRST_BODY,
    secondBody: SECOND_BODY,
  })
  const checks = new InvariantRecorder()
  try {
    await writeSkill(context.paths.skills, FIRST_ID, FIRST_BODY)
    const adapter = new ScriptedStressAdapter({
      rounds: [
        {
          commentary: 'The first request matches the first folder skill.',
          toolCalls: [{ name: 'load_skill', arguments: { skillId: FIRST_ID } }],
        },
        { finalText: 'First folder-backed round completed.' },
        {
          commentary: 'A new skill is now advertised for the second request.',
          toolCalls: [{ name: 'load_skill', arguments: { skillId: SECOND_ID } }],
        },
        { finalText: 'Second folder-backed round completed.' },
      ],
    })
    const agent = createStressAgent({
      id: `stress_folder_rounds_${context.seed}`,
      provider: 'stress', model: 'scripted', effort: 'medium',
      skillRoots: [context.paths.skills], maxTurns: 8, maxToolCalls: 8,
      compaction: false, observer,
    })
    const session = createStressSession(
      agent, createOfflineRegistry(adapter), context.paths.workspace, observer,
    )

    const first = await consume(
      session, 'Use the folder-backed workflow for the first round.', observer, context.signal,
    )
    const loadsAfterFirst = activationIds(observer)
    await writeSkill(context.paths.skills, SECOND_ID, SECOND_BODY)
    const second = await consume(
      session, 'A second workflow was added. Use it for this round.', observer, context.signal,
    )

    const requests = observer.requests().filter(request => request.kind === 'model')
    const firstInitial = requests[0]
    const firstAfterLoad = requests[1]
    const secondInitial = requests[2]
    const secondAfterLoad = requests[3]
    const currentIds = session.skills?.summaries().map(skill => skill.id) ?? []
    const allActivations = activationIds(observer)

    checks.check('first round discovers only the skill initially present in the configured folder',
      adapter.requests[0]?.system?.includes(FIRST_ID) === true
      && adapter.requests[0]?.system?.includes(SECOND_ID) === false)
    checks.check('first round starts with metadata but no skill body',
      firstInitial?.systemHasCatalog === true
      && firstInitial.probes.firstBody?.messages === false
      && firstInitial.probes.secondBody?.messages === false)
    checks.check('first skill body enters context only after load_skill',
      firstAfterLoad?.probes.firstBody?.messages === true)
    checks.check('only the first skill is activated during the first round',
      loadsAfterFirst.join(',') === FIRST_ID, `activated=${loadsAfterFirst.join(',')}`)
    checks.check('second round automatically rediscovers the newly added folder',
      adapter.requests[2]?.system?.includes(SECOND_ID) === true
      && currentIds.join(',') === `${FIRST_ID},${SECOND_ID}`,
      `catalog=${currentIds.join(',')}`)
    checks.check('previously loaded instructions remain available across rounds',
      secondInitial?.probes.firstBody?.messages === true)
    checks.check('newly discovered instructions remain absent until selected',
      secondInitial?.probes.secondBody?.messages === false
      && secondAfterLoad?.probes.secondBody?.messages === true)
    checks.check('filesystem activation reads only the two skills selected by the model',
      allActivations.join(',') === `${FIRST_ID},${SECOND_ID}`,
      `activated=${allActivations.join(',')}`)
    checks.check('both conversation rounds complete',
      first?.reason.kind === 'completed' && second?.reason.kind === 'completed')
    checks.check('folder-round trace remains complete',
      observer.traceProblems().length === 0, observer.traceProblems().join('; '))
    return {
      invariants: checks.items(),
      metrics: { ...observer.metrics(), rounds: 2, catalogSkills: currentIds.length },
    }
  } finally {
    await observer.flush()
  }
}

async function writeSkill(root: string, id: string, bodyProbe: string): Promise<void> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---', `name: ${id}`,
    `description: Use only for the deterministic ${id} request.`,
    '---', `# ${id}`, bodyProbe,
    'Apply these instructions only after this skill is selected.', '',
  ].join('\n'), 'utf8')
}

function activationIds(observer: StressObserver): string[] {
  return [...new Set(observer.skillIo().flatMap(event =>
    event.phase === 'activation' && event.operation === 'read' && event.skillId !== undefined
      ? [event.skillId] : []))]
}
