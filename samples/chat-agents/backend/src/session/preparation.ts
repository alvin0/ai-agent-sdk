import { createUserMessage } from '@alvin0/ai-agent-sdk-core'
import type { AgentInput } from '@alvin0/ai-agent-sdk-core'
import { projectAttachments } from '../attachments'
import { getConversation, updateConversation } from '../conversations'
import type { ModelSelection } from '../registry'
import { getAgent } from '../agents'
import { listAvailableSkills, resolveSkillMentions } from '../skill-catalog'
import { instructionsInForce } from '../agent-runtime'
import type { RunMode } from '../agent-runtime'
import { getGroup } from '../groups'
import { RunTrace } from '../traces'
import type { StoredNode } from '../event-projection'
import { displacedRuns, runOwners } from './ownership'
import { session } from './store'
import type { ChatSession } from './types'

export async function readPromptSelection(id: string, groupId?: string) {
  const live = await session(id, groupId)
  const conversation = await getConversation(id)
  const group = await getGroup(conversation?.groupId)
  // The conversation's own workspace wins; a conversation created before the
  // group existed falls back to the group's directory.
  const workspaceRoot = conversation?.workspaceRoot ?? group.workspaceRoot
  const agent = conversation?.agentId == null ? undefined : await getAgent(conversation.agentId)
  const mode = promptMode(conversation, agent)
  const selection = routeSelection(conversation) ?? routeSelection(agent)
  const rememberedEffort = promptEffort(conversation, agent)

  return { live, conversation, group, workspaceRoot, agent, mode, selection, rememberedEffort }
}

export function takeOverPrompt(live: ChatSession) {
  // A second prompt takes the conversation over rather than running beside the
  // first. Two runs on one conversation share its history and its transcript
  // counter, so leaving both alive splices two dialogues into one and neither
  // is readable afterwards — and the session shapes refuse the second outright.
  if (live.abort !== undefined) {
    // Marked HERE, where the displacement actually happens, and not inferred
    // later from whoever holds the slot: the displaced run can still be
    // unwinding after this one has finished and cleared the slot, and a check
    // made at that point sees an idle conversation and concludes, wrongly, that
    // nothing replaced it.
    displacedRuns.add(live.abort)
    live.abort.abort(new Error('a newer prompt took the conversation over'))
    // Tell the MODEL that the earlier request was withdrawn.
    //
    // Aborting ends the run, but the instruction it was carrying out stays in
    // history as the last thing the user asked for, and the next prompt lands
    // right after it. A model reading two consecutive user messages reasonably
    // does the first one — which is how "count to twenty", cancelled and
    // replaced, still came back as a count to twenty. The note is written once,
    // between the withdrawn request and the one replacing it, and is attributed
    // to the app rather than to the user, who did not type it.
    live.history.append({
      kind: 'user',
      message: createUserMessage({
        content: [{
          type: 'text',
          text: 'Note from the application: the user withdrew the previous request before it was '
            + 'answered, and replaced it with the message that follows. Do not carry out the '
            + 'withdrawn request. Answer only the new one.',
        }],
        source: { kind: 'app', producer: 'chat-agents.takeover' },
      }),
    })
  }
  const controller = new AbortController()
  const previousOwner = runOwners.get(live)
  if (previousOwner !== undefined) displacedRuns.add(previousOwner)
  runOwners.set(live, controller)
  live.abort = controller
  const runId = `run_${Date.now().toString(36)}`

  return { controller, runId }
}

export async function recordInstructions(trace: RunTrace, workspaceRoot: string): Promise<void> {
  // The project's conventions files. Recorded even when there are none: a run
  // that read no AGENTS.md is the answer to "why did it ignore our rules", and
  // an empty list says it where silence could not.
  const instructionsAt = Date.now()
  try {
    const instructions = await instructionsInForce(workspaceRoot)
    trace.note({
      name: 'instructions',
      startedAt: instructionsAt,
      durationMs: Date.now() - instructionsAt,
      attributes: {
        'agent.instructions.files': instructions.files.length,
        'agent.instructions.candidates': instructions.fileNames.join(', '),
        'agent.instructions.project_root': instructions.projectRoot,
      },
      output: {
        projectRoot: instructions.projectRoot,
        candidates: instructions.fileNames,
        files: instructions.files.map(file => ({
          path: file.path,
          bytes: file.bytes,
          firstLine: file.firstLine,
          ...file.global === true ? { global: true } : {},
        })),
      },
    })
  } catch (error) {
    trace.note({
      name: 'instructions',
      startedAt: instructionsAt,
      durationMs: Date.now() - instructionsAt,
      output: undefined,
      error: { type: 'InstructionsUnreadable', message: error instanceof Error ? error.message : String(error) },
    })
  }

}

interface SkillPreparation {
  readonly prompt: string
  readonly groupId: string
  readonly workspaceRoot: string
  readonly skillIds: readonly string[]
  readonly signal: AbortSignal
}

export async function recordSkills(trace: RunTrace, {
  prompt, groupId, workspaceRoot, skillIds, signal,
}: SkillPreparation) {
  // Skills the user named with `/` in the composer, resolved against the
  // catalogue rather than by parsing alone, so `/etc/passwd` cannot invent one.
  //
  // The catalogue is scanned for EVERY run now, not only for a prompt with a
  // `/` in it: which skills a run could see is part of explaining what it did,
  // and the scan is the same directory walk the composer already does.
  const catalogueAt = Date.now()
  const catalogue = await listAvailableSkills({ groupId: groupId, workspaceRoot }, signal)
  const mentioned = prompt.includes('/') || skillIds.length > 0
    ? resolveSkillMentions(prompt, catalogue, skillIds)
    : { skills: [] as const, directive: undefined }
  trace.note({
    name: 'skills',
    startedAt: catalogueAt,
    durationMs: Date.now() - catalogueAt,
    attributes: {
      'agent.skills.discovered': catalogue.length,
      'agent.skills.named': mentioned.skills.map(skill => skill.id).join(', '),
    },
    output: {
      named: mentioned.skills.map(skill => skill.id),
      discovered: catalogue.map(skill => ({
        id: skill.id,
        name: skill.name,
        provider: skill.provider,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
      })),
    },
  })

  return mentioned
}

interface PromptPersistence {
  readonly id: string
  readonly live: ChatSession
  readonly prompt: string
  readonly conversation: Awaited<ReturnType<typeof getConversation>>
  readonly attached: ReturnType<typeof projectAttachments>
  readonly mentioned: MentionedSkills
  persist(node: StoredNode): Promise<void>
}

export async function persistPrompt({
  id, live, prompt, conversation, attached, mentioned, persist,
}: PromptPersistence): Promise<void> {
  await persist({
    kind: 'user',
    id: `u_${String(live.seq)}`,
    text: prompt,
    ...attached.records.length === 0 ? {} : { attachments: attached.records },
    // Recorded on the message rather than only acted on: a run that behaved
    // oddly is read back later, and "which skills did this prompt ask for" is
    // the first question about it.
    ...mentioned.skills.length === 0
      ? {}
      : { skills: mentioned.skills.map(skill => skill.id) },
  })
  if (conversation?.title === 'New chat') {
    // An attachment-only prompt has no words to name the conversation with, so
    // the first file's name stands in rather than leaving it "New chat".
    const title = prompt.trim() === '' && attached.records[0] !== undefined
      ? attached.records[0].name
      : prompt.slice(0, 60)
    await updateConversation(id, { title })
  }

}

export function promptInput(
  prompt: string, attached: ReturnType<typeof projectAttachments>, mentioned: MentionedSkills,
): AgentInput {
  // The directive goes to the MODEL, not into the stored user message: the user
  // wrote a prompt, and a transcript that quoted an instruction back at them
  // would be putting words in their mouth. It leads the text so the model reads
  // "load this skill" before the request it applies to.
  const forModel = mentioned.directive === undefined
    ? prompt
    : `${mentioned.directive}\n\n${prompt}`

  // One text block plus the attachment blocks, in pick order. A prompt with
  // nothing attached stays a bare string, which is the shape every shape in
  // `startRun` already accepted.
  const input: AgentInput = attached.blocks.length === 0
    ? forModel
    : createUserMessage({
      content: [
        ...forModel.trim() === '' ? [] : [{ type: 'text', text: forModel } as const],
        ...attached.blocks,
      ],
      source: { kind: 'user' },
    })

  return input
}

interface MentionedSkills {
  readonly skills: ReturnType<typeof resolveSkillMentions>['skills']
  readonly directive?: string | undefined
}

function routeSelection(row: {
  readonly provider?: string | null | undefined
  readonly model?: string | null | undefined
} | null | undefined): ModelSelection | undefined {
  return row?.provider != null && row.model != null ? { provider: row.provider, model: row.model } : undefined
}

function promptMode(
  conversation: { readonly mode?: string | null | undefined } | null | undefined,
  agent: { readonly mode?: string | null | undefined } | null | undefined,
): RunMode {
  return (conversation?.mode ?? agent?.mode ?? 'basic') as RunMode
}

function promptEffort(
  conversation: { readonly reasoningEffort?: string | null | undefined } | null | undefined,
  agent: { readonly reasoningEffort?: string | null | undefined } | null | undefined,
): string | undefined {
  return conversation?.reasoningEffort ?? agent?.reasoningEffort ?? undefined
}
