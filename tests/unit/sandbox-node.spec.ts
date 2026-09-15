import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { chmod, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SandboxDeniedError, SandboxUnavailableError, classifyOutcome, normalizePath, resolveSandboxPolicy,
} from '@alvin0/ai-agent-sdk-sandbox'
import type { SandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'
import {
  checkSandboxDependencies, insideSandbox, localSandbox, platformChain,
  descendantsOf, findAliasedPaths, isSafeBubblewrapVersion, isSecretEnvName,
  runnerDescriptor, SANDBOX_ENV_VAR,
  sandboxChildStarted,
  parseCpuTime, resourceEnforcement, sampleTree, sandboxSpawnOptions, superviseConfined,
  terminateConfined,
  writeConfinedFile,
  SEATBELT_RUNNER_FAILURE_RULES,
  sandboxUnavailableReason,
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

  it('reserves a protected subpath even when it does not exist yet', async () => {
    const root = await workspace()
    await rm(join(root, '.git'), { recursive: true })
    const { argv } = await localSandbox({ platform: 'linux', probe: false, tempRoots: [] })
      .confine(['true'], policyFor(root))
    const protectedPath = normalizePath(join(root, '.git'))
    const mask = argv.indexOf(protectedPath)
    expect(mask).toBeGreaterThan(argv.indexOf(normalizePath(root)))
    expect(argv[mask - 1]).toBe('--tmpfs')
    expect(argv).toContain('--remount-ro')
  })

  it('grants nothing writable under read-only', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false, hardenDefaults: false })
    const { argv } = await provider.confine(['bash', '-c', 'true'], policyFor(root, 'read-only'))
    expect(argv).not.toContain('--bind')
    expect(argv).not.toContain('--tmpfs')
  })

  it('hides credential stores and daemon sockets even under read-only', async () => {
    // Asserted through the fence, not the generated argv: a kernel profile only
    // carries a mount for a path that exists on the host, and a CI runner has
    // no `~/.ssh`. The policy hides it either way, which is the property here.
    const root = await workspace()
    const fence = localSandbox({ probe: false }).fence(policyFor(root, 'read-only'))
    expect(await fence.isReadable(join(homedir(), '.ssh', 'id_rsa'))).toBe(false)
    expect(await fence.isReadable(join(homedir(), '.aws', 'credentials'))).toBe(false)
    expect(await fence.isReadable('/var/run/docker.sock')).toBe(false)
    expect(await fence.isReadable(join(root, 'README.md'))).toBe(true)
  })

  it('leaves them alone when a deployment opts out of hardening', async () => {
    const root = await workspace()
    const fence = localSandbox({ probe: false, hardenDefaults: false })
      .fence(policyFor(root, 'read-only'))
    expect(await fence.isReadable(join(homedir(), '.ssh', 'id_rsa'))).toBe(true)
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
    // The workspace grant must precede the denials carved inside it.
    const grant = profile.indexOf(`(allow file-write* (subpath "${normalizePath(root)}")`)
    expect(grant).toBeGreaterThanOrEqual(0)
    expect(profile.indexOf(`(deny file-write* (subpath "${normalizePath(join(root, '.git'))}")`))
      .toBeGreaterThan(grant)
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

  it('still reads a rejected Seatbelt profile as a runner failure', () => {
    // Against the rule itself: whether a given host keeps this rule depends on
    // whether the generated profile validated there, which is the next test.
    const stderr = "sandbox-exec: syntax error: expecting ')'"
    expect(classifyOutcome({ exitCode: 65, stderr },
      { denialSignatures: [], runnerFailureRules: SEATBELT_RUNNER_FAILURE_RULES }).kind)
      .toBe('runner-failure')
  })

  it('drops that rule once the generated profile has been validated', async () => {
    const root = await workspace()
    const confined = await localSandbox({ platform: 'darwin', probe: false })
      .confine(['true'], policyFor(root))
    const stderr = "sandbox-exec: syntax error: expecting ')'"
    const kind = classifyOutcome({ exitCode: 65, stderr }, confined).kind
    // On a host with a working sandbox-exec the profile validates, so a later
    // report that it was rejected can only be a forgery; elsewhere the rule
    // stays, because nothing has contradicted the report.
    const validated = confined.runnerFailureRules.every(
      rule => !rule.fatalSignatures.includes('sandbox-exec:'))
    expect(kind).toBe(validated ? 'command-failure' : 'runner-failure')
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
    const readDenied = profile.indexOf(`(deny file-read* (subpath "${normalizePath(join(root, 'vendor'))}")`)
    const readReopened = profile.indexOf(`(allow file-read* (subpath "${normalizePath(join(root, 'vendor', 'cache'))}")`)
    expect(readReopened).toBeGreaterThan(readDenied)
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

describe('inherited capabilities and aliased inodes', () => {
  it('offers spawn options that carry nothing but the standard streams', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const confined = await provider.confine(['true'], policyFor(root))
    const options = sandboxSpawnOptions(confined, { env: { PATH: '/usr/bin' } })
    // A descriptor opened before the wrap is a capability the kernel already
    // granted; no mount revokes it, so the child inherits nothing beyond the
    // standard streams and the runner's own status channel.
    expect([...options.stdio]).toEqual(['ignore', 'pipe', 'pipe', 'pipe'])
    expect(confined.statusFd).toBe(3)
    expect(options.env[SANDBOX_ENV_VAR]).toBe('bwrap')
  })

  it('carries only the standard streams for a runner without a status channel', async () => {
    const root = await workspace()
    const confined = await localSandbox({ platform: 'darwin', probe: false })
      .confine(['true'], policyFor(root))
    expect(confined.statusFd).toBeUndefined()
    expect([...sandboxSpawnOptions(confined).stdio]).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('refuses a write to a file whose inode carries another name', async () => {
    const root = await workspace()
    const outside = await workspace()
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, 'ORIGINAL')
    const alias = join(root, 'innocent.txt')
    await link(victim, alias)

    const fence = localSandbox({ probe: false }).fence(policyFor(root))
    expect(await fence.isAliased(alias)).toBe(true)
    expect(await fence.isWritable(alias)).toBe(false)
    await expect(fence.assertWritable(alias)).rejects.toBeInstanceOf(SandboxDeniedError)
    // An ordinary file in the same workspace is unaffected.
    expect(await fence.isWritable(join(root, 'ordinary.txt'))).toBe(true)
  })

  it('permits aliased writes when a deployment deliberately opts in', async () => {
    const root = await workspace()
    const outside = await workspace()
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, 'ORIGINAL')
    const alias = join(root, 'innocent.txt')
    await link(victim, alias)

    const fence = localSandbox({ probe: false, allowAliasedWrites: true }).fence(policyFor(root))
    expect(await fence.isWritable(alias)).toBe(true)
  })
})

describe('a command cannot claim the sandbox failed', () => {
  // The runner and the command share stderr, so a command can print the
  // runner's fatal signature and exit with its code. bubblewrap reports on a
  // descriptor of its own instead, which the command never holds.
  it('ignores a forged runner signature once the runner said the command ran', async () => {
    const root = await workspace()
    const confined = await localSandbox({ platform: 'linux', probe: false })
      .confine(['true'], policyFor(root))
    const forged = { exitCode: 1, stderr: 'bwrap: Cannot mount proc' }
    expect(classifyOutcome(forged, confined).kind).toBe('runner-failure')
    expect(classifyOutcome({ ...forged, childStarted: true }, confined).kind).toBe('command-failure')
  })

  it('reads the start report out of the status descriptor', async () => {
    const root = await workspace()
    const confined = await localSandbox({ platform: 'linux', probe: false })
      .confine(['true'], policyFor(root))
    expect(sandboxChildStarted(confined, [null, '', '', '{"child-pid":42}\n'])).toBe(true)
    expect(sandboxChildStarted(confined, [null, '', '', ''])).toBe(false)
  })
})

describe('check-then-write is not a boundary under concurrency', () => {
  // `assertWritable(path)` answers a question about a path, and the answer is
  // stale the moment it returns. Measured over twenty thousand rounds against a
  // process swapping a symlink, writes landed outside the workspace. The check
  // and the open have to be one step whose result is a descriptor.
  it('refuses to open a final component that is a symlink', async () => {
    const root = await workspace()
    const outside = await workspace()
    const target = join(root, 'target')
    await symlink(join(outside, 'canary.txt'), target)
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policyFor(root))

    // The path itself still looks writable — it is inside the workspace.
    expect(await fence.isWritable(join(root, 'ordinary.txt'))).toBe(true)
    await expect(writeConfinedFile(fence, target, 'RACED'))
      .rejects.toBeInstanceOf(SandboxDeniedError)
    expect(existsSync(join(outside, 'canary.txt'))).toBe(false)
  })

  it('judges a dangling symlink by where it leads, not by its own name', async () => {
    // `stat` follows links, so a link to a path that does not exist yet looked
    // absent — and the resolver then judged the link's own name, which is
    // inside the workspace. The link is what exists; its target is what counts.
    const root = await workspace()
    const outside = await workspace()
    const dangling = join(root, 'dangling')
    await symlink(join(outside, 'not-created-yet.txt'), dangling)
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policyFor(root))
    expect(await fence.isWritable(dangling)).toBe(false)
  })

  it('follows a symlink chain to where it actually lands', async () => {
    const root = await workspace()
    const outside = await workspace()
    await symlink(outside, join(root, 'hop1'), 'dir')
    await symlink(join(root, 'hop1'), join(root, 'hop2'), 'dir')
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policyFor(root))
    expect(await fence.isWritable(join(root, 'hop2', 'x.txt'))).toBe(false)
  })

  it('opens an ordinary path inside the workspace', async () => {
    const root = await workspace()
    const fence = localSandbox({ probe: false, tempRoots: [] }).fence(policyFor(root))
    await writeConfinedFile(fence, join(root, 'written.txt'), 'ok')
    expect(await readFile(join(root, 'written.txt'), 'utf8')).toBe('ok')
  })
})

describe('the environment a confined command receives', () => {
  // A file boundary says nothing about environment variables, and the spawning
  // process usually holds the credentials the agent runs on. Inheriting them
  // wholesale confines the filesystem while the secrets walk through.
  const caller = {
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8',
    GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws_secret',
    ANTHROPIC_API_KEY: 'sk-secret', MY_APP_PASSWORD: 'hunter2',
    BUILD_NUMBER: '42',
  }

  it('passes the baseline and drops everything else', async () => {
    const root = await workspace()
    const confined = await localSandbox({ platform: 'linux', probe: false })
      .confine(['true'], policyFor(root))
    const { env } = sandboxSpawnOptions(confined, { env: caller })
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/u')
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['BUILD_NUMBER']).toBeUndefined()
    expect(env[SANDBOX_ENV_VAR]).toBe('bwrap')
  })

  it('passes a name the deployment explicitly allows', async () => {
    const root = await workspace()
    const confined = await localSandbox({ platform: 'linux', probe: false })
      .confine(['true'], policyFor(root))
    const { env } = sandboxSpawnOptions(confined, { env: caller, allow: ['BUILD_NUMBER'] })
    expect(env['BUILD_NUMBER']).toBe('42')
  })

  it('still removes credential-shaped names when the whole environment is inherited', async () => {
    const root = await workspace()
    const confined = await localSandbox({ platform: 'linux', probe: false })
      .confine(['true'], policyFor(root))
    const { env } = sandboxSpawnOptions(confined, { env: caller, inherit: true })
    expect(env['BUILD_NUMBER']).toBe('42')
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['MY_APP_PASSWORD']).toBeUndefined()
  })

  it('recognises a credential by the shape of its name', () => {
    for (const name of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD',
      'npm_config_auth', 'SESSION_COOKIE', 'MY_PRIVATE_KEY']) {
      expect(isSecretEnvName(name)).toBe(true)
    }
    for (const name of ['PATH', 'HOME', 'BUILD_NUMBER', 'KEYBOARD_LAYOUT']) {
      expect(isSecretEnvName(name)).toBe(false)
    }
  })
})

describe('refusing a boundary the deployment did not agree to', () => {
  it('fails closed when the host only reaches partial enforcement', async () => {
    const root = await workspace()
    // The restricted bubblewrap rung is `partial`; a deployment that needs a
    // real /proc boundary must not silently get one without it.
    const provider = localSandbox({
      platform: 'linux', probe: false, requireEnforcement: 'full',
    })
    // With probing off the chain's first rung is taken, which is `full` here.
    await expect(provider.confine(['true'], policyFor(root))).resolves.toBeDefined()

    const strict = localSandbox({ platform: 'win32', probe: false, requireEnforcement: 'partial' })
    await expect(strict.confine(['true'], policyFor(root)))
      .rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('fails closed when an incomplete alias scan lowers a full runner', async () => {
    const root = await workspace()
    const strict = localSandbox({
      platform: 'linux', probe: false, requireEnforcement: 'full',
      aliasScanOptions: { maxEntries: 0 },
    })
    await expect(strict.confine(['true'], policyFor(root)))
      .rejects.toBeInstanceOf(SandboxUnavailableError)
  })
})

describe('tearing down everything the command started', () => {
  // Killing the process a runner spawned is not the same as ending the work: a
  // command that forks twice and calls setsid leaves the group and is
  // reparented, so nothing connects it to the execution any more.
  it('signals the process group, not just the process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', detached: true,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const result = await terminateConfined(child, { graceMs: 200 })
    expect(result.signalled).toContain(child.pid)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('does not walk the process table where a PID namespace already did', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', detached: true,
    })
    const result = await terminateConfined(child, { graceMs: 100, platform: 'linux' })
    expect(result.strays).toBe(false)
  })

  it('reports no descendants on a platform without a process table to read', () => {
    expect([...descendantsOf(process.pid, 'win32')]).toEqual([])
  })
})

describe('backends express network reach', () => {
  function networkPolicy(root: string, network: 'deny' | 'loopback' | 'allow-all'): SandboxPolicy {
    return resolveSandboxPolicy(
      { cwd: root }, { mode: 'workspace-write', workspaceRoot: root, network },
    ) as SandboxPolicy
  }

  it('unshares the network namespace unless everything is allowed', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    expect((await provider.confine(['true'], networkPolicy(root, 'deny'))).argv)
      .toContain('--unshare-net')
    expect((await provider.confine(['true'], networkPolicy(root, 'loopback'))).argv)
      .toContain('--unshare-net')
    expect((await provider.confine(['true'], networkPolicy(root, 'allow-all'))).argv)
      .not.toContain('--unshare-net')
  })

  it('denies the Seatbelt network class, re-allowing loopback only when asked', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'darwin', probe: false })
    const denied = (await provider.confine(['true'], networkPolicy(root, 'deny'))).argv[2] ?? ''
    expect(denied).toContain('(deny network*)')
    expect(denied).not.toContain('(allow network*')

    const loopback = (await provider.confine(['true'], networkPolicy(root, 'loopback'))).argv[2] ?? ''
    expect(loopback.indexOf('(allow network* (remote ip "localhost:*"))'))
      .toBeGreaterThan(loopback.indexOf('(deny network*)'))

    const open = (await provider.confine(['true'], networkPolicy(root, 'allow-all'))).argv[2] ?? ''
    expect(open).not.toContain('network*')
  })

  it('reports network enforcement separately from file enforcement', async () => {
    const root = await workspace()
    const provider = localSandbox({ platform: 'linux', probe: false })
    const confined = await provider.confine(['true'], networkPolicy(root, 'deny'))
    expect(confined.enforcement).toBe('full')
    expect(confined.networkEnforcement).toBe('full')
    expect((await provider.confine(['true'], networkPolicy(root, 'allow-all'))).networkEnforcement)
      .toBe('none')
  })
})

describe('supervising what an execution consumes', () => {
  // A filesystem boundary can be completely correct while the host falls over.
  // This is a sampler, not a quota: it ends a runaway rather than preventing
  // the allocation, and the overshoot between two samples is the difference.
  it('ends an execution that outlives its wall clock', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', detached: true,
    })
    const result = await superviseConfined(child, { wallClockMs: 300, intervalMs: 50 }).done
    expect(result.terminated).toBe(true)
    expect(result.breach).toBe('wall-clock')
  })

  it('leaves a command that stays within its limits alone', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], {
      stdio: 'ignore', detached: true,
    })
    const result = await superviseConfined(child, { wallClockMs: 10_000, intervalMs: 50 }).done
    expect(result.terminated).toBe(false)
    expect(result.breach).toBeUndefined()
  })

  it('reports monitoring, never a quota, because no allocation is refused', () => {
    expect(resourceEnforcement({ memoryBytes: 1 })).toBe('monitor')
    expect(resourceEnforcement({})).toBe('none')
  })

  it('reads the ps TIME column in every shape it takes', () => {
    expect(parseCpuTime('0:01')).toBe(1_000)
    expect(parseCpuTime('1:02:03')).toBe(3_723_000)
    expect(parseCpuTime('2-01:00:00')).toBe(176_400_000)
    expect(parseCpuTime('nonsense')).toBe(0)
  })

  it('samples nothing on a platform with no process table to read', () => {
    expect(sampleTree(process.pid, 'win32')).toEqual({ memoryBytes: 0, processes: 0, cpuMs: 0 })
  })
})

describe('closing an inode the profile cannot see', () => {
  // The fence refuses an aliased write because it can ask how many names the
  // inode has. The profile binds paths, so without being told it grants one
  // name and the other rides along — the boundary then depends on which layer
  // the caller went through.
  async function aliasedWorkspace(): Promise<{ root: string; alias: string; victim: string }> {
    const root = await workspace()
    const outside = await workspace()
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, 'ORIGINAL')
    const alias = join(root, 'innocent.txt')
    await link(victim, alias)
    await writeFile(join(root, 'normal.txt'), 'ok')
    return { root, alias, victim }
  }

  it('finds the file with two names and leaves the others alone', async () => {
    const { root, alias } = await aliasedWorkspace()
    const scan = await findAliasedPaths([root])
    expect(scan.aliased.map(path => normalizePath(path))).toContain(normalizePath(alias))
    expect(scan.aliased).toHaveLength(1)
    expect(scan.complete).toBe(true)
  })

  it('reports an unfinished scan rather than claiming there is no alias', async () => {
    const { root } = await aliasedWorkspace()
    const scan = await findAliasedPaths([root], { maxEntries: 1 })
    expect(scan.complete).toBe(false)
  })

  it('canonicalizes a symlinked grant root before scanning it', async () => {
    const { root, alias } = await aliasedWorkspace()
    const parent = await workspace()
    const linkedRoot = join(parent, 'linked-root')
    await symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const scan = await findAliasedPaths([linkedRoot])
    expect(scan.complete).toBe(true)
    expect(scan.aliased.map(path => normalizePath(path))).toContain(normalizePath(alias))
    const { argv } = await localSandbox({ platform: 'linux', probe: false })
      .confine(['true'], policyFor(linkedRoot))
    const mask = argv.indexOf(normalizePath(alias))
    expect(mask).toBeGreaterThanOrEqual(0)
    expect(argv[mask - 1]).toBe('--ro-bind-try')
  })

  it('does not re-expose an alias that lives inside a denied subtree', async () => {
    const { root, alias } = await aliasedWorkspace()
    const denied = { ...policyFor(root), entries: [{ path: alias, access: 'deny' as const }] }
    const { argv } = await localSandbox({ platform: 'linux', probe: false, hardenDefaults: false })
      .confine(['true'], denied)
    // One occurrence is the deny layer's destination. A second occurrence
    // would be the alias loop binding the host content back over that mask.
    expect(argv.filter(token => token === normalizePath(alias))).toHaveLength(1)
  })

  it('re-binds the aliased file read-only under bubblewrap', async () => {
    const { root, alias } = await aliasedWorkspace()
    const { argv } = await localSandbox({ platform: 'linux', probe: false })
      .confine(['true'], policyFor(root))
    const real = normalizePath(alias)
    const index = argv.indexOf(real)
    expect(index).toBeGreaterThan(argv.indexOf(normalizePath(root)))
    expect(argv[index - 1]).toBe('--ro-bind-try')
  })

  it('denies writing it under Seatbelt, after the grant that exposed it', async () => {
    const { root, alias } = await aliasedWorkspace()
    const { argv } = await localSandbox({ platform: 'darwin', probe: false })
      .confine(['true'], policyFor(root))
    const profile = argv[2] ?? ''
    const denial = profile.indexOf(`(deny file-write* (literal "${normalizePath(alias)}")`)
    expect(denial).toBeGreaterThan(profile.indexOf(`(allow file-write* (subpath "${normalizePath(root)}")`))
  })

  it('lowers the enforcement claim when the scan could not finish', async () => {
    const { root } = await aliasedWorkspace()
    // A deployment that opts out gets the unscanned profile and keeps its claim.
    const opted = await localSandbox({ platform: 'linux', probe: false, maskAliasedInodes: false })
      .confine(['true'], policyFor(root))
    expect(opted.enforcement).toBe('full')
  })
})

// A host daemon socket lives in a directory the confined user may traverse but
// not list — `/run/containerd` is `0711` on a GitHub runner. bubblewrap builds
// the mount point itself and, since the 0.12.0 hardening, has to read that
// parent to do it: naming the socket there aborts the whole sandbox, so every
// command comes back denied and nothing is confined at all.
describe('masking a path inside a directory that cannot be listed', () => {
  const unlistable = process.platform === 'win32' || process.getuid?.() === 0
  it.skipIf(unlistable)('masks the directory instead of aborting the profile', async () => {
    const root = await workspace()
    const socketDir = join(root, 'run')
    await mkdir(socketDir, { recursive: true })
    await writeFile(join(socketDir, 'daemon.sock'), '')
    await chmod(socketDir, 0o711)
    try {
      const policy = resolveSandboxPolicy({ cwd: root, mode: 'read-only' }, {
        mode: 'read-only', workspaceRoot: root,
        entries: [{ path: join(socketDir, 'daemon.sock'), access: 'deny' }],
      }) as SandboxPolicy
      const { argv } = await localSandbox({ platform: 'linux', probe: false, hardenDefaults: false })
        .confine(['true'], policy)

      // The mask climbs to the directory, which denies strictly more than the
      // socket it contains — a mask may narrow the boundary, never widen it.
      const masked = argv.indexOf(normalizePath(socketDir))
      expect(masked).toBeGreaterThan(0)
      expect(argv[masked - 1]).toBe('--tmpfs')
      expect(argv).not.toContain(normalizePath(join(socketDir, 'daemon.sock')))
    } finally {
      await chmod(socketDir, 0o755)
    }
  })
})

describe('bubblewrap security gate', () => {
  it('accepts the patched upstream line and rejects affected or unreadable versions', () => {
    expect(isSafeBubblewrapVersion('bubblewrap 0.12.0')).toBe(true)
    expect(isSafeBubblewrapVersion('bubblewrap 1.0.0')).toBe(true)
    expect(isSafeBubblewrapVersion('bubblewrap 0.11.2')).toBe(false)
    expect(isSafeBubblewrapVersion('unknown')).toBe(false)
  })
})
