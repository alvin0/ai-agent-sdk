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

## The authorization boundary

Everything a tool sends is model-authored JSON, so a policy input that widens
authority is one the model can grant itself. `mode` and `entries` on a request
are therefore the untrusted half: a requested mode is honoured only when it is
at least as strict as the session's own, and a requested entry granting `write`
is refused outright.

Widening goes through a capability instead of data:

```ts
import { approveSandboxEscalation, resolveSandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'

// After the host has actually authorized it — a human prompt, a policy engine.
const approval = approveSandboxEscalation({ mode: 'workspace-write' })
const policy = resolveSandboxPolicy({ cwd, sessionMode, approval }, defaults)
```

Only a value this module minted is accepted. `JSON.parse('{"approved":true}')`
is refused, which is what a forged approval arriving in a tool payload looks
like. Deployment configuration goes in `defaults`, which is the trusted half and
may grant anything.

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

`grantLayers(policy)` resolves a policy into exactly that: an ordered stack of
layers, broadest first, each overriding the ones beneath it for its own subtree.
Order is the semantics, and it is why the model is a stack rather than a pair of
sets — a set of "granted roots" has nowhere to record a grant that lives *inside*
something denied, so the third line above would silently vanish.

```ts
grantLayers(policy)
//  write  mode       /repo
//  read   protected  /repo/.git        ← and .ssh, .aws, .netrc, …
//  deny   entry      /repo/vendor
//  write  entry      /repo/vendor/cache
```

`PROTECTED_SUBPATHS` (`.git`, `.ssh`, `.aws`, `.netrc`, …) is layered under every
granted root automatically. They are `read`, not `deny`: this is a write
boundary, so they stay readable. An explicit entry at the same depth outranks a
generated one, so a deployment can deliberately reopen one.

A layer that would not change the access already in force is dropped, so the
result carries no rule that does nothing. `writableRoots(policy)` flattens the
same layers for callers that only want the two lists.

This one function is what every enforcement path reads — the kernel profiles and
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
