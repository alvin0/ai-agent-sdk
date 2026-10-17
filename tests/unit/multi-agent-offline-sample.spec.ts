import { describe, expect, it, vi } from 'vitest'
import { NOTES } from '../../samples/multi-agent-offline/adapter.ts'
import { runOfflineTeam } from '../../samples/multi-agent-offline/team.ts'

type OfflineResult = Awaited<ReturnType<typeof runOfflineTeam>>

function expectPeerSend(result: OfflineResult): void {
  const peerMessages = result.messages.filter(message =>
    message.sender === 'worker_1' && message.target === 'worker_2')
  expect(peerMessages).toHaveLength(1)
  expect(peerMessages[0]).toMatchObject({ status: 'accepted', delivery: 'wakeup' })
  const recipient = result.requests.filter(request => request.actor === 'worker_2').at(-1)!
  expect(JSON.stringify(recipient.options.messages))
    .toContain('Verify errors independently; publish to your board task.')
  const leadBlocks = result.requests.filter(request => request.actor === 'lead')
    .flatMap(request => request.options.messages.flatMap(message => message.content))
  expect(leadBlocks.some(block => block.type === 'tool-call' && block.name === 'wait_agents')).toBe(true)
}

function expectPushOnly(result: OfflineResult): void {
  expect(result.yieldedTurns).toBeGreaterThanOrEqual(1)
  const lead = result.requests.filter(request => request.actor === 'lead')
  const beforeYield = JSON.stringify(lead[1]!.options.messages)
  for (const finding of Object.values(NOTES)) expect(beforeYield).not.toContain(finding)
  const historyBlocks = lead.at(-1)!.options.messages.flatMap(message => message.content)
  expect(historyBlocks.some(block => block.type === 'text' && block.text === 'Waiting for worker reports.'))
    .toBe(true)
  expect(historyBlocks.some(block => block.type === 'tool-call' && block.name === 'wait_agents')).toBe(false)
}

describe('offline managed-team sample', () => {
  it.each(['delegation', 'collaboration'] as const)('runs %s through real tools without network access', async mode => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in offline sample'))
    try {
      const result = await runOfflineTeam(mode)
      expect(network).not.toHaveBeenCalled()
      expect(result.text).toBe('Cache rollout: median latency halved (80 ms → 40 ms); error rate stayed at 1%.')
      expect(result.workers.map(worker => worker.result?.text).sort()).toEqual(Object.values(NOTES).sort())
      expect(result.workers.every(worker => worker.status === 'completed' && worker.result?.succeeded)).toBe(true)
      const lead = result.requests.filter(request => request.actor === 'lead')
      const tools = lead[0]!.options.tools!.map(tool => tool.name)
      expect(tools).toContain('spawn_agent')
      const controls = ['send_input', 'wait_agents', 'close_agent', 'get_agent_result']
      if (mode === 'delegation') {
        expect(tools).toEqual(['read_note', 'spawn_agent', 'spawn_agents'])
        for (const control of controls) expect(tools).not.toContain(control)
      }
      // Delegation's second request follows two successful spawn results;
      // collaboration exposes controls eagerly, including before spawning.
      for (const request of lead.slice(mode === 'delegation' ? 1 : 0)) {
        expect(request.options.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(controls))
      }
      for (const legacy of ['list_agents', 'followup_task', 'send_message']) expect(tools).not.toContain(legacy)
      const workers = result.requests.filter(request => request.actor !== 'lead')
      expect(new Set(workers.map(request => request.actor)).size).toBe(2)
      for (const request of workers) {
        expect(request.options.tools?.map(tool => tool.name)).toContain('read_note')
        expect(request.options.tools?.map(tool => tool.name)).not.toContain('spawn_agent')
      }
      if (mode === 'collaboration') {
        expectPeerSend(result)
        expect(tools).toEqual(expect.arrayContaining(['task_create', 'task_list', 'task_update']))
        expect(result.tasks).toHaveLength(2)
        expect(new Set(result.tasks.map(task => task.owner)).size).toBe(2)
        for (const task of result.tasks) {
          expect(task).toMatchObject({ status: 'completed', revision: 3,
            notes: 'Verified against the local read_note source.' })
          expect(Object.values(NOTES)).toContain(task.result)
        }
      } else {
        expectPushOnly(result)
        expect(tools).not.toContain('task_create')
        expect(result.tasks).toEqual([])
        // Ordinary joins/pushes deliver each worker finding once. Explicit board
        // reads in collaboration deliberately repeat shared evidence.
        const history = JSON.stringify(lead.at(-1)!.options.messages)
        for (const finding of Object.values(NOTES)) expect(history.split(finding)).toHaveLength(2)
      }
    } finally { network.mockRestore() }
  })
})
