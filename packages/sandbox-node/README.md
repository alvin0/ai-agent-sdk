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

## Environment

A file boundary says nothing about environment variables, and the process that
spawns a confined command usually holds the credentials the agent runs on.
`sandboxSpawnOptions` therefore builds an **allow-list**, not an inheritance:
`PATH`, `HOME`, locale, and the handful of names a program needs to start.

```ts
sandboxSpawnOptions(confined, { allow: ['BUILD_NUMBER'] })   // add your own
sandboxSpawnOptions(confined, { inherit: true })             // still drops secrets
```

Credential-shaped names (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`,
`*_CREDENTIALS`, …) are removed even under `inherit`, because an allow-list is
written once and the environment keeps changing.

Confined children also receive `AI_AGENT_SDK_SANDBOX` (the backend id) and
`AI_AGENT_SDK_SANDBOX_MODE`. Nested tools and test suites read them through
`insideSandbox(process.env)` instead of retrying writes that cannot succeed.

## Ending an execution

Killing the process a runner spawned is not the same as ending the work. A
command that forks twice and calls `setsid` leaves the process group and is
reparented, so nothing connects it to the execution any more — measured on
macOS, it kept writing after its sandbox was killed.

```ts
const result = await terminateConfined(child)   // group, then strays
```

On Linux the PID namespace makes this a non-issue and no process table is
walked. Elsewhere the group is signalled and descendants sampled before the
kill are swept. A process that double-forks *between* the sample and the kill
still escapes; closing that needs fork notifications from the kernel, which
Node does not expose.

## Network reach

| Reach | linux (bubblewrap) | macOS (Seatbelt) | Windows |
| --- | --- | --- | --- |
| `deny` | `--unshare-net` | `(deny network*)` | ✗ |
| `loopback` | `--unshare-net` | `(deny network*)` + a localhost rule | ✗ |
| `allow-all` | nothing | nothing | — |

Measured: a TCP connection to a public address returns `ENETUNREACH` under
bubblewrap and `EPERM` under Seatbelt, and succeeds under `allow-all`.

The two backends differ in what `loopback` means, and the difference matters.
Seatbelt denies the operation class and re-allows `localhost`, so the command
reaches a proxy running on the **host**. A network namespace has no such notion:
it gives the sandbox its own loopback, so `loopback` reaches services the
command itself started and nothing the host runs. Reaching a host proxy from
inside a namespace needs a Unix socket bridged in and a forwarder inside — not
built here.

`confine()` reports `networkEnforcement` separately from `enforcement`, because
a host can give you the file boundary and not this one.

## Resource limits

A filesystem boundary can be completely correct while the host falls over. A
fork storm, a growing allocation and a loop that never ends cost nothing in file
effects — measured against these backends, 150 processes, 2 GB of memory and
20 000 files met no resistance at all.

```ts
const child = spawn(confined.argv[0], confined.argv.slice(1), spawnOptions)
const used = await superviseConfined(child, {
  wallClockMs: 60_000, memoryBytes: 2e9, processes: 64,
}).done
// { terminated: true, breach: 'memory', peakMemoryBytes: ... }
```

This is **not a quota**, and the reported enforcement says `monitor` rather than
`quota` for that reason. A quota is the kernel refusing the allocation; this
samples the process tree and tears the execution down afterwards. Measured
against a 300 MB limit, the peak reached 382 MB before the sampler caught it —
that overshoot is exactly the difference, and it is why the level is reported
rather than assumed.

A real quota needs cgroup v2 on Linux or a Job Object on Windows. Neither is
built here: cgroup v2 was not writable in any container tested, including a
privileged one, and shipping a backend that cannot be exercised is how a test
suite ends up green over a path nobody ran.

## Requiring a boundary

`partial` is a state, not a caveat: a bubblewrap rung without its own `/proc`
lets a command reach outside the mounts through another process's procfs entry.
A deployment that cannot accept that says so, and gets `SANDBOX_UNAVAILABLE`
rather than a boundary it did not agree to.

```ts
localSandbox({ requireEnforcement: 'full' })
```

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

- **A path verdict is stale the moment it returns.** `assertWritable(path)`
  answers a question about a name, and another process can replace that name
  with a symlink before the write happens — measured over twenty thousand
  rounds, writes landed outside the workspace. Use `openConfinedWrite` or
  `writeConfinedFile`, which check and open in one step and refuse to follow a
  symlink on the final component. A hostile swap of a *directory* component is
  still not defeated; closing that needs `openat2(RESOLVE_BENEATH)`, which Node
  does not expose. Windows has no `O_NOFOLLOW`, so there the link is refused by
  an explicit check rather than by the kernel, and the open is not atomic.
- **The caller must use `sandboxSpawnOptions`.** A file descriptor opened before
  the wrap is a capability the kernel already granted, and no mount revokes it:
  a child handed an extra descriptor reads and writes through it regardless of
  policy. Neither backend closes inherited descriptors, so the spawn must pass
  nothing but the standard streams and the runner's own status channel.
- **A hard-link scan costs a walk of the writable roots.** One inode under two
  names is invisible to a boundary made of paths, so `confine()` walks the
  granted roots and re-binds every file whose inode carries another name
  read-only — the content stays readable, the write does not land. Measured: a
  write through such a link overwrote its target before, and is denied after.
  The cost is a directory walk per call, bounded at 50 000 entries and depth 24;
  a scan that stops at its bound reports `partial`, because it cannot prove
  the absence of an alias. `maskAliasedInodes: false` opts out.
- **`loopback` does not reach a host proxy on Linux.** A network namespace gives
  the sandbox its own loopback. See *Network reach*.
- **No allow-list by hostname.** Reach is all, loopback, or nothing; permitting
  `github.com` and refusing everything else needs a proxy the sandbox can reach
  and a bridge into the namespace, which is not built here.
- **Resource limits are sampled, not enforced.** `superviseConfined` ends a
  runaway; it does not prevent the spike between two samples. See *Resource
  limits*.
- **A process that double-forks between the sample and the kill escapes the
  sweep** on platforms without a PID namespace. See *Ending an execution*.
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
