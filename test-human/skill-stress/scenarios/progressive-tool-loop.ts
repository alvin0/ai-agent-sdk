import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOfflineRegistry, createStressAgent, createStressSession } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import { ScriptedStressAdapter, type ScriptedRound } from '../scripted-adapter.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume, orderedSubsequence } from './shared.ts'

const FIXTURE_SKILL_ID = 'stress-progressive'
const BODY_PROBE = 'SKILL_BODY_PROBE_7f38d9f4'
const RESOURCE_PROBE = 'SKILL_RESOURCE_PROBE_a51c24e8'

export async function progressiveToolLoop(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const observer = new StressObserver(context.paths.report, {
    body: BODY_PROBE, resource: RESOURCE_PROBE,
  })
  const checks = new InvariantRecorder()
  try {
    const fixture = await writeProgressiveFixture(context.paths.skills)
    const rounds: ScriptedRound[] = [
      {
        reasoning: 'The request matches the advertised stress skill.',
        commentary: 'I will load only the matching skill instructions.',
        toolCalls: [{ name: 'load_skill', arguments: { skillId: FIXTURE_SKILL_ID } }],
      },
      {
        commentary: 'The manifest identifies one relevant reference.',
        toolCalls: [{
          name: 'read_skill_resource',
          arguments: { skillId: FIXTURE_SKILL_ID, path: 'references/detail.md', section: 'Required evidence' },
        }],
      },
      {
        commentary: 'I will persist evidence through the real workspace tool.',
        toolCalls: [{
          name: 'write_file',
          arguments: { path: 'stress-proof.txt', content: `${RESOURCE_PROBE}\nverified-by-tool-loop\n` },
        }],
      },
      {
        commentary: 'I will read the written artifact before reporting success.',
        toolCalls: [{ name: 'read_file', arguments: { path: 'stress-proof.txt' } }],
      },
      { finalText: 'Progressive disclosure and workspace verification completed.' },
    ]
    const adapter = new ScriptedStressAdapter({
      rounds,
      onRequest(request, kind) { if (kind === 'compaction') observer.recordRequest(request, kind) },
    })
    const agent = createStressAgent({
      id: `stress_progressive_${context.seed}`,
      provider: 'stress', model: 'scripted', effort: 'medium',
      skillRoots: [context.paths.skills], maxTurns: 8, maxToolCalls: 16,
      compaction: false, observer,
    })
    const session = createStressSession(
      agent, createOfflineRegistry(adapter), context.paths.workspace, observer,
    )
    const outcome = await consume(session, 'Use the progressive stress skill and produce verified evidence.', observer)
    const requests = observer.requests().filter(request => request.kind === 'model')
    const first = requests[0]
    const afterLoad = requests.find(request => request.probes.body?.messages === true)
    const afterResource = requests.find(request => request.probes.resource?.messages === true)
    const toolNames = observer.toolNames()
    const artifact = await readFile(join(context.paths.workspace, 'stress-proof.txt'), 'utf8')
    const skillSize = (await stat(fixture.skillFile)).size
    const discoveryBytes = bytesFor(observer, 'discovery', fixture.skillFile)
    const activationBytes = bytesFor(observer, 'activation', fixture.skillFile)
    const resourceBytes = bytesFor(observer, 'resource', fixture.resourceFile)

    checks.check('initial system contains metadata catalog', first?.systemHasCatalog === true)
    checks.check('initial system excludes skill body', first?.systemHasSkillContent === false
      && first.probes.body?.system === false && first.probes.body?.messages === false)
    checks.check('initial request excludes resource content', first?.probes.resource?.system === false
      && first.probes.resource?.messages === false)
    checks.check('selected body appears only after load_skill', afterLoad !== undefined
      && (afterLoad?.ordinal ?? 0) > (first?.ordinal ?? 0))
    checks.check('resource appears only after read_skill_resource', afterResource !== undefined
      && (afterResource?.ordinal ?? 0) > (afterLoad?.ordinal ?? 0))
    checks.check('real host write/read tools execute after skill tools', orderedSubsequence(toolNames, [
      'load_skill', 'read_skill_resource', 'write_file', 'read_file',
    ]))
    checks.check('tool-produced artifact contains requested evidence', artifact.includes(RESOURCE_PROBE))
    checks.check('turn completes normally', outcome?.reason.kind === 'completed')
    checks.check('provider reasoning summary remains observable', observer.events().some(event =>
      event.type === 'assistant-reasoning'))
    checks.check('trace has no missing, duplicate, or orphan spans', observer.traceProblems().length === 0,
      observer.traceProblems().join('; '))
    checks.check('trace includes host and skill tool spans', observer.events().filter(event =>
      event.type === 'span-start' && event.kind === 'execute_tool').length >= 4)
    checks.check('discovery reads a bounded prefix rather than the full SKILL.md',
      discoveryBytes > 0 && discoveryBytes < skillSize,
      `discovery=${discoveryBytes}, skill=${skillSize}`)
    checks.check('activation reads the selected SKILL.md body', activationBytes >= skillSize,
      `activation=${activationBytes}, skill=${skillSize}`)
    checks.check('resource content is read only in the resource phase', resourceBytes > 0
      && bytesFor(observer, 'discovery', fixture.resourceFile) === 0
      && bytesFor(observer, 'activation', fixture.resourceFile) === 0)
    return { invariants: checks.items(), metrics: observer.metrics() }
  } finally {
    await observer.flush()
  }
}

async function writeProgressiveFixture(root: string): Promise<{
  readonly skillFile: string
  readonly resourceFile: string
}> {
  const directory = join(root, FIXTURE_SKILL_ID)
  const resourceDirectory = join(directory, 'references')
  await mkdir(resourceDirectory, { recursive: true })
  const skillFile = join(directory, 'SKILL.md')
  const resourceFile = join(resourceDirectory, 'detail.md')
  const bodyPadding = 'Keep progressive disclosure bounded and deterministic. '.repeat(420)
  await writeFile(skillFile, [
    '---', `name: ${FIXTURE_SKILL_ID}`,
    'description: Use for the deterministic progressive disclosure acceptance task.',
    '---', '# Progressive stress workflow', bodyPadding, BODY_PROBE,
    'Read references/detail.md only after these instructions are activated.', '',
  ].join('\n'), 'utf8')
  await writeFile(resourceFile, [
    '# Reference', '## Required evidence', RESOURCE_PROBE, 'verified-by-targeted-resource-read', '',
  ].join('\n'), 'utf8')
  return { skillFile, resourceFile }
}

function bytesFor(
  observer: StressObserver,
  phase: 'discovery' | 'activation' | 'resource',
  path: string,
): number {
  return observer.skillIo().filter(event => event.phase === phase && samePath(event.path, path))
    .reduce((total, event) => total + (event.bytesRead ?? 0), 0)
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}
