import { describe, expect, it } from 'vitest'
import { AgentTeam } from '@alvin0/ai-agent-sdk-core/agent'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { TeamSessionPort } from '@alvin0/ai-agent-sdk-core/agent'

/**
 * Wait cycles.
 *
 * `spawn_agent` used to block the lead on its worker, and that blocking had to
 * be declared as a wait edge or the cycle it could close was invisible here. It
 * no longer blocks, so the edge is gone and the cycle it enabled cannot form.
 * What remains — and still has to be refused — is a cycle built from real
 * `wait_agents` calls between members that hold the coordination verbs.
 */
const context = (id: string) => ({
  turn: 1,
  step: 1,
  callId: ToolCallId(id),
  toolName: 'wait_agents',
  signal: new AbortController().signal,
  concludeTurn() {},
  addContext() {},
})

function busyTeam() {
  // A floor low enough that the short budget this file asks for stands: what is
  // under test here is that a wait comes back at all, not how short one may be.
  const team = new AgentTeam({ id: 'cycle-team', minWaitTimeoutMs: 100 })
  let running = true
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = () => { running = false; resolve() }
  })
  const port = (id: string): TeamSessionPort => ({
    definition: { id },
    conversationId: `${id}-conversation`,
    get isRunning() { return running },
    inject: () => 1,
    whenIdle: () => blocked,
    runPending: async () => undefined,
  })
  team.attach(port('agent-lead'), { name: 'lead' })
  team.attach(port('agent-a'), { name: 'a' })
  team.attach(port('agent-b'), { name: 'b' })
  return { team, release }
}

describe('wait cycles', () => {
  it('refuses a member waiting on itself', () => {
    const { team } = busyTeam()
    expect(() => team.beginWait('a', ['a'])).toThrow(/cycle/)
  })

  it('refuses a wait that closes a loop through another member', () => {
    const { team } = busyTeam()
    const releaseAB = team.beginWait('a', ['b'])
    // b cannot wait for a while a is waiting for b: both would wait for each
    // other until a timeout, which is the shape a coordinator can never
    // recover from on its own.
    expect(() => team.beginWait('b', ['a'])).toThrow(/cycle/)
    releaseAB()
    // Once a is no longer waiting, b waiting for a is legitimate again — a fix
    // for a deadlock is not allowed to invent one.
    team.beginWait('b', ['a'])()
  })

  it('refuses a longer loop', () => {
    const { team } = busyTeam()
    team.beginWait('a', ['b'])
    team.beginWait('b', ['lead'])
    expect(() => team.beginWait('lead', ['a'])).toThrow(/cycle/)
  })

  it('reports a bounded wait instead of hanging on a busy member', async () => {
    const { team, release } = busyTeam()
    const wait = team.toolsFor('lead').find(tool => tool.name === 'wait_agents')
    expect(wait).toBeDefined()
    const args = wait?.parse?.({ targets: ['a'], timeoutMs: 200 })

    const started = Date.now()
    const report = await wait?.execute(args, context('wait-1'))
    // The member never goes idle, and the call still comes back: an unbounded
    // wait is what made one slow agent look like a hung app.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(report).toMatchObject({ settled: null, timedOut: true })
    release()
  }, 20_000)
})
