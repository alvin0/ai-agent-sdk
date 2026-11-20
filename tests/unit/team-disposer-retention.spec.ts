import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { TeamRoster } from '../../packages/core/src/agent/team/team-roster.ts'
import type { LinkAgentOptions } from '../../packages/core/src/agent/team/types.ts'

it('releases team callbacks and remote transports while disposed handles remain reachable', () => {
  const harness = fileURLToPath(new URL(
    '../fixtures/team-disposer-retention.mjs', import.meta.url,
  ))
  const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-transform-types', harness], {
    encoding: 'utf8', timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
  const evidence = JSON.parse(result.stdout) as {
    heldDisposers: number
    alive: Record<string, number>
    members: number
  }
  expect(evidence.heldDisposers).toBe(400)
  expect(evidence.alive).toEqual({ listener: 0, 'wake-guard': 0, 'wait-guard': 0, 'remote-transport': 0 })
  expect(evidence.members).toBe(0)
})

it('allows unlink retries after a running member settles and protects a replacement registration', () => {
  const roster = new TeamRoster({ id: 'retry-unlink', maxMembers: 2, maxMetadataBytes: 1024, emit() {} })
  const options: LinkAgentOptions = { name: 'remote', transport: {
    protocol: 'fixture', agentId: 'remote-agent',
    async send() { return { kind: 'message', succeeded: true, text: 'done', contextId: 'fixture' } },
  } }
  const unlink = roster.linkAgent(options)
  const member = roster.remotes.get('remote')!
  member.pending = 1
  expect(unlink).toThrow("cannot unlink running A2A member 'remote'")
  expect(roster.remotes.get('remote')).toBe(member)
  member.pending = 0
  unlink()
  expect(roster.members()).toHaveLength(0)
  const replacement = roster.linkAgent(options)
  unlink()
  expect(roster.members()).toHaveLength(1)
  replacement()
  expect(roster.members()).toHaveLength(0)
})
