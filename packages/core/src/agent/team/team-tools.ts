import { executeTeamWait } from './team-wait-operation.ts'
import type { TeamToolsHost } from './team-tool-host.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { TeamToolAccess } from './contracts.ts'
import { waitToolSchema } from './team-support.ts'
import { messageToolSchema, parseMessageTool, parseWaitTool, emptyObject, memberName,
  asJson, TEAM_TOOL_NAMES } from './common.ts'


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
        execute: (args, ctx) => executeTeamWait(this.host, { name, sender }, args, ctx),
        isConcurrencySafe: () => true,
    })
  }

}
