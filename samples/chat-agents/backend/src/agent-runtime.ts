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
} from '@ai-agent-sdk/core/agent'
import type {
  AgentResponse, AgentRunEvent, ApprovalBroker, DefinedAgent, ManagedAgentTeam,
  ToolDefinition, ToolInterceptor,
} from '@ai-agent-sdk/core/agent'
import type {
  AgentInput, ContextSection, ModelRegistry, SkillSource, UserInputBroker,
} from '@ai-agent-sdk/core'
import { createProjectInstructionsSection } from '@ai-agent-sdk/instructions-node'
import { MODEL_TIMEOUT_MS, retryHooks } from './resilience'
import type { RetryNotice } from './resilience'
import { listAgents, mcpTools } from './agents'
import { skillSourcesFor } from './skill-catalog'
import { createFileSpillStore } from './spill'
import type { AgentRow } from './agents'

/**
 * Tool-using steps one ordinary agent gets for a prompt.
 *
 * The SDK spends this on steps, not on conversational turns, so it is a budget
 * for actions: reading files, editing, running a command.
 */
const TURN_BUDGET = 32

/** Team leads and workers finish by completion, with resource/loop guards intact. */
const TEAM_TURN_BUDGET = 'auto' as const

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
    name: 'researcher',
    description: 'Researches a bounded topic using available web and document tools.',
    whenToUse: 'independent sectors or questions can be researched separately',
    instructions: 'Report evidence with source URLs and dates. Distinguish observations'
      + ' from forecasts, and state unavailable data. Do not modify workspace files.',
  },
  {
    name: 'analyst',
    description: 'Analyzes supplied data and reconciles competing findings.',
    whenToUse: 'the data already exists, or dependsOn names the workers collecting it',
    instructions: 'Check units, dates, missing values and assumptions. Explain the'
      + ' calculation and its limitations. Do not invent missing measurements.',
  },
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

export const DEFAULT_INSTRUCTIONS = `You are an assistant for research, coding, and analysis working in a workspace directory.
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

const REPORTING_INSTRUCTIONS = `For multi-step work, publish a plan with write_todos and keep it updated as work progresses.
Before your final answer, reconcile the plan: mark only verified work done and explain pending items or blockers.
Always finish with a substantive report of findings or changes, evidence or sources, checks performed, and remaining uncertainty.
A self-check submission is not the final report. After it is accepted, write the answer for the user.
For research, include source links and observation dates; distinguish observed facts from forecasts and unavailable future data.
Respect the user's source and retry limits, including during team follow-ups. If permitted sources fail or cannot verify the requested date, finish with an unavailable-data finding and explain what could not be verified. Do not keep searching merely to obtain a number or mark a todo done. A report of unavailable evidence can complete the investigation; it does not verify the missing fact.
Use fetch_url.fetchedAt only as the retrieval timestamp. Never invent an observation date or treat a current quote as a historical quote without a source timestamp.
If quote tables require JavaScript, check an independent credible source or documented public data endpoint. If still unavailable, report that gap instead of repeatedly fetching similar empty quote pages. Follow-ups should request specific new evidence or resolve a concrete discrepancy, not restart the same unavailable-data search.
When leading a team, collect worker results and synthesize one answer covering the original request, including failed or incomplete contributions.`

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
   * Run one more turn over context that arrived too late to be read.
   *
   * Steering appends to history and schedules nothing: the next model round
   * picks it up, and if the run ends before there is a next round, nobody
   * ever does. The caller checks for that and continues the run here rather
   * than leaving a user's correction unanswered in the transcript.
   */
  readonly continuePending?: () => AsyncIterable<AgentRunEvent>
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

/**
 * The user's own standing instructions, read before any project file.
 *
 * No default: where a host keeps a user's global `AGENTS.md` is the host's
 * decision, and guessing would silently put a stranger's file in the prompt.
 */
const GLOBAL_INSTRUCTIONS = process.env.CHAT_AGENTS_GLOBAL_INSTRUCTIONS

/**
 * The `AGENTS.md` files that apply to one project, as a context section.
 *
 * Project instructions are always-on, which is what separates them from a
 * skill: a skill is advertised and loaded when the model picks it, whereas an
 * agent that never read the project's conventions has already broken them. The
 * SDK models that as a `ContextSection` — a callback re-run before every model
 * round, owning one node on the conversation surface — rather than as system
 * prompt text, because these files change WHILE a session runs (a tool reaches
 * into a new subtree, someone edits the file) and rewriting the system prompt
 * would throw away the prompt cache on every edit.
 *
 * One section instance per group, shared by every member of a team: the section
 * keys everything it accumulates by conversation scope, so a worker that reads
 * into `packages/api` does not push that directory's instructions in front of
 * its peers.
 * @param workspaceRoot - The project directory the group's runs are confined to.
 * @returns The section to mount on every agent in the group.
 */
function instructionsFor(workspaceRoot: string): ContextSection {
  return createProjectInstructionsSection({
    cwd: workspaceRoot,
    ...GLOBAL_INSTRUCTIONS === undefined || GLOBAL_INSTRUCTIONS === ''
      ? {}
      : { globalFile: GLOBAL_INSTRUCTIONS },
    // No markers, so the walk stops at the workspace root and the section reads
    // that directory down. The default (`['.git']`) walks UP to the enclosing
    // checkout, which for a workspace opened inside a larger repository would
    // pull a file the agent's own tools are forbidden to read into every
    // prompt. Set `CHAT_AGENTS_INSTRUCTIONS_WALK_UP=1` to opt into that.
    projectRootMarkers: process.env.CHAT_AGENTS_INSTRUCTIONS_WALK_UP === '1' ? ['.git'] : [],
  })
}

/** The tool/skill surface the agents in one group share. */
async function surfaceFor(context: RunContext): Promise<{
  tools: readonly ToolDefinition[]
  skills: readonly SkillSource[]
  instructions: ContextSection
}> {
  const { tools: remoteTools } = await mcpTools(context.groupId)
  const workspaceTools = context.workspaceTools.names()
    .map(name => context.workspaceTools.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined)
  return {
    instructions: instructionsFor(context.workspaceRoot),
    tools: [...workspaceTools, ...remoteTools],
    // Built where the composer's `/` menu builds them, so the menu can never
    // offer a skill this run would not find.
    skills: await skillSourcesFor(context),
  }
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
    maxTurns?: number | 'auto'
  },
  tools: readonly ToolDefinition[],
  skills: readonly SkillSource[],
  instructions: ContextSection,
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
    instructions: [row?.systemPrompt ?? DEFAULT_INSTRUCTIONS, REPORTING_INSTRUCTIONS].join('\n\n'),
    mode: overrides.mode ?? sdkMode(context.mode),
    tools,
    skills,
    // The project's own `AGENTS.md` files, re-read before every model round.
    contextSections: [instructions],
    commentary: 'concise',
    maxTurns: overrides.maxTurns
      ?? (context.mode === 'team' || context.mode === 'team-dynamic' ? TEAM_TURN_BUDGET : TURN_BUDGET),
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
 * @param prompt - The user's message: plain text, or a full user message when
 *   the prompt carries attachments.
 * @param context - Model, mode, workspace, tools, and the preset in play.
 * @param onMemberEvent - Raw events from every non-lead agent, tagged by name.
 * @returns The lead's event handle plus the member roster.
 */
/**
 * One store for the process.
 *
 * Memoised because the directory is created on first use and every session
 * shares the same files; a per-run store would re-create it on every prompt.
 */
let sharedSpillStore: ReturnType<typeof createFileSpillStore> | undefined
function spillStore(): ReturnType<typeof createFileSpillStore> {
  sharedSpillStore ??= createFileSpillStore()
  return sharedSpillStore
}

export async function startRun(
  prompt: AgentInput,
  context: RunContext,
  onMemberEvent: (member: string, event: AgentRunEvent) => void,
): Promise<RunHandles> {
  const { tools, skills, instructions } = await surfaceFor(context)
  // Every session in a team shares the gate, so a member's `rm -rf` is asked
  // about exactly like the lead's — and shares the retry policy and the stream
  // deadline, so a member cannot stall the lead for ten silent minutes.
  const sessionOptions = {
    registry: context.registry,
    userInput: context.userInput,
    skillCwd: context.workspaceRoot,
    // The tool budget paces the run; it does not end it. A research or team
    // turn spends its calls long before the work is done, and a wall there
    // declines the very call that would have finished — the handover, the
    // submission. The turn stays bounded by steps, tokens, and the run ledger.
    runtimeLimits: { modelTimeoutMs: MODEL_TIMEOUT_MS, onExhausted: 'continue' as const,
      maxTotalTokens: 'auto' as const },
    // With a store mounted the default `auto` overflow policy spills instead of
    // truncating, so a `cat` of a large file costs the model a preview and a
    // locator rather than the rest of its context — and nothing is lost, since
    // `read_tool_output` reads the file back.
    spillStore: spillStore(),
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
          agent: definitionFor(leadRow, context, { id: 'lead', maxTurns: TEAM_TURN_BUDGET }, tools, skills, instructions),
          role: 'lead' as const,
          description: leadRow?.description ?? 'Coordinates the team and owns the final answer.',
          // Only the lead resumes the conversation's history: a member keeps
          // its own, and sharing one History object across sessions would
          // interleave their turns.
          sessionOptions: { ...sessionOptions, history: context.history },
        },
        ...members.map(row => ({
          name: row.name,
          agent: definitionFor(row, context, { id: row.id }, tools, skills, instructions),
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
      allowModelWorkerCancellation: false,
      lead: definitionFor(
        context.agent,
        context,
        { id: 'lead', maxTurns: TEAM_TURN_BUDGET },
        tools,
        skills,
        instructions,
      ),
      leadName: 'lead',
      workerTemplate: definitionFor(context.agent, context, { id: 'worker' }, tools, skills, instructions),
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
      // The harness's own steering, not the bare session's: a message typed
      // while the lead is idle and its workers are still running has to be
      // read by something, and an injection schedules nothing.
      steer: text => managed.steer(text),
      // Deliberately NOT disposed: its workers are meant to keep running
      // past the end of this run. The conversation owns the harness now, and
      // drops it when the conversation goes.
      close: async () => undefined,
    }
  }

  // Single agent, on a SESSION rather than the bare loop.
  //
  // The bounded loop was chosen because it accepts an omitted reasoning effort
  // while a DefinedAgent always sends one, and a provider that declares no
  // efforts rejects any value. That reason is gone: the run now validates the
  // conversation's remembered effort against the model it resolved to, so an
  // unsupported one never reaches here.
  //
  // What the loop could not do is COMPACT. A session carries the SDK's
  // compactor, so a long conversation is condensed as it approaches the model's
  // context window instead of growing until the provider refuses it — which is
  // what both reference harnesses do, and what a chat that lasts all day needs.
  const session = definitionFor(context.agent, context, { id: 'agent' }, tools, skills, instructions)
    .createSession({ ...sessionOptions, history: context.history })
  const handle = session.stream(prompt, { signal: context.signal })
  return {
    steer: text => steerSession(session, text),
    events: handle,
    result: handle.result,
    continuePending: () => session.streamPending({ signal: context.signal }),
    members: [],
    close: async () => undefined,
  }
}
