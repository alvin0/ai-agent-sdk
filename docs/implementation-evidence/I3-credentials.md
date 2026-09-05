# I3/I4 credential capability evidence

The normal provider path now consumes core's versioned `CredentialSource` and
`CredentialStore` contracts. Literal credentials remain valid for the simplest
server-side case; marker-free callbacks and Codex `read/write` stores remain only
on the deprecated advanced compatibility path.

## Implemented boundaries

- `envCredential()` is a frozen versioned source and the same value remains
  callable for source compatibility. Environment access is lazy and occurs only
  when the source is resolved with an operation signal.
- OpenAI and Anthropic preferred plugins validate and capture credential markers
  during provider setup without invoking accessors, resolvers or network I/O.
- Codex validates and captures a revisioned store before storage or network I/O.
  One prepared model operation supplies the same signal to the initial store
  read, refresh read and compare-and-swap commit. The OAuth request adds its own
  request deadline but remains linked to that operation signal and abort reason.
- `fileCodexCredentialStore()` is Node-only, symlink-safe at the target, bounded
  to 1 MiB, and uses an exclusive cross-process writer lock plus same-directory
  temporary file, file sync, atomic rename and directory sync. A read failure is
  propagated and can never be reinterpreted as a missing record.
- A stale compare-and-swap commit returns
  `CODEX_CREDENTIAL_REVISION_CONFLICT`. Concurrent token refresh reloads and
  returns the winning revision rather than replaying a consumed refresh token.
- `fileCodexAuthStore()`, `CodexAuthStore`, `codexNodeAdapter()` and
  `codexNodePlugin()` retain the prior marker-free behavior with explicit
  deprecation documentation.
- The `@ai-agent-sdk/auth-node` root and `/env` emitted modules contain only the
  environment entrypoint. Provider Codex is an optional peer and is imported
  only through `/codex`.

Credential observations retain operation metadata only. Tests scan the emitted
credential events and confirm that access, ID and refresh tokens, account IDs
and filesystem locations are absent.

## Verification

- Focused credential/provider matrix: 39 tests passed across auth-node, Codex and
  all three official preferred provider factories.
- `@ai-agent-sdk/auth-node` strict typecheck and ESM build passed. Its root and
  `/env` output are 0.12 kB entry modules and contain no Node builtin or
  `provider-codex` import.
- The real-declaration Node auth/harness consumer compile passed using
  `tsconfig.current-node-auth-capabilities.json` without workspace source paths.
- The packed env-only fixture installed only packed core plus auth-node, asserted
  that `@ai-agent-sdk/provider-codex` was absent, and exercised both root and
  `/env` identities. The separate packed Codex closure exercised legacy
  read/write, revisioned create/CAS/stale rejection, preferred runtime creation
  and the built CLI status command.
- No registry publish step was run.
