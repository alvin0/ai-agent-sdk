# Human-test architecture and implementation ledger

Status: active implementation and release-gate design. Publishing to npm is
explicitly out of scope until the owner configures the registry.

## Purpose

Human tests must represent how customers compose the SDK, not only isolated
unit APIs. The suite therefore spans the universal/web-standard base, additive
Node capabilities, provider plugins, long-running harnesses, skills, MCP, A2A,
observability, usage accounting, cancellation, and failure recovery.

## Runtime rule

`@ai-agent-sdk/core`, universal agent behavior, HTTP provider contracts, and
universal MCP/observability contracts remain web-standard. Adding a Node package
such as filesystem skills, stdio MCP, credential stores, or Node exporters
elevates that application to Node without duplicating the core. Customer code can
therefore start universal and add Node packages while keeping shared identities
and lifecycle semantics.

## Evidence contract

Every command in `test-human/coverage.json` declares its customer journey,
runtime, network requirement, README, and artifact format. `pnpm check:human`
fails if a new `human:*` script is not declared.

New and updated interactive harnesses use a common bounded recorder:

- `summary.json`: status, environment, duration, invariants, metrics, checksum.
- `events.jsonl`: ordered lifecycle evidence suitable for support diagnosis.
- secret-shaped fields are redacted before buffering.
- prompt, message, content, stdout/stderr, and raw arguments are fingerprinted,
  not stored verbatim.
- record/byte ceilings report dropped evidence instead of growing unbounded.
- failed, aborted, and dry-run executions also produce artifacts.

Exact provider request bodies are deliberately separate behind `--logs`; these
are high-risk wire logs and are not the default support artifact.

## Coverage layers

1. Fast unit/contract tests validate deterministic state machines and public
   contracts.
2. `human:sdk-stress --profile complex` composes customer journeys offline on
   every substantial change.
3. `--profile stress` increases concurrency, randomized partitions, and lifecycle
   churn with deterministic seeds.
4. `--profile soak` is a release gate for resource leaks and rare ordering bugs.
5. Live-provider, remote GitHub MCP, A2A, and coding harnesses validate external
   systems and generate the same support evidence where practical.

## Implemented stress journeys

- streamed text/tool assembly with authoritative block closure and max-token
  partial-tool safety;
- parallel multi-turn agents with tool failures, trace closure, durable memory,
  and explicitly non-authoritative missing usage;
- transactional provider plugin rollback/dispose and retry recovery;
- observability queue pressure, privacy-before-export, batching, health, and
  best-effort exporter failure containment;
- high-cardinality filesystem skill discovery, lazy activation/resources, hot
  edits, abort, and symlink escape rejection;
- repeated real MCP initialize/list/call/close cycles with concurrent successes
  and remote failures.

## Implementation ledger

- [x] Shared support-safe artifact recorder.
- [x] Machine-enforced human-command coverage ledger.
- [x] Complex/stress/soak profiles with reproducible case seeds.
- [x] Artifacts for standard chat/media, AgentCode, local MCP, and GitHub MCP.
- [x] Existing A2A, skill stress, multi-skill, and showcase evidence declared.
- [x] MCP failure provenance regression fixed and covered by unit tests.
- [x] Run the complete stress profile and fix every reproduced finding.
- [x] Run the soak profile and inspect resource/ordering evidence.
- [x] Complete full unit, contract, package, runtime-boundary, and documentation
  gates after stress fixes settle.

## Verification evidence — 2026-09-01

- complex repeat-two: 12/12 cases passed, 640 weighted iterations;
- stress: 6/6 cases passed, 2,560 weighted iterations;
- soak: 6/6 cases passed, 20,480 weighted iterations in 19.7 seconds, with no
  artifact record drops;
- unit: 625 tests across 55 files passed;
- contract: 13 tests passed;
- all 20 workspace package test projects passed;
- package graph, dependency graph, agent/runtime boundaries, supply chain,
  release docs, TypeScript build/typecheck, and human coverage passed with zero
  findings.

The pressure runs found and fixed three non-cosmetic defects: MCP error results
lost integration provenance, artifact redaction hid token-usage metrics, and
bundled human CLIs derived fixture/report paths from their emitted module
location instead of the workspace root. Each now has a regression gate.
