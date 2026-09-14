import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'
import { checkSandboxDependencies, localSandbox } from '@alvin0/ai-agent-sdk-sandbox-node'

const workspace = mkdtempSync(join(tmpdir(), 'sandbox-node-smoke-'))
try {
  const policy = resolveSandboxPolicy({ cwd: workspace }, { mode: 'workspace-write', workspaceRoot: workspace })
  const fence = localSandbox({ probe: false }).fence(policy)

  assert.equal(await fence.isWritable(join(workspace, 'note.txt')), true)
  assert.equal(await fence.isWritable(join(workspace, '.git', 'config')), false)
  assert.equal(await fence.isWritable('/etc/hosts'), false)

  const report = checkSandboxDependencies(workspace)
  assert.equal(report.fenceAvailable, true)
  assert.equal(typeof report.platform, 'string')

  console.log(`sandbox-node packed fixture ok (backend: ${report.backend ?? 'fence-only'})`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
