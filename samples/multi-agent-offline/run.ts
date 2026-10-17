import { runOfflineTeam } from './team.ts'

const mode = process.argv[2] ?? 'both'
if (!['both', 'delegation', 'collaboration'].includes(mode)) {
  throw new Error('Usage: pnpm sample:multi-agent [both|delegation|collaboration]')
}
for (const selected of ['delegation', 'collaboration'] as const) {
  if (mode !== 'both' && mode !== selected) continue
  const result = await runOfflineTeam(selected)
  console.log(JSON.stringify({
    mode: result.mode, answer: result.text,
    workers: result.workers.map(worker => ({ name: worker.name, status: worker.status })),
    tasks: result.tasks.map(task => ({ id: task.id, owner: task.owner, status: task.status })),
    scriptedCalls: result.requests.length,
    yieldedTurns: result.yieldedTurns,
  }, null, 2))
}
