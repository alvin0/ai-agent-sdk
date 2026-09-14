# @alvin0/ai-agent-sdk-sandbox-node

Process confinement and the in-process path fence for Node hosts. Implements the
seam defined by [`@alvin0/ai-agent-sdk-sandbox`](../sandbox#readme).

Runtime: **Node 22.12+**.

```bash
pnpm add @alvin0/ai-agent-sdk-sandbox @alvin0/ai-agent-sdk-sandbox-node
```

## Two layers, deliberately separate

| Layer | What it governs | linux | macOS | Windows |
| --- | --- | --- | --- | --- |
| `confine()` — process confinement | what a **child process** may touch | bubblewrap | Seatbelt | ✗ |
| `fence()` — in-process path fence | what a **tool does itself** (read/write/edit) | ✓ | ✓ | ✓ |

The process sandbox cannot see a tool that calls `fs.writeFile` inside the agent
host, and the fence cannot follow a spawned process. Most SDK tools are the
first kind, which is why the fence is the layer that works everywhere.

On Windows, `confine()` throws `SANDBOX_UNAVAILABLE` rather than returning an
unwrapped argv — a restricted-token backend needs Win32 APIs that are not
bundled here. The fence still applies.

## Use it

```ts
import { classifyOutcome, resolveSandboxPolicy, confiningPolicy } from '@alvin0/ai-agent-sdk-sandbox'
import { localSandbox } from '@alvin0/ai-agent-sdk-sandbox-node'

const sandbox = localSandbox()

// A tool that spawns a process
const policy = confiningPolicy(resolveSandboxPolicy({ cwd, mode }, defaults))
if (policy === undefined) return spawn(argv) // danger-full-access
const confined = await sandbox.confine(argv, policy)
const result = spawnSync(confined.argv[0], confined.argv.slice(1), {
  env: { ...process.env, ...confined.env },
})
const classification = classifyOutcome({ ...result }, confined)

// A tool that touches files itself
const fence = sandbox.fence(policy)
await fence.assertWritable(target) // throws SandboxDeniedError
```

`confine` takes an **argv, not a shell string**. A shell-shaped consumer passes
`['bash', '-c', command]`. Re-quoting a command through a wrapper is a known
source of corruption, so this seam never does it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `tempRoots` | `[]` | Temp directories `workspace-write` also grants. Empty by default: the host temp directory is shared with other processes, so it is opt-in. Pass `defaultTempRoots()` if your commands need `TMPDIR`. |
| `probe` | `true` | Functionally probe the runner before selecting it, turning a missing tool into `SANDBOX_UNAVAILABLE` instead of a confusing `ENOENT`. |
| `probeTimeoutMs` | `5000` | Per-candidate probe timeout. |
| `runnerCommand` | — | Operator override: a custom runner accepting bubblewrap-compatible profile arguments. Skips probing and is trusted to confine honestly. |
| `platform` | `process.platform` | Injectable for tests. |

Selection is cached for the provider's lifetime, so installing or removing a
runner needs a new provider rather than silently changing the boundary
mid-session.

## Diagnose before you trust it

A sandbox that turns itself off because a tool is missing is worse than none:
the operator configured a boundary, sees no error, and believes it holds.

```ts
import { checkSandboxDependencies, sandboxUnavailableReason } from '@alvin0/ai-agent-sdk-sandbox-node'

const report = checkSandboxDependencies(workspaceRoot)
const reason = sandboxUnavailableReason(report)
if (reason !== undefined) logger.warn(`sandbox is not enforcing: ${reason}`)
```

`report.errors` carries operator-actionable remediation (`apt install
bubblewrap`, `run under WSL2 rather than WSL1`), and `report.fenceAvailable` is
always `true`.

## Environment markers

Confined children receive `AI_AGENT_SDK_SANDBOX` (the backend id) and
`AI_AGENT_SDK_SANDBOX_MODE`. Nested tools and test suites read them through
`insideSandbox(process.env)` instead of retrying writes that cannot succeed.

## Backend profiles

**bubblewrap** binds the host root read-only, then emits one mount per grant
layer in order — bind order is what makes `/repo = write, /repo/vendor = deny,
/repo/vendor/cache = write` behave as written. A denied directory becomes an
empty `tmpfs`, which hides its contents; the `--remount-ro` that makes the
denial real is deferred to the end, because sealing it in place would leave
bubblewrap unable to create the mount point for a grant reopened inside it
(`Can't mkdir ...: Read-only file system`). A private PID namespace is part of the boundary, not a convenience:
without it, procfs magic links reach outside the mounts.

Some hosts refuse to mount a private `/proc` at all — a container whose `/proc`
carries masked paths is the common case — and bubblewrap then fails outright
rather than confining anything. The `bwrap-restricted` rung drops only that
mount, keeping every file bind, and reports `enforcement: 'partial'` because the
outer `/proc` stays reachable. It is selected only when the full profile fails
its probe, and it never claims enforcement it does not have.

**Seatbelt** is allow-default with a blanket `(deny file-write*)` plus explicit
allow-lists, so exactly the mode's promised file effects are governed. Every
path is canonicalized first, because Seatbelt matches resolved paths — `/tmp`
IS `/private/tmp`, and a grant written the other way matches nothing.

## What this does not do

Measured, not assumed — each item below was reproduced by running the attack
under a real backend on macOS and Linux.

- **The caller must use `sandboxSpawnOptions`.** A file descriptor opened before
  the wrap is a capability the kernel already granted, and no mount revokes it:
  a child handed an extra descriptor reads and writes through it regardless of
  policy. Neither backend closes inherited descriptors, so the spawn must pass
  nothing but the standard streams and the runner's own status channel.
- **A pre-existing hard link still escapes the kernel profiles.** One inode
  under two names, one inside the workspace and one outside, lets a write reach
  past a boundary made of paths. The fence refuses writes to a file whose inode
  carries another name, but bubblewrap and Seatbelt cannot see the alias, so a
  spawned process writing through it is not stopped. A confined process cannot
  create such a link — `link()` is denied — so it needs one placed beforehand.
- **No network confinement.** File effects only. A confined command reaches the
  internet: a TCP connection to a public address succeeds. Only paths listed as
  denied are closed to outbound Unix-socket connections.
- **No resource limits.** No rlimit, no cgroup, no accounting: 150 processes,
  2 GB of memory, and 20 000 files were all created without resistance.
- **Seatbelt classification rests on a self-check, not a channel.** bubblewrap
  reports on its own descriptor, so a command cannot claim the sandbox failed.
  Seatbelt has no such channel; instead the generated profile is validated once
  against the host, and the rule a command could forge is dropped when it
  validates. On a host where validation itself fails, the forgeable rule stays.
- **Process visibility differs.** Linux gives a private PID namespace, so only
  the sandbox's own processes are visible. macOS does not: the confined process
  sees its real host PID, and Seatbelt's allow-by-default profile leaves
  process-info and signalling open.
- **No Windows process confinement.** See the table above.
- **Symlinks created inside a granted root after wrapping** are not masked by
  the kernel profile; the fence resolves them per call, the profile does not.

Credential stores and host daemon sockets are hidden by default — `~/.ssh`,
`~/.aws`, `~/.gnupg`, `~/.kube`, `~/.npmrc`, `~/.netrc`, the Docker, Podman,
containerd and D-Bus sockets, and `SSH_AUTH_SOCK`. Pass `hardenDefaults: false`
to opt out. On Seatbelt the denial covers outbound connections as well as reads,
because connecting to a socket is not a file operation and a write boundary
alone leaves a container socket answering, which is host root.

What held, under the same measurement: writes and deletions outside the
workspace, writes through a symlink pointing out of it, writes to protected
metadata directories, nested carve-outs, `/proc` isolation and `mount` on Linux
— a new user namespace can be created there but cannot remount anything
writable, and `/dev` is a private, ephemeral node set rather than the host's.
A tool cannot raise its own mode or grant itself a writable path: widening
requires an approval minted by `approveSandboxEscalation`, which a JSON payload
cannot contain.

Verified by `.github/workflows/sandbox.yml`, which runs real confined commands
and asserts the outcome rather than trusting that the argv was well-formed. It
covers **both architectures on every platform** — linux, macOS and Windows on
x64 and arm64 — because a sandbox is a kernel boundary and the kernel is what
differs across them, plus a containerized leg for the restricted bubblewrap
rung.
