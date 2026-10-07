import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import { timeoutValue } from '../../platform/config.ts'
import type { TeamToolAccess } from './contracts.ts'
import type { AgentTeam } from './team.ts'
import type { LocalMemberRuntime } from './team-runtime-types.ts'
import { waitToolSchema } from './team-support.ts'
import { messageToolSchema, parseMessageTool, parseWaitTool, emptyObject, memberName,
  asJson, combineSignals, TEAM_TOOL_NAMES } from './common.ts'

interface TeamToolsHost {
  readonly waitTimeoutMs: number
  readonly minWaitTimeoutMs: number
  assertActive(): void
  members: AgentTeam['members']
  sendMessage: AgentTeam['sendMessage']
  followup: AgentTeam['followup']
  beginWait: AgentTeam['beginWait']
  whenIdle: AgentTeam['whenIdle']
  member(name: string): LocalMemberRuntime | undefined
}

export class TeamTools {
  constructor(private readonly host: TeamToolsHost) {}

  toolsFor(sender: string, access: TeamToolAccess = 'full'): readonly ToolDefinition<any>[] {
    this.host.assertActive()
    const name = memberName(sender)
    // Called before `attach`, so the access level arrives as an argument
    // rather than being looked up on the member that does not exist yet.
    const coordinating = access === 'full'
    // Coordination is not exploration. A lead that has spent its tool budget
    // still has to be able to hand the work over and collect it; blocking
    // these is what strands a team run with finished members and no report.
    return Object.freeze([
      defineTool({
        name: TEAM_TOOL_NAMES.list,
        budgetExempt: true,
        description: 'List local and remote addressable agents, their protocols, supported delivery modes, and status.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        parse: raw => emptyObject(raw, 'list_agents'),
        execute: () => asJson(this.host.members()),
        isConcurrencySafe: () => true,
      }),
      defineTool({
        name: TEAM_TOOL_NAMES.send,
        budgetExempt: true,
        description: 'Send quiet context to another local agent from list_agents, other than yourself.'
          + ' This does not start a task or return its final result. Remote A2A peers require followup_task.',
        parameters: messageToolSchema('Message to add to the target context.'),
        parse: parseMessageTool,
        execute: async ({ target, message }, ctx) => asJson(await this.host.sendMessage({
          from: name, target, message, delivery: 'quiet', signal: ctx.signal,
        })),
      }),
      ...!coordinating ? [] : [defineTool({
        name: TEAM_TOOL_NAMES.followup,
        budgetExempt: true,
        description: 'Send active work to a local agent or interoperable remote A2A peer '
          + 'and wait for its accepted result.',
        parameters: messageToolSchema('Follow-up instruction the target must process.'),
        parse: parseMessageTool,
        execute: async ({ target, message }, ctx) => asJson(
          await this.host.followup(name, target, message, ctx.signal),
        ),
      })],
      ...!coordinating ? [] : [this.waitTool(name, sender)],
    ])
  }

  private waitTool(name: string, sender: string): ToolDefinition<any> {
    return defineTool({ name: TEAM_TOOL_NAMES.wait, budgetExempt: true,
        description: 'Wait until one of the selected local or remote agents finishes its scheduled'
          + ' work, then return their current roster state. Returns early with interrupted=true when'
          + ' the user sends you something while you wait, so read that before waiting again.',
        parameters: waitToolSchema(this.host.waitTimeoutMs, this.host.minWaitTimeoutMs),
        parse: parseWaitTool,
        execute: async ({ targets, timeoutMs }, ctx) => {
          const release = this.host.beginWait(name, targets)
          const budget = timeoutMs === undefined
            ? this.host.waitTimeoutMs
            : Math.min(
              Math.max(timeoutValue(timeoutMs), this.host.minWaitTimeoutMs),
              this.host.waitTimeoutMs,
            )
          try {
            // Returns as soon as the FIRST target settles, and always within
            // the budget. Waiting for all of them, forever, is what turned one
            // slow agent into a window that looked hung: a coordinator that
            // gets the roster back can decide for itself whether to wait again.
            //
            // The budget is enforced HERE rather than only by handing members a
            // deadline signal: a member that does not honour the signal would
            // otherwise hold the wait open past its own timeout, and a timeout
            // a callee can ignore is not a timeout.
            // A wait that cannot be interrupted is a wait the user cannot
            // correct: the caller is parked here, so its own new input has
            // nothing else to end it before the budget runs out.
            const steer = new AbortController()
            const caller = this.host.member(memberName(sender))
            if (caller !== undefined) caller.steerController = steer
            const signal = combineSignals(ctx.signal, AbortSignal.timeout(budget), steer.signal)
            let timer: ReturnType<typeof setTimeout> | undefined
            const expiry = new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), budget)
            })
            const interrupted = new Promise<undefined>((resolve) => {
              steer.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
            })
            const settled = await Promise.race([
              Promise.any(targets.map(async (target) => {
                await this.host.whenIdle(target, signal)
                return target
              })).then(target => target, () => undefined),
              expiry,
              interrupted,
            ]).finally(() => {
              clearTimeout(timer)
              if (caller?.steerController === steer) caller.steerController = undefined
            })
            // The caller's own cancellation still wins; a steer does not.
            ctx.signal.throwIfAborted()
            if (steer.signal.aborted) {
              return asJson({
                agents: this.host.members().filter(member => new Set(targets).has(member.name)),
                settled: null,
                timedOut: false,
                interrupted: true,
                waitedMs: budget,
              })
            }
            const selected = new Set(targets)
            return asJson({
              agents: this.host.members().filter(member => selected.has(member.name)),
              settled: settled ?? null,
              timedOut: settled === undefined,
              // The budget actually used, which is not always the one asked
              // for: a lead that reads `timedOut` after a request below the
              // floor would otherwise misjudge how long its workers had.
              waitedMs: budget,
            })
          } finally { release() }
        },
        isConcurrencySafe: () => true,
    })
  }

}
