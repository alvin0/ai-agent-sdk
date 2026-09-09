/** Composition root for teams made from pre-defined, long-lived agents. */

import type { ModelRegistry } from '../../runtime/index.ts'
import type { DefinedAgent } from '../define/definition.ts'
import {
  type AgentInput,
  type AgentInvocationOptions,
  type AgentResponse,
  type AgentSession,
  type AgentSessionOptions,
} from '../define/session.ts'
import { AgentTeam } from './team.ts'
import type { AgentTeamOptions } from './types.ts'

type DetachedSessionOptions = Omit<AgentSessionOptions, 'registry' | 'team'>

export interface DefinedAgentTeamMemberInput {
  readonly agent: DefinedAgent
  /** Model-facing team address; defaults to agent.id. */
  readonly name?: string
  readonly description?: string
  readonly collaborationInstructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
  /** Override the shared registry for this member. */
  readonly registry?: ModelRegistry
  readonly sessionOptions?: DetachedSessionOptions
}

export interface DefinedAgentTeamOptions {
  readonly registry: ModelRegistry
  readonly members: readonly DefinedAgentTeamMemberInput[]
  readonly team?: AgentTeam | AgentTeamOptions
  readonly sessionOptions?: DetachedSessionOptions
}

/**
 * A stable graph of agent definitions instantiated as connected sessions.
 * Remote A2A peers can be added later through the exposed AgentTeam.
 */
export class DefinedAgentTeam {
  readonly team: AgentTeam
  private readonly sessions = new Map<string, AgentSession>()

  constructor(options: DefinedAgentTeamOptions) {
    if (!Array.isArray(options.members) || options.members.length === 0) {
      throw new TypeError('defined agent team requires at least one member')
    }
    const explicitLeads = options.members.filter(member => member.role === 'lead')
    if (explicitLeads.length > 1) throw new TypeError('defined agent team can have only one lead')

    this.team = options.team instanceof AgentTeam
      ? options.team
      : new AgentTeam(options.team)
    const hasExplicitLead = explicitLeads.length === 1
    const attached: string[] = []
    try {
      for (const member of options.members) {
        const name = member.name ?? member.agent.id
        const role = member.role ?? (hasExplicitLead ? 'peer' : undefined)
        const session = member.agent.createSession({
          ...options.sessionOptions,
          ...member.sessionOptions,
          registry: member.registry ?? options.registry,
          team: {
            team: this.team,
            name,
            ...(member.description === undefined ? {} : { description: member.description }),
            ...(member.collaborationInstructions === undefined
              ? {}
              : { instructions: member.collaborationInstructions }),
            ...(role === undefined ? {} : { role }),
            ...(member.tools === undefined ? {} : { tools: member.tools }),
          },
        })
        this.sessions.set(name, session)
        attached.push(name)
      }
    } catch (error: unknown) {
      for (const name of attached.reverse()) this.team.detach(name)
      this.sessions.clear()
      throw error
    }
  }

  /** Resolve one connected local session by its exact team address. */
  session(name: string): AgentSession {
    const session = this.sessions.get(name)
    if (session === undefined) throw new Error(`unknown defined team member '${name}'`)
    return session
  }

  /** Run one member without bypassing its persistent team session. */
  async run(
    name: string,
    input: AgentInput,
    invocation: AgentInvocationOptions = {},
  ): Promise<AgentResponse> {
    return this.session(name).run(input, invocation)
  }

  /** Detached list of locally composed session addresses. */
  sessionNames(): readonly string[] {
    return Object.freeze([...this.sessions.keys()])
  }
}

export function createDefinedAgentTeam(options: DefinedAgentTeamOptions): DefinedAgentTeam {
  return new DefinedAgentTeam(options)
}
