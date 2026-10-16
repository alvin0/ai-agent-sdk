/** Inspect deterministic runtime fixtures without exposing grader answers in the workspace. */
import { mkdir, cp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { selectTasks } from './tasks.ts'
import { Workspace } from './workspace.ts'

const seed = Number(process.argv[2] ?? 16102026), root = resolve(process.argv[3] ?? '/tmp/ma-generated')
if (!Number.isSafeInteger(seed) || seed < 1) throw new Error('Expected positive integer seed')
await mkdir(root, { recursive: false })
for (const task of selectTasks('scaled', seed)) {
  const workspace = await Workspace.create(task)
  try { await cp(workspace.root, join(root, task.id), { recursive: true }) }
  finally { await workspace.close() }
}
