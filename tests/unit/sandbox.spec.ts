import { describe, expect, it } from 'vitest'
import {
  accessFor, annotateStderr, classifyOutcome, confiningPolicy, containsPath, dedupeRoots,
  narrowPolicy, normalizePath, PROTECTED_SUBPATHS, resolveSandboxPolicy, sandboxViolation,
  SandboxPolicyError, unreadablePaths, writableRoots,
} from '@alvin0/ai-agent-sdk-sandbox'
import type { SandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return { mode: 'workspace-write', workspaceRoot: '/repo', ...overrides }
}

describe('path algebra', () => {
  it('normalizes separators and relative segments in both dialects', () => {
    expect(normalizePath('/repo//src/../lib/')).toBe('/repo/lib')
    expect(normalizePath('C:\\repo\\src\\..\\lib')).toBe('C:/repo/lib')
  })

  it('drops a `..` that would escape an absolute root', () => {
    expect(normalizePath('/../../etc/passwd')).toBe('/etc/passwd')
  })

  it('compares containment by segment, not by string prefix', () => {
    expect(containsPath('/repo', '/repo/src')).toBe(true)
    expect(containsPath('/repo', '/repo')).toBe(true)
    expect(containsPath('/repo', '/repo-secrets/key')).toBe(false)
  })

  it('folds case only for the win32 dialect', () => {
    expect(containsPath('C:/Repo', 'c:/repo/src')).toBe(true)
    expect(containsPath('/Repo', '/repo/src')).toBe(false)
  })

  it('drops roots already covered by a broader sibling', () => {
    expect([...dedupeRoots(['/repo/src', '/repo', '/tmp'])]).toEqual(['/repo', '/tmp'])
  })
})

describe('policy resolution', () => {
  it('ranks an approved override above the session mode above the default', () => {
    const defaults = { mode: 'read-only' as const, workspaceRoot: '/fallback' }
    expect(resolveSandboxPolicy({}, defaults).mode).toBe('read-only')
    expect(resolveSandboxPolicy({ sessionMode: 'workspace-write' }, defaults).mode).toBe('workspace-write')
    expect(resolveSandboxPolicy({ sessionMode: 'read-only', mode: 'workspace-write' }, defaults).mode)
      .toBe('workspace-write')
  })

  it('uses the session cwd as the workspace boundary, falling back to the deployment root', () => {
    const defaults = { mode: 'workspace-write' as const, workspaceRoot: '/fallback' }
    expect(resolveSandboxPolicy({ cwd: '/repo/./sub' }, defaults).workspaceRoot).toBe('/repo/sub')
    expect(resolveSandboxPolicy({}, defaults).workspaceRoot).toBe('/fallback')
  })

  it('rejects a relative workspace root rather than resolving it silently', () => {
    expect(() => resolveSandboxPolicy({ cwd: 'relative/path' }, { mode: 'read-only', workspaceRoot: '/x' }))
      .toThrow(SandboxPolicyError)
  })

  it('never widens a policy through narrowing', () => {
    const resolved = resolveSandboxPolicy({}, { mode: 'read-only', workspaceRoot: '/repo' })
    expect(narrowPolicy(resolved, 'workspace-write').mode).toBe('read-only')
    expect(narrowPolicy({ ...resolved, mode: 'workspace-write' }, 'read-only').mode).toBe('read-only')
  })

  it('hands back no confining policy under danger-full-access', () => {
    const resolved = resolveSandboxPolicy({}, { mode: 'danger-full-access', workspaceRoot: '/repo' })
    expect(confiningPolicy(resolved)).toBeUndefined()
  })
})

describe('writable roots', () => {
  it('grants nothing under read-only', () => {
    expect([...writableRoots(policy({ mode: 'read-only' })).roots]).toEqual([])
  })

  it('grants the workspace and the supplied temp roots under workspace-write', () => {
    const grants = writableRoots(policy(), { tempRoots: ['/tmp'] })
    expect([...grants.roots]).toEqual(['/repo', '/tmp'])
  })

  it('re-denies every protected subpath inside a granted root', () => {
    const grants = writableRoots(policy())
    for (const name of PROTECTED_SUBPATHS) expect(grants.denied).toContain(`/repo/${name}`)
  })

  it('resolves overlapping carve-outs by path specificity', () => {
    const entries = [
      { path: '/repo', access: 'write' as const },
      { path: '/repo/a', access: 'deny' as const },
      { path: '/repo/a/b', access: 'write' as const },
    ]
    expect(accessFor('/repo/x', entries, 'read')).toBe('write')
    expect(accessFor('/repo/a/x', entries, 'read')).toBe('deny')
    expect(accessFor('/repo/a/b/x', entries, 'read')).toBe('write')
  })

  it('lets a narrower write grant reopen a denied parent', () => {
    const grants = writableRoots(policy({
      entries: [{ path: '/repo/a', access: 'deny' }, { path: '/repo/a/b', access: 'write' }],
    }))
    expect(grants.roots).toContain('/repo')
    expect(grants.denied).toContain('/repo/a')
    expect(grants.denied).not.toContain('/repo/a/b')
  })

  it('reports deny carve-outs as unreadable for backends that can mask', () => {
    const entries = [{ path: '/repo/.env', access: 'deny' as const }]
    expect([...unreadablePaths(policy({ entries }))]).toEqual(['/repo/.env'])
  })
})

describe('outcome classification', () => {
  const input = {
    denialSignatures: ['read-only file system'],
    runnerFailureRules: [{
      fatalSignatures: ['bwrap:'],
      informationalLines: ['bwrap: note: harmless'],
    }],
  }

  it('reports a runner failure before checking any denial signature', () => {
    const result = classifyOutcome({ exitCode: 1, stderr: 'bwrap: cannot create user namespace' }, input)
    expect(result.kind).toBe('runner-failure')
  })

  it('does not let a benign runner notice prove failure by itself', () => {
    const result = classifyOutcome({ exitCode: 1, stderr: 'bwrap: note: harmless\nboom' }, input)
    expect(result.kind).toBe('command-failure')
  })

  it('treats a seccomp kill as a denial without matching any text', () => {
    expect(classifyOutcome({ exitCode: 159, stderr: '' }, input).kind).toBe('denied')
    expect(classifyOutcome({ exitCode: 1, stderr: '', signal: 'SIGSYS' }, input).kind).toBe('denied')
  })

  it('never reads an ordinary shell failure as a sandbox denial', () => {
    expect(classifyOutcome({ exitCode: 127, stderr: 'foo: command not found' }, input).kind)
      .toBe('command-failure')
  })

  it('matches only the wrapping backend dialect, not a cross-backend union', () => {
    const stderr = 'touch: /etc/x: Read-only file system'
    expect(classifyOutcome({ exitCode: 1, stderr }, input).kind).toBe('denied')
    expect(classifyOutcome({ exitCode: 1, stderr }, { ...input, denialSignatures: ['eperm'] }).kind)
      .toBe('command-failure')
  })

  it('annotates a denial so the reason never has to be inferred', () => {
    const classification = classifyOutcome({ exitCode: 1, stderr: 'Read-only file system' }, input)
    expect(annotateStderr('Read-only file system', classification, 'read-only'))
      .toContain("[sandbox] Blocked by sandbox mode 'read-only'")
  })

  it('builds a violation record carrying backend, reason, and path', () => {
    const classification = classifyOutcome(
      { exitCode: 1, stderr: 'touch: /etc/hosts: Read-only file system' }, input,
    )
    const violation = sandboxViolation(classification, 'bwrap', 'read-only')
    expect(violation).toMatchObject({ backend: 'bwrap', reason: 'read-only-filesystem', path: '/etc/hosts' })
  })
})
