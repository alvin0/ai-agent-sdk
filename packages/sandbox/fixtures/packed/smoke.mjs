import assert from 'node:assert/strict'
import {
  classifyOutcome, PROTECTED_SUBPATHS, resolveSandboxPolicy, writableRoots,
} from '@alvin0/ai-agent-sdk-sandbox'

// Widening carve-outs are deployment configuration: a request may only
// restrict, since anything a tool sends is model-authored.
const policy = resolveSandboxPolicy(
  { cwd: '/repo' },
  {
    mode: 'workspace-write', workspaceRoot: '/fallback',
    entries: [{ path: '/repo/build', access: 'write' }],
  },
)
assert.equal(policy.mode, 'workspace-write')
assert.equal(policy.workspaceRoot, '/repo')

const grants = writableRoots(policy)
assert.deepEqual([...grants.roots], ['/repo'])
assert.ok(grants.denied.includes('/repo/.git'), 'protected subpaths are re-denied inside a grant')
assert.ok(PROTECTED_SUBPATHS.includes('.git'))

const runnerFailure = classifyOutcome(
  { exitCode: 1, stderr: 'bwrap: No permissions to creating new namespace' },
  { denialSignatures: ['read-only file system'], runnerFailureRules: [{ fatalSignatures: ['bwrap:'] }] },
)
assert.equal(runnerFailure.kind, 'runner-failure')

console.log('sandbox packed fixture ok')
