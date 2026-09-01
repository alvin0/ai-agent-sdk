import { access } from 'node:fs/promises'
import { createOfflineRegistry, createStressAgent, createStressSession } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import { ScriptedStressAdapter } from '../scripted-adapter.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume, orderedSubsequence } from './shared.ts'

const ROOT_CAUSE_PROBE = 'Trace backward through the call chain until you find the original trigger'
const PINNED_SKILL_IDS = Object.freeze([
  'playwright-skill', 'systematic-debugging', 'vercel-react-best-practices',
])

export async function preparedCorpusProgressive(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const observer = new StressObserver(context.paths.report, { rootCause: ROOT_CAUSE_PROBE })
  const checks = new InvariantRecorder()
  try {
    await access(context.config.skillsRoot)
    const adapter = new ScriptedStressAdapter({
      rounds: [
        {
          reasoning: 'Only systematic-debugging matches this deterministic routing request.',
          commentary: 'Load the selected skill before reading a supporting reference.',
          toolCalls: [{ name: 'load_skill', arguments: { skillId: 'systematic-debugging' } }],
        },
        {
          commentary: 'Read only the root-cause overview referenced by the loaded manifest.',
          toolCalls: [{
            name: 'read_skill_resource',
            arguments: {
              skillId: 'systematic-debugging', path: 'root-cause-tracing.md', section: 'Overview',
            },
          }],
        },
        { finalText: 'Pinned registry skill and selected resource verified.' },
      ],
      onRequest(request, kind) { if (kind === 'compaction') observer.recordRequest(request, kind) },
    })
    const agent = createStressAgent({
      id: `stress_registry_${context.seed}`,
      provider: 'stress', model: 'scripted', effort: 'medium',
      skillRoots: [context.config.skillsRoot], maxTurns: 6, maxToolCalls: 8,
      compaction: false, observer,
    })
    const session = createStressSession(
      agent, createOfflineRegistry(adapter), context.paths.workspace, observer,
    )
    const discovered = await session.skills?.discover({
      cwd: context.paths.workspace, signal: context.signal,
    }) ?? []
    const outcome = await consume(
      session, 'Diagnose a deep failure with the prepared systematic debugging skill.', observer, context.signal,
    )
    const requests = observer.requests().filter(request => request.kind === 'model')
    const first = requests[0]
    const afterLoad = requests.find(request => request.messagesHaveSkillContent)
    const afterResource = requests.find(request => request.probes.rootCause?.messages === true)
    const activationIds = observer.skillIo().flatMap(event =>
      event.phase === 'activation' && event.operation === 'read' && event.skillId !== undefined
        ? [event.skillId] : [])
    const resourceReads = observer.skillIo().filter(event =>
      event.phase === 'resource' && event.operation === 'read' && (event.bytesRead ?? 0) > 0)

    checks.check('all three pinned skills.sh ids are discovered',
      discovered.map(skill => skill.id).join(',') === PINNED_SKILL_IDS.join(','),
      `discovered=${discovered.map(skill => skill.id).join(',')}`)
    checks.check('prepared corpus initial request is metadata-only',
      first?.systemHasCatalog === true && first.systemHasSkillContent === false
      && first.messagesHaveSkillContent === false && first.probes.rootCause?.messages === false)
    checks.check('only the selected prepared skill body is activated',
      activationIds.length > 0 && activationIds.every(id => id === 'systematic-debugging'),
      `activated=${[...new Set(activationIds)].join(',')}`)
    checks.check('selected body appears after load_skill', afterLoad !== undefined
      && (afterLoad?.ordinal ?? 0) > (first?.ordinal ?? 0))
    checks.check('root cause reference appears only after targeted read', afterResource !== undefined
      && (afterResource?.ordinal ?? 0) > (afterLoad?.ordinal ?? 0))
    checks.check('only root-cause-tracing.md resource content is read',
      resourceReads.length === 1 && resourceReads[0]?.path.endsWith('root-cause-tracing.md') === true,
      `resourceReads=${resourceReads.map(event => event.path).join(',')}`)
    checks.check('prepared corpus uses the real skill tool loop', orderedSubsequence(observer.toolNames(), [
      'load_skill', 'read_skill_resource',
    ]))
    checks.check('prepared corpus trace has no missing, duplicate, or orphan spans',
      observer.traceProblems().length === 0, observer.traceProblems().join('; '))
    checks.check('scripted registry turn completes', outcome?.reason.kind === 'completed')
    return {
      invariants: checks.items(),
      metrics: { ...observer.metrics(), discoveredSkills: discovered.length },
    }
  } finally {
    await observer.flush()
  }
}
