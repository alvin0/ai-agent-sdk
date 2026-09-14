import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SandboxDeniedError, SandboxUnavailableError, classifyOutcome, normalizePath, resolveSandboxPolicy,
} from '@alvin0/ai-agent-sdk-sandbox'
import type { SandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'
import {
  checkSandboxDependencies, insideSandbox, localSandbox, platformChain,
  runnerDescriptor, SANDBOX_ENV_VAR, sandboxUnavailableReason,
} from '@alvin0/ai-agent-sdk-sandbox-node'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sandbox-node-')))
  roots.push(root)
  await mkdir(join(root, '.git'), { recursive: true })
  return root
}

function policyFor(root: string, mode: SandboxPolicy['mode'] = 'workspace-write'): SandboxPolicy {
  return resolveSandboxPolicy({ cwd: root, mode }, { mode, workspaceRoot: root }) as SandboxPolicy
}

describe('in-process fence', () => {
  it('permits writes inside the workspace and refuses them outside', async () => {
    const root = await workspace()
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policyFor(root))
    expect(await fence.isWritable(join(root, 'note.txt'))).toBe(true)
    expect(await fence.isWritable('/etc/hosts')).toBe(false)
  })

  it('keeps the repository metadata directory out of a granted workspace', async () => {
    const root = await workspace()
    const fence = localSandbox({ probe: false }).fence(policyFor(root))
    expect(await fence.isWritable(join(root, '.git', 'config'))).toBe(false)
  })

  it('refuses every write under read-only', async () => {
    const root = await workspace()
    const fence = localSandbox({ probe: false }).fence(policyFor(root, 'read-only'))
    expect(await fence.isWritable(join(root, 'note.txt'))).toBe(false)
    await expect(fence.assertWritable(join(root, 'note.txt'))).rejects.toBeInstanceOf(SandboxDeniedError)
  })

  it('judges a path by where it would actually be created, not by its spelling', async () => {
    const root = await workspace()
    const outside = await workspace()
    await symlink(outside, join(root, 'link'), 'dir')
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policyFor(root))
    // The path is lexically inside the workspace, but resolves outside it.
    expect(await fence.isWritable(join(root, 'link', 'escaped.txt'))).toBe(false)
  })

  it('permits a file that does not exist yet inside the workspace', async () => {
    const root = await workspace()
    const fence = localSandbox({ probe: false }).fence(policyFor(root))
    expect(await fence.isWritable(join(root, 'deep', 'not', 'created', 'yet.txt'))).toBe(true)
  })

  it('hides a deny carve-out from reads while the workspace stays readable', async () => {
    const root = await workspace()
    await writeFile(join(root, '.env'), 'SECRET=1')
    const policy = { ...policyFor(root), entries: [{ path: join(root, '.env'), access: 'deny' as const }] }
    const fence = localSandbox({ probe: false }).fence(policy)
    expect(await fence.isReadable(join(root, '.env'))).toBe(false)
    expect(await fence.isReadable(join(root, 'README.md'))).toBe(true)
  })
})

describe('runner selection', () => {
  it('names a candidate chain for every supported platform and none for win32', () => {
    expect([...platformChain('linux')]).toEqual(['bwrap', 'bwrap-restricted'])
    expect([...platformChain('darwin')]).toEqual(['seatbelt'])
    expect([...platformChain('win32')]).toEqual([])
  })

  it('fails closed rather than returning an unconfined argv', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'win32', probe: false })
    await expect(provider.confine(['bash', '-c', 'true'], policyFor(root)))
      .rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('still offers the fence on a platform with no process backend', async () => {
    const root = await workspace()
    const fence = localSandbox({ platform: 'win32', probe: false }).fence(policyFor(root))
    expect(await fence.isWritable(join(root, 'note.txt'))).toBe(true)
  })

  it('wraps through an operator-supplied runner without probing', async () => {
    const root = await workspace()
    const provider = localSandbox({
      platform: 'linux', probe: false,
      runnerCommand: ['my-runner'], runnerFailureSignatures: ['my-runner:'],
    })
    const confined = await provider.confine(['bash', '-c', 'true'], policyFor(root))
    expect(confined.backend).toBe('custom')
    expect(confined.argv[0]).toBe('my-runner')
    expect(confined.argv.slice(-3)).toEqual(['bash', '-c', 'true'])
  })
})

describe('confined argv', () => {
  it('binds the host root read-only and layers the workspace back on top', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false, tempRoots: [] })
    const { argv } = await provider.confine(['bash', '-c', 'true'], policyFor(root))
    // The profile carries normalized paths: a Windows host spells the same root
    // `C:\\...` through `node:path` and `C:/...` through the contract, and a
    // comparison in the host's spelling would pass on POSIX and fail there.
    const bound = normalizePath(root)
    expect(argv[0]).toBe('bwrap')
    expect(argv.join(' ')).toContain('--ro-bind / /')
    expect(argv.join(' ')).toContain(`--bind ${bound} ${bound}`)
  })

  it('re-denies protected subpaths after the grant that would expose them', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false, tempRoots: [] })
    const { argv } = await provider.confine(['bash', '-c', 'true'], policyFor(root))
    const grantIndex = argv.indexOf(normalizePath(root))
    const denyIndex = argv.indexOf(normalizePath(join(root, '.git')))
    expect(grantIndex).toBeGreaterThanOrEqual(0)
    expect(denyIndex).toBeGreaterThan(grantIndex)
  })

  it('grants nothing writable under read-only', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const { argv } = await provider.confine(['bash', '-c', 'true'], policyFor(root, 'read-only'))
    expect(argv).not.toContain('--bind')
    expect(argv).not.toContain('--tmpfs')
  })

  it('builds an allow-default Seatbelt profile that denies writes by default', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'darwin', probe: false, tempRoots: [] })
    const { argv } = await provider.confine(['bash', '-c', 'true'], policyFor(root))
    expect(argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(argv[1]).toBe('-p')
    const profile = argv[2] ?? ''
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile.indexOf('(deny file-write* (subpath')).toBeGreaterThan(profile.indexOf('(allow file-write* (subpath'))
  })

  it('marks the confinement in the environment so children can detect it', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const { env } = await provider.confine(['bash', '-c', 'true'], policyFor(root))
    expect(env[SANDBOX_ENV_VAR]).toBe('bwrap')
    expect(insideSandbox(env)).toBe(true)
    expect(insideSandbox({})).toBe(false)
  })
})

describe('diagnosis', () => {
  it('reports the fence as available even where confinement is not', async () => {
    const root = await workspace()
    const report = checkSandboxDependencies(root, 'win32')
    expect(report.fenceAvailable).toBe(true)
    expect(report.backend).toBeUndefined()
    expect(sandboxUnavailableReason(report)).toContain('win32')
  })

  it('stays silent when a backend is usable', async () => {
    const root = await workspace()
    const report = checkSandboxDependencies(root)
    if (report.backend !== undefined) expect(sandboxUnavailableReason(report)).toBeUndefined()
    else expect(sandboxUnavailableReason(report)).toBeTypeOf('string')
  })
})

describe('runner failure is distinguished from an ordinary command failure', () => {
  // Both runners prefix the child's exec failure with their own name, so the
  // prefix alone would report a missing program as a broken sandbox. Only the
  // exit code separates them, and these are the codes each one actually uses.
  it('reads a Seatbelt execvp failure as a command failure, not a broken sandbox', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'darwin', probe: false })
    const confined = await provider.confine(['missing-program'], policyFor(root))
    const stderr = "sandbox-exec: execvp() of 'missing-program' failed: No such file or directory"
    expect(classifyOutcome({ exitCode: 71, stderr }, confined).kind).toBe('command-failure')
  })

  it('still reads a rejected Seatbelt profile as a runner failure', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'darwin', probe: false })
    const confined = await provider.confine(['true'], policyFor(root))
    const stderr = "sandbox-exec: syntax error: expecting ')'"
    expect(classifyOutcome({ exitCode: 65, stderr }, confined).kind).toBe('runner-failure')
  })

  it('reads a bubblewrap execvp failure as a command failure', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const confined = await provider.confine(['missing-program'], policyFor(root))
    // Measured on bubblewrap 0.8.0: this exits 1, exactly like a setup failure.
    const stderr = 'bwrap: execvp missing-program: No such file or directory'
    expect(classifyOutcome({ exitCode: 1, stderr }, confined).kind).toBe('command-failure')
  })

  it('still reads a bubblewrap setup failure as a runner failure', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const confined = await provider.confine(['true'], policyFor(root))
    const stderr = 'bwrap: No permissions to creating new namespace'
    expect(classifyOutcome({ exitCode: 1, stderr }, confined).kind).toBe('runner-failure')
  })
})

describe('temp roots are an opt-in grant', () => {
  it('grants no host temp directory unless the consumer asks for one', async () => {
    const root = await workspace()
    const sibling = await workspace()
    const fence = localSandbox({ probe: false }).fence(policyFor(root))
    expect(await fence.isWritable(join(sibling, 'x.txt'))).toBe(false)
  })

  it('grants the temp roots it is given', async () => {
    const root = await workspace()
    const sibling = await workspace()
    const fence = localSandbox({ probe: false, tempRoots: [sibling] }).fence(policyFor(root))
    expect(await fence.isWritable(join(sibling, 'x.txt'))).toBe(true)
  })
})

describe('a workspace reached through a symlink', () => {
  // `/tmp` IS `/private/tmp` on macOS and `/home` is often a link, so a policy
  // routinely carries an unresolved root. Resolving only the target would then
  // refuse writes inside the workspace that was actually granted.
  it('still permits writes inside the workspace it granted', async () => {
    const real = await workspace()
    const parent = await workspace()
    const link = join(parent, 'linked-workspace')
    await symlink(real, link, 'dir')
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policyFor(link))
    expect(await fence.isWritable(join(link, 'note.txt'))).toBe(true)
    expect(await fence.isWritable(join(real, 'note.txt'))).toBe(true)
  })
})

describe('a host that refuses a fresh /proc', () => {
  // Mounting a private /proc is refused on some hosts even for a privileged
  // user — a container whose /proc carries masked paths is the common case —
  // and bubblewrap then fails outright instead of confining anything. The
  // fallback keeps the file binds and says so, rather than claiming full
  // enforcement it no longer has.
  it('drops only the /proc mount and reports partial enforcement', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const confined = await provider.confine(['true'], policyFor(root))
    expect(confined.argv).toContain('--proc')

    const fallback = await localSandbox({
      platform: 'linux', probe: true,
      // No candidate passes its probe except the restricted one.
      probeTimeoutMs: 1,
    }).confine(['true'], policyFor(root)).catch(() => undefined)
    // The probe outcome is host-dependent; the descriptor contract is not.
    expect(runnerDescriptor('bwrap').enforcement).toBe('full')
    expect(runnerDescriptor('bwrap-restricted').enforcement).toBe('partial')
    if (fallback?.backend === 'bwrap-restricted') expect(fallback.argv).not.toContain('--proc')
  })
})

describe('a narrower grant beneath a denial reaches every layer', () => {
  async function nested(): Promise<{ root: string; policy: SandboxPolicy }> {
    const root = await workspace()
    await mkdir(join(root, 'vendor', 'cache'), { recursive: true })
    const base = policyFor(root)
    return {
      root,
      policy: {
        ...base,
        entries: [
          { path: join(root, 'vendor'), access: 'deny' },
          { path: join(root, 'vendor', 'cache'), access: 'write' },
        ],
      },
    }
  }

  it('the fence permits the reopened path and still refuses its denied parent', async () => {
    const { root, policy } = await nested()
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policy)
    expect(await fence.isWritable(join(root, 'vendor', 'cache', 'x'))).toBe(true)
    expect(await fence.isWritable(join(root, 'vendor', 'x'))).toBe(false)
    expect(await fence.isReadable(join(root, 'vendor', 'x'))).toBe(false)
    expect(await fence.isReadable(join(root, 'vendor', 'cache', 'x'))).toBe(true)
  })

  it('bubblewrap binds the reopened path after the mount that denied it', async () => {
    const { root, policy } = await nested()
    const { argv } = await localSandbox({ platform: 'linux', probe: false }).confine(['true'], policy)
    const denied = argv.indexOf(normalizePath(join(root, 'vendor')))
    const reopened = argv.indexOf(normalizePath(join(root, 'vendor', 'cache')))
    expect(denied).toBeGreaterThanOrEqual(0)
    expect(reopened).toBeGreaterThan(denied)
    expect(argv[reopened - 1]).toBe('--bind')
  })

  it('Seatbelt allows the reopened path after the rule that denied it', async () => {
    const { root, policy } = await nested()
    const { argv } = await localSandbox({ platform: 'darwin', probe: false }).confine(['true'], policy)
    const profile = argv[2] ?? ''
    const denied = profile.indexOf(`(deny file-write* (subpath "${normalizePath(join(root, 'vendor'))}")`)
    const reopened = profile.indexOf(`(allow file-write* (subpath "${normalizePath(join(root, 'vendor', 'cache'))}")`)
    expect(denied).toBeGreaterThanOrEqual(0)
    expect(reopened).toBeGreaterThan(denied)
  })
})

describe('a protected subpath enforced by a mount reports as a denial', () => {
  // bubblewrap enforces a protected subpath by bind-mounting it, and removing a
  // mount point reports EBUSY rather than a permission error. Measured on 0.8.0:
  // `rm -rf .git` yields "EBUSY: resource busy or locked, rmdir". Reading that
  // as an ordinary command failure would tell a model its command was broken
  // when the sandbox is precisely what stopped it.
  it('classifies a busy mount point as denied, not as a command failure', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const confined = await provider.confine(['true'], policyFor(root))
    const stderr = `Error: EBUSY: resource busy or locked, rmdir '${join(root, '.git')}'`
    expect(classifyOutcome({ exitCode: 1, stderr }, confined).kind).toBe('denied')
  })
})
