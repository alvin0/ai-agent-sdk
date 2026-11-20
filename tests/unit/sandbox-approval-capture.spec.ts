import { expect, it } from 'vitest'
import { approveSandboxEscalation, requireSandboxApproval } from '@alvin0/ai-agent-sdk-sandbox'

it('captures the approved entry values independently of later caller edits', () => {
  const entries = [{ path: '/workspace/notes', access: 'read' as const }]
  const approval = approveSandboxEscalation({ entries })
  entries[0]!.path = '/workspace/archive'
  entries.push({ path: '/workspace/help', access: 'read' })
  expect(requireSandboxApproval(approval).entries).toEqual([{ path: '/workspace/notes', access: 'read' }])
  expect(Object.isFrozen(approval.entries)).toBe(true)
  expect(Object.isFrozen(approval.entries?.[0])).toBe(true)
})
