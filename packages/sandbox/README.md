# @alvin0/ai-agent-sdk-sandbox

The sandbox contract: the file-effect vocabulary, per-call policy resolution,
the writable-root algebra every backend shares, and the rules that keep a broken
sandbox from reading as a denied command.

Runtime: **Universal**. This package imports nothing — no `node:` builtins, no
dependencies — so it runs anywhere the core SDK does. Enforcement lives in
[`@alvin0/ai-agent-sdk-sandbox-node`](../sandbox-node#readme).

```bash
pnpm add @alvin0/ai-agent-sdk-sandbox
```

## Modes

`SandboxMode` governs **file effects only**. Network reachability and process
visibility are deliberately outside this vocabulary; they belong to their own
seam, and a mode that claimed to cover them would be lying.

| Mode | File effects |
| --- | --- |
| `read-only` | No writes anywhere; the backend still permits the `/dev/null` sink a shell needs |
| `workspace-write` | Writes under the workspace root, plus any temp roots the consumer explicitly grants |
| `danger-full-access` | No confinement; the provider is never consulted |

## Per-call policy

Policy is resolved per capability call, never fixed on the provider. Two
consumers can confine under different boundaries at the same instant, and an
approved escalation is a *new call with a wider policy* — not a mutation of
shared state.

```ts
import { confiningPolicy, resolveSandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'

const resolved = resolveSandboxPolicy(
  { cwd: session.cwd, sessionMode: session.mode, mode: approvedOverride },
  { mode: 'read-only', workspaceRoot: deploymentRoot },
)

const policy = confiningPolicy(resolved)
// `undefined` under danger-full-access: spawn the original argv, ask nothing.
```

Precedence is fixed: an approved explicit mode outranks the session's mode,
which outranks the deployment default. A session's cwd is its `workspace-write`
boundary; the configured root is the fallback for agentless calls.

## Nested carve-outs

A single writable root is not enough. An agent that may write in a repository
must still be kept out of `.git`, or it can install a hook that runs arbitrary
code on the next `git` invocation. Entries express that as an overlapping list
resolved by **path specificity** — the deepest matching entry wins:

```ts
const entries = [
  { path: '/repo',     access: 'write' },
  { path: '/repo/a',   access: 'deny'  },
  { path: '/repo/a/b', access: 'write' },
]
// /repo/x → write · /repo/a/x → deny · /repo/a/b/x → write
```

`writableRoots(policy)` turns a policy into the grants *and* the re-denials that
must follow them. `PROTECTED_SUBPATHS` (`.git`, `.ssh`, `.aws`, `.netrc`, …) is
appended under every granted root automatically.

This one function is what both enforcement layers read — the kernel profiles and
the in-process fence. Deriving them separately is how a profile and a fence
silently drift into disagreeing about what is writable.

## Classification

Two failures look identical in a shell and mean opposite things:

- **denied** — confinement worked and blocked the command.
- **runner failure** — the sandbox itself refused or crashed; the command
  *never ran*.

Reporting the second as the first sends a model off rewriting correct code.
`classifyOutcome` checks runner failure first, and never infers it from an exit
code alone: a rule needs a nonzero exit, its own exit-code gate, and a fatal
signature on a line that survives informational exclusion.

```ts
import { annotateStderr, classifyOutcome } from '@alvin0/ai-agent-sdk-sandbox'

const classification = classifyOutcome(
  { exitCode: result.status, stderr: result.stderr, signal: result.signal },
  confined, // carries the wrapping backend's own dialect
)
const stderr = annotateStderr(result.stderr, classification, policy.mode)
```

Denial signatures are matched against **the backend that actually wrapped the
command**, never a cross-backend union — a union claims denials a given backend
never produces. A `SIGSYS` kill is treated as a denial without matching any
text, because a seccomp kill is unambiguous.

## Fail closed

`SandboxUnavailableError` (`SANDBOX_UNAVAILABLE`) is thrown when no backend can
enforce a confining policy. Silently running unconfined is never legal: an
operator who configured a boundary and sees no error believes it is enforced.

## Exports

`resolveSandboxPolicy` · `confiningPolicy` · `narrowPolicy` · `writableRoots` ·
`unreadablePaths` · `accessFor` · `orderEntries` · `createFsFence` ·
`classifyOutcome` · `annotateStderr` · `sandboxViolation` · the path algebra
(`normalizePath`, `containsPath`, `dedupeRoots`, …) and every contract type.
