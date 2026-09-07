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
  AgentResponse, AgentRunEvent, ApprovalBroker, DefinedAgent, ManagedAgentTeam,
  ToolDefinition, ToolInterceptor,
} from '@ai-agent-sdk/core/agent'
import { ReasoningEffortId, createTextMessage } from '@ai-agent-sdk/core'
import type { ModelRegistry, SkillSource, UserInputBroker } from '@ai-agent-sdk/core'
import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'
import { MODEL_TIMEOUT_MS, retryHooks } from './resilience'
import type { RetryNotice } from './resilience'
import { listAgents, listSkills, mcpTools } from './agents'
import type { AgentRow } from './agents'

/**
 * Tool-using steps one ordinary agent gets for a prompt.
 *
 * The SDK spends this on steps, not on conversational turns, so it is a budget
 * for actions: reading files, editing, running a command.
 */
const TURN_BUDGET = 8

/**
 * The same budget for a lead that delegates, which needs several times more.
 *
 * A delegating lead spends steps on three things at once and eight covered
 * only the first: it explores the workspace, spawns its workers, does the
 * critical-path work it kept for itself — and then has to still be alive to
 * read the results and write the synthesis. Measured on a real run against
 * this app, exploring and spawning three workers alone reached the old cap:
 * the run ended `budget-exhausted` while every worker was still going, so the
 * answer the lead exists to write was never written. Holding the turn open
 * while a worker is unfinished costs a step each time round, too.
 */
const LEAD_TURN_BUDGET = 24

/**
 * The kinds of worker a lead here may create.
 *
 * Declared rather than left to `specialty`, because a role the lead invents at
 * the moment it spawns tells the harness nothing: an `audit-agent` whose only
 * definition is the sentence that created it cannot be recognised as work that
 * needs code to exist first. Naming the kinds up front puts each one's
 * precondition in the spawn schema, where the lead reads it while choosing —
 * and `reviewer` says the thing that went wrong in practice out loud.
 */
const WORKER_ROLES = [
  {
    name: 'implementer',
    description: 'Writes and edits source files in a scope of its own.',
    whenToUse: 'the files it owns are named in its task and no other worker writes them',
    instructions: 'Write only the files your task assigns you. If you need a change'
      + ' in a file owned by someone else, say so in your result instead of making it.',
  },
  {
    name: 'investigator',
    description: 'Reads the workspace and answers a specific question. Writes nothing.',
    whenToUse: 'a decision depends on something nobody has established yet',
    instructions: 'Answer the question you were given from evidence in the workspace.'
      + ' Do not modify any file.',
  },
  {
    name: 'reviewer',
    description: 'Reviews or audits work another worker produced. Writes nothing.',
    whenToUse: 'the code already exists, or this worker dependsOn whoever is writing it;'
      + ' a reviewer started over an empty workspace can only invent a checklist',
    instructions: 'Review what exists. Report concrete findings with file and line'
      + ' references, and do not modify any file.',
  },
] as const

/** Loop policy, extended with the two team shapes. */
export type RunMode = 'basic' | 'deep' | 'deep-human-in-loop' | 'team' | 'team-dynamic'

export const DEFAULT_INSTRUCTIONS = `You are a coding assistant working in a workspace directory.
Prefer the provided tools over guessing. Read before you write, and make changes
with edit_file where an exact replacement is possible, reserving write_file for
new files or a full rewrite. Use run_command for builds, tests, and version
control. Use write_todos to publish a plan before multi-step work, and
request_user_input whenever a decision is genuinely the user's to make.

Writing, deleting, moving, and running commands need the user's permission: the
call pauses until they answer, and a refusal comes back as a denied tool result.
Treat a refusal as an answer — explain or offer an alternative rather than
retrying the same call. Answer in GitHub-flavored Markdown; use fenced code
blocks with a language tag.`

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
  /**
   * Reports a model call being retried after a transient failure.
   *
   * Supplying it is what turns the SDK's "fail on the first blip" default into
   * a bounded retry: `runTurn` asks a hook whether to retry, and without one
   * the answer is always no.
   */
  readonly onRetry?: (notice: RetryNotice) => void
  /** Where a call that needs permission parks until the user answers. */
  readonly approvals?: ApprovalBroker
  /** Pre-call policy; this is what decides a call needs permission at all. */
  readonly interceptors?: readonly ToolInterceptor[]
  /** A harness kept from an earlier prompt in the same conversation. */
  readonly managedTeam?: ManagedAgentTeam
  /**
   * Where a worker's events go, for every run of this conversation.
   *
   * Stable across runs on purpose: the harness captures this once, so a
   * per-run callback would keep delivering to a finished run.
   */
  readonly onWorkerEvent?: (member: string, event: AgentRunEvent) => void
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
  /**
   * The harness this run used, when the shape has one.
   *
   * Handed back so the caller can keep it for the next prompt: its workers
   * outlive this run, so the run cannot be what owns it.
   */
  readonly managedTeam?: ManagedAgentTeam
  /**
   * Add a user message to the run in flight.
   *
   * Steering, not a new prompt: the loop rebuilds its request from history on
   * every model round, so an appended message is read by the next one instead
   * of waiting for the run to finish. It reaches the agent the user is talking
   * to; a team member is redirected by its lead, not from here.
   * @param text - What the user typed while the agent was working.
   * @returns Whether the message was accepted.
   */
  steer(text: string): boolean
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
  overrides: {
    id: string
    mode?: 'basic' | 'deep' | 'deep-human-in-loop'
    maxTurns?: number
  },
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
    maxTurns: overrides.maxTurns ?? TURN_BUDGET,
  })
}

/**
 * Hand a running session a user message.
 *
 * `inject` appends attributed context without scheduling a turn, which is
 * exactly what steering needs: the run already has a turn in progress, and the
 * next model round of that turn rebuilds its request from history.
 * @param session - The session the user is talking to.
 * @param text - The message.
 * @returns Whether it was accepted.
 */
function steerSession(session: { inject: (input: string) => number }, text: string): boolean {
  session.inject(text)
  return true
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
  // Every session in a team shares the gate, so a member's `rm -rf` is asked
  // about exactly like the lead's — and shares the retry policy and the stream
  // deadline, so a member cannot stall the lead for ten silent minutes.
  const sessionOptions = {
    registry: context.registry,
    userInput: context.userInput,
    skillCwd: context.workspaceRoot,
    runtimeLimits: { modelTimeoutMs: MODEL_TIMEOUT_MS },
    ...context.onRetry === undefined ? {} : { hooks: retryHooks(context.onRetry) },
    ...context.approvals === undefined ? {} : { approvals: context.approvals },
    ...context.interceptors === undefined ? {} : { interceptors: context.interceptors },
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
      // `inject` is the SDK's own primitive for attributed context that does
      // not start a turn — the same one A2A quiet delivery uses.
      steer: text => steerSession(lead, text),
      close: async () => { await team.dispose() },
    }
  }

  if (context.mode === 'team-dynamic') {
    // One lead that creates its own workers with spawn_agent; each worker is a
    // real session, so its raw events are observable exactly like the lead's.
    //
    // The harness is reused across the conversation's prompts, because a
    // worker now outlives the run that started it: building a new one per run
    // would strand the workers of the previous one. `onWorkerEvent` therefore
    // routes through the caller's stable sink rather than through this run's
    // callback, which would be the wrong one by the next prompt.
    const report = context.onWorkerEvent ?? onMemberEvent
    const managed = context.managedTeam ?? createManagedAgentTeam({
      registry: context.registry,
      lead: definitionFor(
        context.agent,
        context,
        { id: 'lead', maxTurns: LEAD_TURN_BUDGET },
        tools,
        skills,
      ),
      leadName: 'lead',
      leadSessionOptions: sessionOptions,
      workerSessionOptions: sessionOptions,
      onWorkerEvent: report,
      // Every worker here runs on the lead's own workspace, so a fresh worker
      // starts by rediscovering what the lead has already established. Three
      // workers spawned into an empty project each listed the directory and
      // each decided, separately, to scaffold it. Forking by default costs the
      // lead's transcript in input tokens and saves a round of rediscovery per
      // worker; the lead can still ask for 'fresh' when a task stands alone.
      defaultSpawnContext: 'fork',
      roles: WORKER_ROLES,
      // The lead's own woken turns come through the TEAM's observer, not
      // through the stream this run iterates: a worker reporting after the
      // lead had answered schedules a follow-up turn, and without this the
      // synthesis it exists to produce would be invisible.
      team: { onAgentEvent: report },
    })
    const leadHandle = managed.lead.stream(prompt, { signal: context.signal })
    return {
      events: leadHandle,
      result: leadHandle.result,
      members: [],
      managedTeam: managed,
      steer: text => steerSession(managed.lead, text),
      // Deliberately NOT disposed: its workers are meant to keep running
      // past the end of this run. The conversation owns the harness now, and
      // drops it when the conversation goes.
      close: async () => undefined,
    }
  }

  // Single agent: the bounded loop, not a session. It accepts an OMITTED
  // reasoning effort, while a DefinedAgent always sends one — and a provider
  // that declares no efforts (Gemini today) rejects any value.
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)
  context.history.append({ kind: 'user', message: createTextMessage(prompt) })
  return {
    // The bounded loop owns no session, so the history object IS the seam —
    // the same one `AgentSession.inject` appends to underneath.
    steer: (text) => {
      context.history.append({ kind: 'user', message: createTextMessage(text) })
      return true
    },
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
      modelTimeoutMs: MODEL_TIMEOUT_MS,
      ...context.onRetry === undefined ? {} : { hooks: retryHooks(context.onRetry) },
      ...context.approvals === undefined ? {} : { approvals: context.approvals },
      ...context.interceptors === undefined ? {} : { interceptors: context.interceptors },
      commentary: 'concise',
      maxTurns: TURN_BUDGET,
      signal: context.signal,
      trace: { agentId: 'chat-agents', agentName: 'Chat Agent' },
    }),
    members: [],
    close: async () => undefined,
  }
}
