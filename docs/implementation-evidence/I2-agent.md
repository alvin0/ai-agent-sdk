# I2 — Agent ownership and domain refactor

Status: I2 verified on 2026-09-04; I3–I8 and real-provider acceptance remain open.

## Source state

- All 49 frozen agent source paths now exist under `packages/core/src/agent`.
  Twenty additional domain-local modules separate session contracts/configuration/
  restoration, history validation, accounting usage, team helpers and turn processing.
- `packages/agent/src` contains exactly two re-export-only bridges: its root and
  `skill/validation-export.ts`. No old implementation copy remains.
- Core exports canonical `./agent` and `./skills` entries. At I2, `./skills`
  preserves the two existing validation exports; the full target author API and
  curated root are still I3 work. This is not the finished package architecture.
- All former self-package references, including the `AgentMessageSource` type
  re-export, now point inward. The source boundary checker inspects the new owner.
- Five previously oversized files were reduced without removing their baseline
  paths: ledger 753 → 597, session 1018 → 675, history 748 → 186, run-turn
  1201 → 347, team 720 → 580 lines. All 69 resulting agent files are ≤675 lines.
  The moved-source contract gate also rejects any agent/observability file above
  the 700-line implementation limit.
- Helpers remain grouped by domain. Turn bounds and session/history limits have
  local configuration modules; usage aggregation has one owner; model rounds and
  turn orchestration share content, cancellation and hook helpers. Skill restore
  clears pending state at the same point relative to accounting completion as before.
- Private-source test imports and three documentation links follow the moved
  files. Core's package test command now includes its agent and observability tests.

## API evidence

- The frozen pre-migration API hashes and I1 snapshot remain unchanged.
- `implementation-api-I2.json` records ten emitted declaration files, all four
  baseline source routes and both moved ownership states. All 417 baseline export
  occurrences match; original-to-current hash links remain checked.
- A runtime identity test compares every legacy agent export with core's agent
  entrypoint, including constructors and constants. It checks both the key set and
  each value's identity, rather than just structural compatibility.
- `AgentMessageSource` in core and agent imports the same renamed binding from the
  same emitted declaration chunk. Five tests cover that identity check, including
  different bindings/owners, copied declarations, missing and ambiguous imports.
- Six migration snapshot tests cover current/original hashes, sidecar inventory,
  I2 selection, missing I2 evidence and stale ownership. Existing current-versus-
  target API compatibility fixtures compile against canonical emitted declarations.

## Verification log

Commands use the workspace's configured Node/pnpm runtime. Clean builds completed
before any dependent tests; no tests read `dist` during a clean build.

- `pnpm build`: all 20 packages passed, including a final rebuild after correcting
  the inward `AgentMessageSource` re-export.
- Core and agent `typecheck`: passed.
- Core package tests: 22 suites, 342 tests passed.
- Agent bridge package tests: 13 suites, 232 tests passed.
- Final `pnpm exec vitest run tests/unit`: 57 suites, 639 tests passed at 23:26 local.
- `pnpm build:cli`: passed. Targeted Edge Chat and Node Codex harness regression:
  two suites, seven tests passed, covering chat/tool/usage events and the local
  filesystem-skill/MCP-stdio/journal/resume journey.
- `pnpm check:graph`: 20 packages, 61 workspace edges; emitted dependency check
  68 modules/136 dependencies; agent boundary 12 groups/32 edges, zero findings.
- `pnpm check:core-graph`: acyclic, 13 groups/48 edges.
- `pnpm check:runtime-boundaries`: 13 Universal/Browser packages, 208 files, passed.
- `pnpm check:core-capability-contract`: passed, including exact moved-source
  inventories, both route-complete bridges, API snapshots and compatibility fixtures.
- `pnpm check:docs`: passed after the ledger/evidence update, 46 Markdown files
  and 20 package READMEs. `git diff --check` is included in the final gate rerun.

### Retained failures and corrections

- Initial typecheck found an unused `object` helper import after extraction;
  removed that import and reran typecheck successfully.
- Initial graph check found one remaining public-core type re-export in
  `team/types.ts`, producing a self-package dependency. Repointed it inward;
  rebuilt and passed the graph checks.
- Initial contract run found compatibility fixtures still aliasing `core/agent`
  to the old agent declaration, now a bridge back to that same alias. Updated six
  current-build fixture paths to the canonical core declaration.
- The next contract run rejected the old external-import collision pattern.
  Replaced that phase-specific check with a tested same-binding/same-owner check
  for moved sources; the original pre-move assertion remains for pending sources.
- Documentation check found three links to moved trace/turn files. Updated the
  links to their actual core paths and reran successfully.

## Limits of this evidence

The two human harness suites use scripted providers. They do not establish live
Codex behavior, browser/workerd execution, autonomous research or semantic report
quality. Their temporary workspaces are cleaned by the tests, not delivered as
user application artifacts. Real-provider tests with persistent inspectable
artifacts remain required by the full implementation goal.

The contract gate still reports exactly two unresolved upstream MCP `Buffer`
declaration errors for full-Web compilation. Base-Web and NodeNext pass, but this
is not a full Edge acceptance pass. No npm publication was attempted.

Follow-up found during I3: full-root test-source typechecking exposed mixed
source/emitted imports in `team.spec.ts` and `run-ledger.spec.ts`. They were
corrected to use one source owner; see the retained failure and passing root
typecheck in [I3 progress evidence](./I3-provider-foundation.md). The original
I2 package-level typecheck/test results above remain historical results, not a
claim that the broader root typecheck was run at that time.
