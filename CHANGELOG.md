# Changelog

All notable changes to the AI Agent SDK are documented in this file.

## 0.1.3 - 2026-09-15

### Added

- Added `@alvin0/ai-agent-sdk-sandbox`, a Universal package holding the sandbox contract: the file-effect mode vocabulary, per-call policy resolution, the ordered writable-root algebra both enforcement layers share, exec classification, minted escalation approvals, and the rules that keep a broken sandbox from reading as a denied command.
- Added `@alvin0/ai-agent-sdk-sandbox-node`, the Node enforcement half: bubblewrap and Seatbelt process confinement, an in-process path fence, credential-safe spawn options, process teardown, resource supervision, backend probing, and a dependency doctor.
- Added network reach as a policy axis of its own (`deny`, `loopback`, `allow-all`), enforced by a network namespace on Linux and `(deny network*)` on macOS, and reported separately from the file mode.
- Added `classifyExec`, which reads what a command does — including inside a shell string, a pipeline, or a chain — and maps it to `allow`, `allow-scoped`, `ask-approval`, or `deny` before any enforcement runs.
- Added a read allow-list baseline (`baseline: 'deny'`) enforced by the fence, `openConfinedWrite`/`writeConfinedFile` for check-and-open in a single step, and `superviseConfined` for sampled wall-clock, memory, process, and CPU limits.
- Added English and Vietnamese sandbox documentation, an agent-skill reference, a differential policy fuzzer, and a cross-platform acceptance suite with its own CI workflow.

### Changed

- Documented how the sandbox composes with the agent loop: a `ToolInterceptor` turns a classification into `allow`/`deny`/`ask`, the session's approval broker answers `ask`, the interceptor mints the escalation once a person has answered, and the tool body resolves the policy and confines or fences. Covered in the sandbox guide (English and Vietnamese), the package README, and the agent skill.

### Compatibility

- Both sandbox packages are new at `0.1.3` and change no existing API. Neither depends on `@alvin0/ai-agent-sdk-core`, so they are opt-in and add no dependency to an application that does not install them.
- `SandboxMode` governs file effects only. Network and resources are separate policy fields, and `confine()` reports `full`, `partial`, or `fence-only` enforcement rather than implying it.
- A policy request may only narrow authority. Widening requires an approval minted by `approveSandboxEscalation`, which is spent on first use unless given `scope: 'session'`; parsed JSON is refused.
- There is no Win32 confinement backend: `confine()` fails closed with `SANDBOX_UNAVAILABLE` on Windows, while the in-process fence still applies on every platform.
- Resource limits are sampled, not quota-enforced; a hostile swap of a directory component defeats a check-then-write, and `confine()` refuses `baseline: 'deny'` rather than pretending to enforce it. Each limit is documented where it is measured.

### Release scope

- All 26 workspace SDK packages, root metadata, and `SDK_VERSION` move from `0.1.2` to `0.1.3` to satisfy the existing lockstep release workflow. The private testkit remains unpublished.
- `@alvin0/ai-agent-sdk-sandbox` and `@alvin0/ai-agent-sdk-sandbox-node` are published for the first time at `0.1.3`. Every other package receives the lockstep version update with no behavioral change.

## 0.1.2 - 2026-09-13

### Added

- OpenAI, Anthropic, and Gemini generation adapters/plugins now accept custom endpoint `headers` as a record or synchronous resolver, and `allowInsecureHttp` for explicitly trusted local gateways.
- OpenAI and Gemini embedding adapters/plugins now accept custom headers. Prepared embedding calls retain one header snapshot across all batches.
- Added `getCodexTokens(store, options)` for store-backed token reads with optional automatic refresh, and `getCopilotToken(store, options)` for API-token acquisition with an application-owned cache and explicit invalidation. Both helpers are also re-exported by their Node auth entry points.
- Added a working SQLite credential-store example with tenant scoping, atomic revision checks, and tests for database persistence, refresh, and runtime integration.
- Added English and Vietnamese guidance for compatible gateways and database-owned credentials.

### Fixed

- Preserve the stored Codex account identity when a refresh response omits `id_token`.
- Reject malformed Codex refresh payloads and empty or non-string token fields before committing credentials.
- Honor cancellation while waiting for database reads or a custom Copilot token cache, including hooks that ignore their signal; observe late promise rejections after cancellation.
- Reject empty tenant scopes and unknown provider values in the SQLite example.

### Compatibility

- Custom headers preserve case-insensitive ownership checks: reserved authentication, protocol, transport, and SDK headers cannot be silently overwritten. Credentials remain configured through the provider's auth options.
- Gateway compatibility still requires the matching wire protocol: Responses for OpenAI generation, Messages for Anthropic, and Interactions for Gemini.
- Filesystem storage remains only a Node-wrapper default. Database stores use the existing `read`/`commit` contract; Copilot API-token caching can use custom `acquire`/`invalidate` hooks.
- Codex refresh tokens rotate. Applications must coordinate concurrent refreshers across workers with an account-level lock or shared auth service; revision checks alone do not serialize OAuth requests.

### Release scope

- All 24 workspace SDK packages, root metadata, and `SDK_VERSION` move from `0.1.1` to `0.1.2` to satisfy the existing lockstep release workflow. The private testkit remains unpublished.
- Behavioral/API changes are in `provider-http`, `provider-openai`, `provider-anthropic`, `provider-gemini`, `provider-codex`, `provider-copilot`, and `auth-node`; core also updates SDK version attribution. Other packages receive the lockstep version update.

## 0.1.1 - 2026-09-13

### Added

- Added document input support across the core message contract and the Anthropic Messages, Gemini Interactions, OpenAI Responses, OpenAI Chat Completions, and Codex provider paths, with strict validation and projection rules.
- Added the public embedding API and composition runtime, including model catalogs, request validation, batching, limits, retries, caching, usage accounting, lifecycle observations, and provider conformance tests.
- Added OpenAI and Gemini embedding adapters, including configurable model capabilities and compatibility identities.
- Added `@alvin0/ai-agent-sdk-provider-copilot` with GitHub device-flow authentication, token persistence, model discovery, generation, embeddings, and Node CLI support.
- Added `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` with serialization and streaming translation for text, tools, terminal states, truncation, and usage.
- Added per-invocation model overrides for agent runs.

### Changed

- Reworked `@alvin0/ai-agent-sdk-provider-http` around shared connection, session, JSON, and streaming transport primitives with bounded redirects, timeouts, abort handling, media-type validation, and credential-safe observations.
- Extended provider and testkit contracts to cover embedding and Copilot conformance, generation-oracle fixtures, and SSE/JSON transport equivalence.
- Updated the approved Anthropic SSE oracle for cumulative `usage-progress` snapshots and made main-branch releases gated, lockstep-checked, and safe to retry when a package version is already present on npm.
- Improved provider documentation and model limit guidance in English and Vietnamese.

### Release scope

- All workspace SDK packages move from `0.1.0` to `0.1.1` so the lockstep release workflow can publish a complete, internally compatible package set.
- `@alvin0/ai-agent-sdk-provider-copilot` and `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` are published for the first time at `0.1.1`.
- `@alvin0/ai-agent-sdk-testkit` remains private but carries the same workspace version.

## 0.1.0 - 2026-09-09

- Initial public release of the capability-based AI Agent SDK packages.
