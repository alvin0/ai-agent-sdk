/**
 * Agent construction and the four ways a conversation can run.
 *
 * Everything here builds on `defineAgent` + `AgentSession` rather than the
 * one-shot `runAgent` loop, because a team needs addressable sessions: the
 * lead delegates to members and the members keep their own history.
 *
 * | mode                 | shape                                              |
 * | -------------------- | -------------------------------------------------- |
 * | basic / deep / …     | one session                                        |
 * | team                 | a declared roster; the lead delegates by name      |
 * | team-dynamic         | one lead that spawns workers as the task demands   |
 */

import {
  AgentTeam, History, ToolRegistry, createDefinedAgentTeam, createManagedAgentTeam, defineAgent,
  runAgent,
} from '@ai-agent-sdk/core/agent'
import type {
  AgentResponse, AgentRunEvent, DefinedAgent, ToolDefinition,
} from '@ai-agent-sdk/core/agent'
import { ReasoningEffortId, createTextMessage } from '@ai-agent-sdk/core'
import type { ModelRegistry, SkillSource, UserInputBroker } from '@ai-agent-sdk/core'
import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'
import { listAgents, listSkills, mcpTools } from './agents'
import type { AgentRow } from './agents'

/** Loop policy, extended with the two team shapes. */
export type RunMode = 'basic' | 'deep' | 'deep-human-in-loop' | 'team' | 'team-dynamic'

export const DEFAULT_INSTRUCTIONS = `You are a coding assistant inspecting a workspace directory.
Prefer the provided tools over guessing. Use write_todos to publish a plan before
multi-step work, and request_user_input whenever a decision is genuinely the
user's to make. Answer in GitHub-flavored Markdown; use fenced code blocks with a
language tag.`

/** Everything a run needs that is decided outside the SDK. */
export interface RunContext {
  readonly registry: ModelRegistry
  readonly provider: string
  readonly model: string
  readonly effort: string | undefined
  readonly mode: RunMode
  readonly workspaceRoot: string
  readonly groupId: string
  /** Workspace tools (read, search, diff, todos, fetch). */
  readonly workspaceTools: ToolRegistry
  readonly userInput: UserInputBroker
  /** The preset driving the run; the lead in a team. */
  readonly agent: AgentRow | undefined
  readonly history: History
  /** Cancellation for the whole run, including team members. */
  readonly signal: AbortSignal
}

/** A run in progress, whichever shape it took. */
export interface RunHandles {
  /** Raw events from the agent the user is talking to. */
  readonly events: AsyncIterable<AgentRunEvent>
  /**
   * Terminal outcome for the session-based shapes. The single-agent loop
   * reports its outcome as an `agent-end` event instead, so this is absent.
   */
  readonly result?: Promise<AgentResponse>
  /** Names of every other agent that may report during the run. */
  readonly members: readonly string[]
  /** Release sessions and worker processes owned by this run. */
  close(): Promise<void>
}

/** The tool/skill surface the agents in one group share. */
async function surfaceFor(context: RunContext): Promise<{
  tools: readonly ToolDefinition[]
  skills: readonly SkillSource[]
}> {
  const { tools: remoteTools } = await mcpTools(context.groupId)
  const roots = (await listSkills(context.groupId))
    .filter(row => row.enabled === 1)
    .map(row => row.rootPath)
  const workspaceTools = context.workspaceTools.names()
    .map(name => context.workspaceTools.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined)
  return {
    tools: [...workspaceTools, ...remoteTools],
    // Two sources: an explicit `roots` list disables the provider's own project
    // discovery, so the project's `.agents/skills` needs its own provider.
    skills: [
      fileSystemSkills({
        id: 'project',
        cwd: context.workspaceRoot,
        includeProjectAgents: true,
        includeProjectDsh: true,
      }),
      ...roots.length === 0 ? [] : [fileSystemSkills({ id: 'global', roots })],
    ],
  }
}

/** The effort in force: the preset's, else the conversation's, else none. */
function effortOf(context: RunContext): string | undefined {
  const value = context.agent?.reasoningEffort ?? context.effort
  return value == null || value === '' ? undefined : value
}

/**
 * System prompt for the single-agent loop.
 *
 * `runAgent` has no skill plumbing, so skills are only available in the
 * session-based shapes; the prompt says nothing about them here.
 * @param row - The preset in play, if any.
 * @param skills - Declared skill sources (unused by this shape).
 * @returns The instructions to send.
 */
function instructionsFor(row: AgentRow | undefined, skills: readonly SkillSource[]): string {
  void skills
  return row?.systemPrompt ?? DEFAULT_INSTRUCTIONS
}

/** Loop policy passed to the SDK; the team modes run their members in `deep`. */
function sdkMode(mode: RunMode): 'basic' | 'deep' | 'deep-human-in-loop' {
  if (mode === 'team' || mode === 'team-dynamic') return 'deep'
  return mode
}

function definitionFor(
  row: AgentRow | undefined,
  context: RunContext,
  overrides: { id: string; mode?: 'basic' | 'deep' | 'deep-human-in-loop' },
  tools: readonly ToolDefinition[],
  skills: readonly SkillSource[],
): DefinedAgent {
  return defineAgent({
    id: overrides.id,
    ...row?.name === undefined ? {} : { name: row.name },
    ...row?.description == null ? {} : { description: row.description },
    provider: row?.provider ?? context.provider,
    model: row?.model ?? context.model,
    ...((row?.reasoningEffort ?? context.effort) === undefined
      || (row?.reasoningEffort ?? context.effort) === null
      ? {}
      : { effort: (row?.reasoningEffort ?? context.effort) as string }),
    instructions: row?.systemPrompt ?? DEFAULT_INSTRUCTIONS,
    mode: overrides.mode ?? sdkMode(context.mode),
    tools,
    skills,
    commentary: 'concise',
    maxTurns: 8,
  })
}

/**
 * Start a run.
 *
 * @param prompt - The user's message.
 * @param context - Model, mode, workspace, tools, and the preset in play.
 * @param onMemberEvent - Raw events from every non-lead agent, tagged by name.
 * @returns The lead's event handle plus the member roster.
 */
export async function startRun(
  prompt: string,
  context: RunContext,
  onMemberEvent: (member: string, event: AgentRunEvent) => void,
): Promise<RunHandles> {
  const { tools, skills } = await surfaceFor(context)
  const sessionOptions = {
    registry: context.registry,
    userInput: context.userInput,
    skillCwd: context.workspaceRoot,
  }

  if (context.mode === 'team') {
    // A declared roster: every preset marked as a team member becomes an
    // addressable agent the lead can delegate to by name.
    const roster = (await listAgents(context.groupId)).filter(row => row.inTeam === 1)
    const leadRow = context.agent
    const members = roster.filter(row => row.id !== leadRow?.id)
    const team = new AgentTeam({ onAgentEvent: onMemberEvent })
    const defined = createDefinedAgentTeam({
      registry: context.registry,
      team,
      sessionOptions,
      members: [
        {
          name: 'lead',
          agent: definitionFor(leadRow, context, { id: 'lead' }, tools, skills),
          role: 'lead' as const,
          description: leadRow?.description ?? 'Coordinates the team and owns the final answer.',
          // Only the lead resumes the conversation's history: a member keeps
          // its own, and sharing one History object across sessions would
          // interleave their turns.
          sessionOptions: { ...sessionOptions, history: context.history },
        },
        ...members.map(row => ({
          name: row.name,
          agent: definitionFor(row, context, { id: row.id }, tools, skills),
          role: 'peer' as const,
          ...row.description == null ? {} : { description: row.description },
        })),
      ],
    })
    const lead = defined.session('lead')
    const leadHandle = lead.stream(prompt, { signal: context.signal })
    return {
      events: leadHandle,
      result: leadHandle.result,
      members: members.map(row => row.name),
      close: async () => { await team.dispose() },
    }
  }

  if (context.mode === 'team-dynamic') {
    // One lead that creates its own workers with spawn_agent; each worker is a
    // real session, so its raw events are observable exactly like the lead's.
    const managed = createManagedAgentTeam({
      registry: context.registry,
      lead: definitionFor(context.agent, context, { id: 'lead' }, tools, skills),
      leadName: 'lead',
      leadSessionOptions: sessionOptions,
      workerSessionOptions: sessionOptions,
      onWorkerEvent: onMemberEvent,
    })
    const leadHandle = managed.lead.stream(prompt, { signal: context.signal })
    return {
      events: leadHandle,
      result: leadHandle.result,
      members: [],
      close: async () => { await managed.team.dispose() },
    }
  }

  // Single agent: the bounded loop, not a session. It accepts an OMITTED
  // reasoning effort, while a DefinedAgent always sends one — and a provider
  // that declares no efforts (Gemini today) rejects any value.
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)
  context.history.append({ kind: 'user', message: createTextMessage(prompt) })
  return {
    events: runAgent({
      mode: sdkMode(context.mode),
      registry: context.registry,
      config: {
        provider: context.agent?.provider ?? context.provider,
        model: context.agent?.model ?? context.model,
        ...effortOf(context) === undefined ? {} : { reasoningEffort: ReasoningEffortId(effortOf(context) as string) },
      },
      system: instructionsFor(context.agent, skills),
      history: context.history,
      tools: registry,
      userInput: context.userInput,
      commentary: 'concise',
      maxTurns: 8,
      signal: context.signal,
      trace: { agentId: 'chat-agents', agentName: 'Chat Agent' },
    }),
    members: [],
    close: async () => undefined,
  }
}
