# Sandbox

A confined command runs with less authority than the process that started it.
`@alvin0/ai-agent-sdk-sandbox` defines what that means; `@alvin0/ai-agent-sdk-sandbox-node`
enforces it on Linux, macOS and Windows.

```bash
pnpm add @alvin0/ai-agent-sdk-sandbox @alvin0/ai-agent-sdk-sandbox-node
```

## The path a request takes

Nothing here decides and enforces at the same time. A request is read, an
outcome chosen, a policy resolved, and only then does anything hold it.

```text
   USER          "restart nginx for me"
     │
     ▼
 ┌───────────────────────┐
 │  classifyExec(argv)   │   reads the command semantically
 └───────────┬───────────┘
             │  capability: service-control
             ▼
 ┌───────────────────────┐
 │  outcome              │   allow │ allow-scoped │ ask-approval │ deny
 └───────────┬───────────┘
             │  ask-approval
             ▼
 ┌───────────────────────┐
 │ approveSandboxEscal…  │   a PERSON approves; the token cannot be forged
 └───────────┬───────────┘
             ▼
 ┌───────────────────────┐
 │ resolveSandboxPolicy  │   a request only narrows; only an approval widens
 └───────────┬───────────┘
             │  SandboxPolicy
     ┌───────┴────────┐
     ▼                ▼
 confine(argv)    fence(policy)
  child process    the tool itself
     │                │
     ▼                ▼
 bubblewrap /      path check
 Seatbelt          per call
```

The left branch and the right branch enforce the same policy through different
mechanisms. Neither substitutes for the other.

## Three axes, kept apart

A policy answers three separate questions, because three separate mechanisms
enforce them and a host can provide one without the others.

| Axis | Values | Enforced by |
| --- | --- | --- |
| File effects | `read-only`, `workspace-write`, `danger-full-access` | mount bindings / Seatbelt profile |
| Network reach | `deny`, `loopback`, `allow-all` | network namespace / `network*` denial |
| Resources | wall clock, memory, processes, CPU | sampling, not a quota |

Folding network into the file mode would make the mode claim something it does
not decide. `confine()` reports each separately for the same reason.

## Two layers of enforcement

```text
  agent host  (your process)
  │
  ├── a tool reads or writes a file itself ──► fence()     ✓ every platform
  │
  └── a tool spawns a process ───────────────► confine()   ✓ linux, macOS
                                                   │       ✗ windows (fails closed)
                                                   └── children, grandchildren,
                                                       all inside the same wrap
```

A process sandbox cannot see a tool calling `fs.writeFile` inside the agent
host, and the fence cannot follow a spawned process. Most SDK tools are the
first kind, which is why the fence is the layer that works everywhere.

```ts
import { confiningPolicy, resolveSandboxPolicy, classifyOutcome } from '@alvin0/ai-agent-sdk-sandbox'
import { localSandbox, sandboxSpawnOptions, sandboxChildStarted } from '@alvin0/ai-agent-sdk-sandbox-node'

const sandbox = localSandbox()
const policy = confiningPolicy(resolveSandboxPolicy(
  { cwd: session.cwd, sessionMode: session.mode },
  { mode: 'read-only', workspaceRoot: deploymentRoot, network: 'deny' },
))
if (policy === undefined) return spawn(argv)          // danger-full-access

const confined = await sandbox.confine(argv, policy)
const options = sandboxSpawnOptions(confined)
const result = spawnSync(confined.argv[0], confined.argv.slice(1), {
  stdio: [...options.stdio], env: { ...options.env },
})
const outcome = classifyOutcome({
  exitCode: result.status ?? 1,
  stderr: result.stderr ?? '',
  childStarted: sandboxChildStarted(confined, result.output),
}, confined)
```

`sandboxSpawnOptions` is not optional decoration. A descriptor opened before the
wrap is a capability the kernel already granted and no mount revokes, and the
environment it builds is an allow-list — the process spawning a confined command
usually holds the credentials the agent runs on.

## How a path gets its access

A policy is not two lists. It is an ordered stack, broadest first, and the
access at a path is whatever the **last** layer containing it said.

```text
 policy: workspace-write /repo
         entries: /repo/vendor = deny
                  /repo/vendor/cache = write

 grantLayers()                         broadest ──► narrowest
 ┌──────────────────────────────────────────────────────────┐
 │  write   mode        /repo                               │
 │  read    protected   /repo/.git   (.ssh .aws .netrc …)   │
 │  deny    entry       /repo/vendor                        │
 │  write   entry       /repo/vendor/cache                  │
 └──────────────────────────────────────────────────────────┘

 /repo/src/a.ts         → write
 /repo/.git/config      → read     a grant never reaches repository metadata
 /repo/vendor/x         → deny
 /repo/vendor/cache/x   → write    a narrower layer reopens a denied parent
```

Flattening that into "granted roots" plus "denied paths" loses the last line:
a set of roots has nowhere to record a grant living inside something denied.

## Authority only ever decreases

```text
  deployment default ──┐
                       ├──► CEILING ─────────────► the mode this call runs under
  session mode ────────┘         ▲            ▲
                                 │            │
  request.mode ── may only ──────┘            │
                 NARROW                       │
                                              │
  approval  ── minted, not parsed ── may ─────┘
              (WeakSet membership)   WIDEN
```

Everything a tool sends is model-authored JSON, so a policy input that widens
authority is one the model can widen. A request may tighten its own execution
and never loosen it; widening goes through a capability instead of data.

```ts
import { approveSandboxEscalation } from '@alvin0/ai-agent-sdk-sandbox'

// After the host has actually authorized it — a prompt, a policy engine.
const approval = approveSandboxEscalation({
  entries: [{ path: '/etc/app/config.yaml', access: 'write' }],
})
resolveSandboxPolicy({ cwd, approval }, defaults)
```

Only a value minted by that call is accepted; `JSON.parse('{"approved":true}')`
is refused. An approval is spent on first use — a person approving "write this
file" approved one write — with `scope: 'session'` and `expiresAt` for a
deployment that means otherwise.

Note what the grant above does not do: it never mentions a mode, so the policy
stays `read-only` and exactly one file becomes writable. Raising the mode
instead makes the whole workspace writable and the named resource decorative.

## Reading the result

Two failures look identical in a shell and mean opposite things. A *denial*
means confinement worked; a *runner failure* means the command never ran.

```text
  the command exits
        │
        ├─ exit 0 ─────────────────────────────────────► success
        │
        ├─ runner reported "I started it" on its own fd ─┐
        │      (bubblewrap --json-status-fd)             │ no runner-failure
        │                                                │ rule may apply
        ├─ a runner-failure rule matches stderr ────────► runner-failure
        │      (exit gate + fatal line, noise removed)
        │
        ├─ killed by SIGSYS ───────────────────────────► denied
        │      (a seccomp kill needs no text matching)
        │
        ├─ exit 2 / 126 / 127 ─────────────────────────► command-failure
        │
        └─ stderr matches THIS backend's denial dialect ─► denied
                 otherwise ────────────────────────────► command-failure
```

Matching a cross-backend union of denial strings would claim denials a given
backend never produces, so only the dialect of the wrapping backend is used.

## Deciding before enforcing

The file seam cannot tell `systemctl status nginx` from `systemctl restart
nginx`: both are argv, neither writes a file the policy governs, and one
observes while the other changes the machine.

```ts
import { classifyExec } from '@alvin0/ai-agent-sdk-sandbox'

classifyExec(['systemctl', 'status', 'nginx'])   // observe         -> allow
classifyExec(['systemctl', 'restart', 'nginx'])  // service-control -> ask-approval
classifyExec(['aws', 'configure', 'list'])       // credential      -> deny
```

A command it does not recognise is never allowed, and one that hides others — a
shell string, a pipeline, a chain — is decided by the riskiest thing inside it.
It decides; `confine()` and `fence()` are what hold.

## What each platform actually enforces

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Process confinement | bubblewrap | Seatbelt | ✗ — `confine()` fails closed |
| Network | network namespace | `(deny network*)` | ✗ |
| Process teardown | PID namespace | group + descendant sweep | partial |
| In-process fence | ✓ | ✓ | ✓ |

`confine()` reports `enforcement` as `full`, `partial` or `fence-only` rather
than implying it. A deployment that cannot accept less says so:

```ts
localSandbox({ requireEnforcement: 'full' })   // otherwise SANDBOX_UNAVAILABLE
```

## What it does not do

These are measured, not assumed — each was reproduced under a real backend.

- **Resource limits are sampled, not enforced.** Against a 300 MB limit the peak
  reached 382 MB before the sampler caught it. A real quota needs cgroup v2 or a
  Job Object.
- **A hostile swap of a directory component defeats the path check.** Use
  `openConfinedWrite`, which checks and opens in one step and refuses a symlink
  on the final component; the directory above it needs `openat2`, which Node
  does not expose.
- **A process that double-forks between a sample and the kill escapes the
  sweep** on platforms without a PID namespace.
- **Reads are a deny-list by default.** `baseline: 'deny'` inverts that into an
  allow-list, enforced by the fence; `confine()` refuses it rather than
  pretending, because inverting a mount profile means binding the exact set a
  program needs to start, which is specific to an OS build.
- **No allow-list by hostname.** Reach is all, loopback or nothing.

## Read next

- [Security](/en/10-advanced/security) — credentials, endpoint policy, privacy defaults
- [Production Deployment](/en/10-advanced/production-deployment)
