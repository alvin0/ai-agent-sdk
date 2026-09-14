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

- **No network confinement.** File effects only. A confined command can still
  reach the network.
- **No Windows process confinement.** See the table above.
- **Symlinks created inside a granted root after wrapping** are not masked by
  the kernel profile; the fence resolves them per call, the profile does not.

Verified by `.github/workflows/sandbox.yml`, which runs real confined commands
and asserts the outcome rather than trusting that the argv was well-formed. It
covers **both architectures on every platform** — linux, macOS and Windows on
x64 and arm64 — because a sandbox is a kernel boundary and the kernel is what
differs across them, plus a containerized leg for the restricted bubblewrap
rung.
