import type { LocalMemberRuntime, RemoteMemberRuntime, AddressableMember } from './team-runtime-types.ts'
import type { TeamSessionPort, TeamMemberAttachmentOptions } from './contracts.ts'
import type { AgentTeamEvent, AgentTeamMember, LinkAgentOptions } from './types.ts'
import { memberName, boundedString } from './common.ts'
import { teamMemberView, teamToolAccess } from './team-support.ts'

interface RosterOptions {
  readonly id: string
  readonly maxMembers: number
  readonly maxMetadataBytes: number
  emit(event: AgentTeamEvent): void
}

/** Owns member registration and address validation; work lifecycle stays with the team. */
export class TeamRoster {
  readonly locals = new Map<string, LocalMemberRuntime>()
  readonly remotes = new Map<string, RemoteMemberRuntime>()

  constructor(private readonly options: RosterOptions) {}

  attach(session: TeamSessionPort, options: TeamMemberAttachmentOptions = {}): void {
    const name = memberName(options.name ?? session.definition.id)
    this.assertAddressAvailable(name)
    this.assertCapacity()
    const role = options.role ?? (this.locals.size === 0 ? 'lead' : 'peer')
    if (role === 'lead' && [...this.locals.values()].some(member => member.role === 'lead')) {
      throw new Error(`A2A team '${this.options.id}' already has a lead`)
    }
    const access = teamToolAccess(options)
    const member: LocalMemberRuntime = {
      kind: 'local', name, role, access, session,
      wakeRequestedSeq: 0, wakeConsumedSeq: 0,
      wakeTask: undefined, wakeController: undefined, error: undefined, outcome: undefined,
      pendingStart: undefined, steerController: undefined,
      ...(options.description === undefined ? {} : {
        description: boundedString(options.description, 'member description', this.options.maxMetadataBytes),
      }),
      ...(options.instructions === undefined ? {} : {
        instructions: boundedString(options.instructions, 'member instructions', this.options.maxMetadataBytes),
      }),
    }
    this.locals.set(name, member)
    this.options.emit({ type: 'member-attached', member: teamMemberView(member) })
  }
  linkAgent(options: LinkAgentOptions): () => void {
    const name = memberName(options.name)
    this.assertAddressAvailable(name)
    this.assertCapacity()
    if (typeof options.transport?.send !== 'function') {
      throw new TypeError('linked agent transport must implement send()')
    }
    const member: RemoteMemberRuntime = {
      kind: 'remote', name, role: 'peer', transport: options.transport,
      tail: Promise.resolve(), pending: 0, controllers: new Set(), error: undefined,
      ...(options.description === undefined ? {} : {
        description: boundedString(options.description, 'linked agent description', this.options.maxMetadataBytes),
      }),
    }
    this.remotes.set(name, member)
    this.options.emit({ type: 'member-linked', member: teamMemberView(member) })
    return () => {
      if (this.remotes.get(name) !== member) return
      if (member.pending > 0) throw new Error(`cannot unlink running A2A member '${name}'`)
      this.remotes.delete(name)
    }
  }
  detach(name: string): void {
    const member = this.requireLocalMember(name)
    if (member.session.isRunning || member.wakeTask !== undefined) {
      throw new Error(`cannot detach running A2A member '${member.name}'`)
    }
    this.locals.delete(member.name)
  }
  members(): readonly AgentTeamMember[] {
    return Object.freeze([
      ...this.locals.values(),
      ...this.remotes.values(),
    ].map(member => teamMemberView(member)))
  }
  requireLocalMember(value: string): LocalMemberRuntime {
    const name = memberName(value)
    const member = this.locals.get(name)
    if (member === undefined) throw new Error(`unknown local A2A member '${name}'`)
    return member
  }
  requireAddress(value: string): AddressableMember {
    const name = memberName(value)
    const member = this.locals.get(name) ?? this.remotes.get(name)
    if (member === undefined) throw new Error(`unknown A2A member '${name}'`)
    return member
  }
  private assertAddressAvailable(name: string): void {
    if (this.locals.has(name) || this.remotes.has(name)) {
      throw new Error(`A2A member '${name}' is already attached or linked`)
    }
  }
  private assertCapacity(): void {
    if (this.locals.size + this.remotes.size >= this.options.maxMembers) {
      throw new Error(`A2A team '${this.options.id}' reached its ${this.options.maxMembers}-member limit`)
    }
  }
  clear(): void {
    this.locals.clear()
    this.remotes.clear()
  }
}
