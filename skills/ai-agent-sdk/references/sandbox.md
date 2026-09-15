# Sandbox

Two packages. `@alvin0/ai-agent-sdk-sandbox` is Universal and decides;
`@alvin0/ai-agent-sdk-sandbox-node` is Node and enforces. Neither depends on
`-core`, so they compose at the tool layer rather than through a runtime slot.

```bash
pnpm add @alvin0/ai-agent-sdk-sandbox @alvin0/ai-agent-sdk-sandbox-node
```

## The shape of a call

```ts
import {
  classifyOutcome, confiningPolicy, resolveSandboxPolicy,
} from '@alvin0/ai-agent-sdk-sandbox'
import {
  localSandbox, sandboxChildStarted, sandboxSpawnOptions,
} from '@alvin0/ai-agent-sdk-sandbox-node'

const sandbox = localSandbox()                      // select once, reuse

const resolved = resolveSandboxPolicy(
  { cwd: session.cwd, sessionMode: session.mode },   // untrusted half
  { mode: 'read-only', workspaceRoot, network: 'deny' },  // deployment half
)
const policy = confiningPolicy(resolved)
if (policy === undefined) return spawn(argv)         // danger-full-access only

const confined = await sandbox.confine(argv, policy)
const options = sandboxSpawnOptions(confined)
const result = spawnSync(confined.argv[0], confined.argv.slice(1), {
  cwd: policy.workspaceRoot, encoding: 'utf8',
  stdio: [...options.stdio], env: { ...options.env },
})
const outcome = classifyOutcome({
  exitCode: result.status ?? 1,
  stderr: result.stderr ?? '',
  signal: result.signal,
  childStarted: sandboxChildStarted(confined, result.output),
}, confined)
```

`confine()` returns an argv. It does not spawn, and it holds no state — the
policy travels per call, so two consumers may confine differently at the same
instant.

## Wiring into core

Core has no sandbox slot. The seams are `interceptors` and `approvals` on a
session; the tool body resolves the policy and enforces it.

```ts
const asked = new Set<string>(), granted = new Map<string, SandboxApproval>()

const sandboxInterceptor: ToolInterceptor = {
  name: 'sandbox:exec',
  before: async (call, next) => {
    const argv = argvOf(call)                       // undefined for a non-exec tool
    if (argv === undefined) return await next()
    const verdict = classifyExec(argv)
    if (verdict.outcome === 'deny') return { kind: 'deny', reason: verdict.reason }
    if (verdict.outcome !== 'ask-approval') return await next()
    asked.add(call.callId)
    return { kind: 'ask', reason: verdict.reason }  // routed to the broker
  },
  // Reaching `around` for a call that asked IS the person's answer: policy and
  // approval both passed. Mint the capability here, never from tool arguments.
  around: async (call, next) => {
    if (!asked.delete(call.callId)) return await next()
    granted.set(call.callId, approveSandboxEscalation({ entries: escalationFor(call) }))
    try { return await next() } finally { granted.delete(call.callId) }
  },
}

agent.createSession({ tools: [runCommand], interceptors: [sandboxInterceptor], approvals: createApprovalBroker() })
```

Inside `execute`, read the approval by `ctx.callId`, pass it to
`resolveSandboxPolicy`, then `confine()` (a tool that spawns) or `fence()` (a
tool that touches files itself). `ToolInterceptor` and `ToolCallContext` come
from `@alvin0/ai-agent-sdk-core/tools`; `defineTool` and `createApprovalBroker`
from `@alvin0/ai-agent-sdk-core`.

| Seam | Carries |
| --- | --- |
| `interceptors[].before` | `classifyExec` verdict: `allow` / `deny` / `ask` |
| `approvals` (broker) | the person's `allow` \| `deny` \| `abort` |
| `interceptors[].around` | mints `approveSandboxEscalation` once the answer is in |
| `tool.execute` | `resolveSandboxPolicy` + `confine()` / `fence()` |

## Traps

| Symptom | Cause |
| --- | --- |
| A confined child writes outside the workspace anyway | The spawn passed an extra fd. Use `sandboxSpawnOptions`; a descriptor opened before the wrap is a capability no mount revokes. |
| A confined child reads `GITHUB_TOKEN` | The spawn passed `process.env`. `sandboxSpawnOptions` builds an allow-list; `{ allow: [...] }` adds names, `{ inherit: true }` still drops credential-shaped ones. |
| A command claims the sandbox broke, and the harness believes it | `childStarted` was not passed to `classifyOutcome`. The runner and the command share stderr; only the status fd distinguishes them. |
| `resolveSandboxPolicy` throws `SANDBOX_POLICY_INVALID` | A request entry granted `write`. Requests may only restrict; widening needs `approveSandboxEscalation`. |
| An approval works once, then throws | Approvals are spent on first use. Pass `scope: 'session'` if a deployment means otherwise. |
| `confine()` throws `SANDBOX_UNAVAILABLE` on Windows | There is no Win32 backend. `fence(policy)` still applies; catch and fall back, or set `requireEnforcement` and refuse to run. |
| `confine()` throws with `baseline: 'deny'` | An allow-list read baseline is a fence capability. The kernel profiles are not given the system paths a program needs to start. |
| A write lands despite `assertWritable` returning | Check-then-write is racy. Use `openConfinedWrite` / `writeConfinedFile`, which check and open in one step. |
| `enforcement: 'partial'` on Linux | Either the restricted bubblewrap rung (no private `/proc`), or a hard-link scan that hit its bound. |

## Three axes, not one mode

`SandboxMode` governs file effects only. Network and resources are separate
fields on the same policy, and `confine()` reports their enforcement separately.

```ts
{ mode: 'workspace-write', workspaceRoot, network: 'deny', baseline: 'deny' }
```

| Field | Values | Enforced by |
| --- | --- | --- |
| `mode` | `read-only`, `workspace-write`, `danger-full-access` | mounts / Seatbelt |
| `network` | `deny`, `loopback`, `allow-all` | network namespace / `(deny network*)` |
| `baseline` | `read` (default), `deny` | fence only — `confine()` refuses `deny` |
| `entries` | `{ path, access: 'write' \| 'read' \| 'deny' }[]` | both layers |

Entries resolve by path specificity: the last layer containing a path wins, so
`/repo = write`, `/repo/a = deny`, `/repo/a/b = write` behaves as written.
`PROTECTED_SUBPATHS` (`.git`, `.ssh`, `.aws`, `.netrc`, …) is layered under every
granted root automatically and stays readable.

## Authority

A request narrows; only a minted approval widens.

```ts
import { approveSandboxEscalation } from '@alvin0/ai-agent-sdk-sandbox'

// Narrow: one file writable, mode untouched.
approveSandboxEscalation({ entries: [{ path: '/etc/app/x.yaml', access: 'write' }] })

// Wide: the whole workspace writable, and the named resource decorative.
approveSandboxEscalation({ mode: 'workspace-write' })
```

Only a value minted by that call is accepted — `JSON.parse('{"approved":true}')`
is refused, which is what a forged approval in a tool payload looks like.

## Deciding before enforcing

`classifyExec(argv)` reads a command semantically, because the file seam cannot
tell `systemctl status nginx` from `systemctl restart nginx`.

```ts
classifyExec(['systemctl', 'status', 'nginx'])   // observe         → allow
classifyExec(['systemctl', 'restart', 'nginx'])  // service-control → ask-approval
classifyExec(['aws', 'configure', 'list'])       // credential      → deny
```

An unrecognised command is never allowed. A command hiding others — a shell
string, a pipeline, an argv carrying separators — is decided by its riskiest
part. It decides; `confine()` and `fence()` hold.

## The in-process fence

Most SDK tools touch files themselves, which no process sandbox sees.

```ts
const fence = sandbox.fence(policy)
await fence.assertWritable(target)     // throws SandboxDeniedError
await writeConfinedFile(fence, target, data)   // prefer this
```

`fence.isAliased(path)` is true for a file whose inode carries another name;
those writes are refused, and `confine()` re-binds them read-only in the kernel
profile as well.

## Ending a run

```ts
const supervision = superviseConfined(child, { wallClockMs: 60_000, memoryBytes: 2e9 })
const used = await supervision.done          // { terminated, breach, peak… }
await terminateConfined(child)               // group, then strays
```

`resourceEnforcement()` reports `monitor`, never `quota`: limits are sampled and
the run is torn down afterwards, so a spike between samples is not prevented.

## Diagnosis

```ts
const report = checkSandboxDependencies(workspaceRoot)
sandboxUnavailableReason(report)   // undefined, or an operator-actionable string
```

Surface that once at startup. A sandbox that silently stops enforcing because a
tool is missing is worse than none: the operator configured a boundary, saw no
error, and believes it holds.
