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

## Wiring it into an agent

Neither package depends on `-core`, and core has no sandbox slot to fill. They
meet at two seams a session already has: an **interceptor** decides, the
**approval broker** asks a person, and the tool body enforces.

```ts
import { createApprovalBroker } from '@alvin0/ai-agent-sdk-core'
import type { ToolCallContext, ToolInterceptor } from '@alvin0/ai-agent-sdk-core/tools'
import { approveSandboxEscalation, classifyExec, type SandboxApproval } from '@alvin0/ai-agent-sdk-sandbox'

/** Argv of a command-running tool call; `undefined` for a tool that runs none. */
const argvOf = (call: ToolCallContext): readonly string[] | undefined =>
  call.toolName === 'run_command' ? commandArgv(call.args) : undefined

const asked = new Set<string>()
const granted = new Map<string, SandboxApproval>()

const sandboxInterceptor: ToolInterceptor = {
  name: 'sandbox:exec',
  before: async (call, next) => {
    const argv = argvOf(call)
    if (argv === undefined) return await next()
    const verdict = classifyExec(argv)
    if (verdict.outcome === 'deny') return { kind: 'deny', reason: verdict.reason }
    if (verdict.outcome !== 'ask-approval') return await next()
    asked.add(call.callId)
    return { kind: 'ask', reason: verdict.reason }
  },
  // `around` runs only after policy and approval passed, so reaching it for a
  // call that asked IS the person's answer. Mint the capability here, not from
  // anything the model wrote.
  around: async (call, next) => {
    if (!asked.delete(call.callId)) return await next()
    granted.set(call.callId, approveSandboxEscalation({ entries: escalationFor(call) }))
    try { return await next() } finally { granted.delete(call.callId) }
  },
}

const approvals = createApprovalBroker()
const session = agent.createSession({ tools: [runCommand], interceptors: [sandboxInterceptor], approvals })
```

`classifyExec` answers what is machine-decidable and `'ask'` hands the rest to
the broker — the same split [Permissions](/en/03-tools/permissions) describes.
`allow-scoped` is not an `allow`: it means run it, under the policy.

The tool body is where the policy is resolved and held. It reads the approval by
call id — an approval is a capability, and `resolveSandboxPolicy` accepts only a
minted one, never a field in model-authored JSON:

```ts
const runCommand = defineTool({
  name: 'run_command',
  description: 'Run a command inside the workspace sandbox.',
  parameters: { /* … */ },
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    const approval = granted.get(ctx.callId)
    const policy = confiningPolicy(resolveSandboxPolicy(
      { cwd: workspaceRoot, sessionMode, ...approval === undefined ? {} : { approval } },
      { mode: 'workspace-write', workspaceRoot, network: 'deny' },
    ))
    if (policy === undefined) return await spawnUnconfined(args.argv, ctx.signal)
    const confined = await sandbox.confine(args.argv, policy)
    const options = sandboxSpawnOptions(confined)
    // … spawn with options.stdio / options.env, then classifyOutcome(…, confined)
  },
})
```

A tool that touches files itself — most SDK tools — never spawns anything, so no
process sandbox sees it. That one takes the other layer, in the same `execute`:

```ts
const fence = sandbox.fence(policy)
await writeConfinedFile(fence, target, data)   // checks and opens in one step
```

Three properties survive this wiring, and each fails silently if it is dropped:
the session's `mode` is the **ceiling** and a tool argument may only narrow it;
the approval is **minted by the host** after the broker answered, never parsed
from arguments; and the classification decides while `confine()` and `fence()`
hold — one without the other is either a prompt with no enforcement or
enforcement with nobody asked.

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
