# I1 — Base observability ownership move

Status: I1 verified; not full runtime/Edge acceptance.

## Source state

- Seven implementation files moved from `packages/observability/src` to
  `packages/core/src/observability`; no copied implementation remains at the old owner.
- Six former public-core imports now reference inward primitives/observation modules.
- Core exposes `./observability` as a separate entrypoint; its root API is unchanged.
- The old package is a re-export-only bridge. One identity test compares all six
  runtime exports against the canonical core entrypoint.
- Product files in the moved group are 27–641 lines; the new migration-check helper
  and its tests are also below 700 lines.
- The original API baseline hashes remain untouched. `implementation-api-I1.json`
  separately freezes the emitted declaration closure after multi-entry chunking,
  with original-to-current links and source-state guards. Five negative/positive
  tests exercise the guard, including changed hashes, extra sidecars and stale state.

## Verification log

- Core build and typecheck: passed.
- Observability bridge build and typecheck: passed; emitted JS and declaration each re-export core.
- Core package tests: 8 files, 90 tests passed.
- Observability package tests: 1 file, 20 tests passed, including value identity.
- Package/dependency/source boundaries: passed (20 packages, 61 package edges;
  dependency-cruiser 64 modules/127 dependencies; agent graph 12 groups/32 edges).
- Runtime boundary scan: passed, 13 Universal/Browser packages and 179 files.
- Whole-workspace build: passed after the ownership move.
- First whole-unit attempt (2026-09-04 23:08 local): **failed**, 14 suites failed
  during import, 42 suites/465 tests passed. The agent incorrectly scheduled it
  concurrently with the clean whole-workspace build. Errors were unresolved core,
  agent and other package entrypoints while their `dist` outputs were being rebuilt.
  This is retained as an orchestration failure, not dismissed as an SDK pass.
  Corrective action: serialize clean builds before all tests reading their outputs.
- Sequential whole-unit rerun: **passed**, 56 suites and 632 tests on 2026-09-04
  at 23:10 local. No clean build was running during this attempt.
- Contract check after the whole-workspace build and evidence-policy update:
  passed, including frozen original API baselines, I1 declaration snapshot,
  exact source ownership and bridge assertions. The two pre-existing MCP Web
  declaration errors remain separately tracked, not waived as a full Edge pass.
- Documentation check: passed, 45 Markdown files and 20 package READMEs.
- Public API/contract test suite: passed, 2 files and 13 tests.

No live provider or human application result is claimed by I1. Those acceptance
tasks remain in the full implementation ledger and are now owner-authorized to
run separately with bounded usage and inspectable artifacts.
