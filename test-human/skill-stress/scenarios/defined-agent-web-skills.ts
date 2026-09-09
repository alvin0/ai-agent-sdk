import { defineAgent } from '@ai-agent-sdk/core/agent'
import {
  defineSkillProvider,
  type SkillCandidate,
  type SkillProviderListOptions,
} from '@ai-agent-sdk/core/agent'
import { createOfflineRegistry } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import { ScriptedStressAdapter } from '../scripted-adapter.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume, orderedSubsequence } from './shared.ts'

const ALLOWED_ID = 'workflow-release-review'
const FORBIDDEN_ID = 'tenant-private-admin'
const ALLOWED_BODY = 'WEB_WORKFLOW_ALLOWED_BODY_59cfe1'
const FORBIDDEN_BODY = 'WEB_WORKFLOW_FORBIDDEN_BODY_d7312b'
const RESOURCE_PROBE = 'WEB_WORKFLOW_RELEASE_GATE_0a94d3'

/**
 * Application acceptance: a definition declares ids, while a web/workflow host
 * supplies a shared lazy provider per session. Availability does not activate a
 * skill, and provider candidates outside the definition scope stay inaccessible.
 */
export async function definedAgentWebSkills(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const observer = new StressObserver(context.paths.report, {
    allowedBody: ALLOWED_BODY,
    forbiddenBody: FORBIDDEN_BODY,
    resource: RESOURCE_PROBE,
  })
  const checks = new InvariantRecorder()
  const listScopes: (readonly string[] | undefined)[] = []
  const loadedIds: string[] = []
  const resourceReads: string[] = []
  try {
    const candidates = webCandidates()
    const provider = defineSkillProvider({
      kind: 'skill-provider', id: 'tenant-web-skills',
      list(options: SkillProviderListOptions) {
        listScopes.push(options.allowedSkillIds)
        // Deliberately return the tenant-wide catalog. SkillCatalog must still
        // enforce the agent definition even when a provider ignores the hint.
        return Promise.resolve(candidates)
      },
      load(candidate) {
        loadedIds.push(candidate.id)
        return Promise.resolve({
          id: candidate.id, name: candidate.name, description: candidate.description,
          instructions: candidate.id === ALLOWED_ID ? ALLOWED_BODY : FORBIDDEN_BODY,
          resourceManifest: candidate.id === ALLOWED_ID
            ? [{ path: 'references/release-gate.md', sizeChars: RESOURCE_PROBE.length }]
            : [],
        })
      },
      readResource(candidate, path) {
        resourceReads.push(`${candidate.id}/${path}`)
        return Promise.resolve(candidate.id === ALLOWED_ID && path === 'references/release-gate.md'
          ? `# Release gate\n${RESOURCE_PROBE}`
          : undefined)
      },
    })
    const adapter = new ScriptedStressAdapter({
      rounds: [
        { finalText: 'General workflow question answered without activating a skill.' },
        {
          commentary: 'This release request now requires the attached review skill.',
          toolCalls: [{ name: 'load_skill', arguments: { skillId: ALLOWED_ID } }],
        },
        {
          commentary: 'Read only the release-gate reference exposed by the selected skill.',
          toolCalls: [{
            name: 'read_skill_resource',
            arguments: { skillId: ALLOWED_ID, path: 'references/release-gate.md', section: 'Release gate' },
          }],
        },
        { finalText: 'Definition-scoped workflow review completed.' },
      ],
    })
    const agent = defineAgent({
      id: `defined_web_skills_${context.seed}`,
      provider: 'stress', model: 'scripted', effort: 'medium',
      instructions: 'Use an attached skill only when the current request needs it.',
      skillIds: [ALLOWED_ID],
      maxTurns: 6, maxToolCalls: 8, compaction: false,
    })
    const session = agent.createSession({
      registry: createOfflineRegistry(adapter),
      skills: [provider],
      hooks: {
        checkpoint(checkpoint) {
          if (checkpoint.kind === 'before-model-request') observer.recordRequest(checkpoint.request)
        },
      },
    })

    const unrelated = await consume(
      session, 'Answer a general status question; no release review is requested.', observer, context.signal,
    )
    const loadsAfterUnrelatedTurn = loadedIds.length
    const reviewed = await consume(
      session, 'Review this release using the workflow policy and its release gate.', observer, context.signal,
    )
    const forbiddenLoad = await session.skills?.load(FORBIDDEN_ID, { signal: context.signal })

    const requests = observer.requests().filter(request => request.kind === 'model')
    const initial = requests[0]
    const matchingInitial = requests[1]
    const afterLoad = requests[2]
    const afterResource = requests[3]
    const visibleIds = session.skills?.summaries().map(skill => skill.id) ?? []

    checks.check('definition allowlist scopes the tenant catalog to one skill',
      visibleIds.join(',') === ALLOWED_ID
      && adapter.requests.every(request => request.system?.includes(FORBIDDEN_ID) !== true),
      `visible=${visibleIds.join(',')}`)
    checks.check('provider receives the definition scope on every discovery round',
      listScopes.length >= 2 && listScopes.every(ids => ids?.join(',') === ALLOWED_ID),
      `scopes=${listScopes.map(ids => ids?.join(',') ?? 'none').join('|')}`)
    checks.check('an available skill is not activated for an unrelated turn',
      loadsAfterUnrelatedTurn === 0
      && initial?.systemHasCatalog === true
      && initial.probes.allowedBody?.system === false
      && initial.probes.allowedBody?.messages === false)
    checks.check('the matching turn still starts with metadata only',
      matchingInitial?.probes.allowedBody?.system === false
      && matchingInitial?.probes.allowedBody?.messages === false
      && matchingInitial?.probes.forbiddenBody?.messages === false)
    checks.check('only the allowed selected body is loaded',
      loadedIds.join(',') === ALLOWED_ID
      && afterLoad?.probes.allowedBody?.messages === true
      && requests.every(request => request.probes.forbiddenBody?.messages === false),
      `loaded=${loadedIds.join(',')}`)
    checks.check('the targeted resource enters context only after its explicit read',
      afterLoad?.probes.resource?.messages === false
      && afterResource?.probes.resource?.messages === true
      && resourceReads.join(',') === `${ALLOWED_ID}/references/release-gate.md`)
    checks.check('a forbidden definition id cannot reach provider.load',
      forbiddenLoad === undefined && loadedIds.every(id => id !== FORBIDDEN_ID))
    checks.check('web/workflow path uses no filesystem skill I/O', observer.skillIo().length === 0)
    checks.check('defined path uses the real lazy skill tool loop', orderedSubsequence(observer.toolNames(), [
      'load_skill', 'read_skill_resource',
    ]))
    checks.check('both application turns complete',
      unrelated?.reason.kind === 'completed' && reviewed?.reason.kind === 'completed')
    checks.check('defined web-skill trace remains complete',
      observer.traceProblems().length === 0, observer.traceProblems().join('; '))
    return {
      invariants: checks.items(),
      metrics: {
        ...observer.metrics(), turns: 2, providerLists: listScopes.length,
        providerLoads: loadedIds.length, providerResourceReads: resourceReads.length,
      },
    }
  } finally {
    await observer.flush()
  }
}

function webCandidates(): readonly SkillCandidate[] {
  return Object.freeze([
    Object.freeze({
      id: ALLOWED_ID, name: 'Workflow release review',
      description: 'Review an application release through the tenant workflow.',
      invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
      source: 'tenant-web', provider: 'tenant-web-skills', locator: Object.freeze({ key: 'release' }),
    }),
    Object.freeze({
      id: FORBIDDEN_ID, name: 'Tenant private administration',
      description: 'Private tenant administration unavailable to this agent.',
      invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
      source: 'tenant-web', provider: 'tenant-web-skills', locator: Object.freeze({ key: 'admin' }),
    }),
  ])
}
