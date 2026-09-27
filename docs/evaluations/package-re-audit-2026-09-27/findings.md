# Package upgrade re-audit — 2026-09-27

The re-audit found one confirmed typing defect in the upgraded core packed-test runner and corrected it. No additional production runtime defect was reproduced in the upgraded SDK paths. This is bounded local evidence, not a claim that every package, model, or deployment is bug-free.

## Confirmed defect and fix

`packages/core/scripts/test-packed.mts` checked `result.optimization.fused/packed/verified`, but its result type did not declare `optimization`. A focused compiler invocation reproduced three TS2339 errors from this single missing field. The result type now declares the optional object and its three unknown-valued fields; runtime assertions still require each value to be exactly `true`.

The normal root typecheck covers root scripts/tests, while core's typecheck includes `src/**/*.ts`; neither includes this package-owned `.mts` runner. Node's type stripping allowed the runner to execute successfully despite the typing defect. Consequently, the previous green runtime and ordinary typecheck results did not establish that this runner typechecked.

The focused strict compiler check now passes:

```sh
pnpm exec tsc --ignoreConfig --strict --noEmit --skipLibCheck \
  --target es2023 --module nodenext --moduleResolution nodenext --types node \
  packages/core/scripts/test-packed.mts
```

Before/after diagnostics are retained under `checks/packed-runner-typecheck-{before,after}.log`. This turn changed the runner type declaration only; no production SDK implementation or package manifest was changed.

## Package scope and edge coverage

Against the current HEAD, all 19 changed package files are under `packages/core`. Production source/manifests in the other 25 packages are unchanged. `report.json` records the HEAD and SHA256 of the changed package files. Public export/type resolution, dependency boundaries and downstream runtime identity were exercised through the full root suite, package suites and installed tarball consumers.

Source review and executable regressions covered:

- Fusion: normal child policy/approval/budget/checkpoint paths, missing grants, denied or failed edits, rejected validation, retained completed receipts, synchronous callback contracts and consumed asynchronous rejections.
- Context projection: queued and late steering, shared frozen hook decisions across concurrent sessions, history replacement, preservation of application redactions/prepends, balanced tool pairs and raw snapshot retention.
- Optimizer lifetime: one controller per session, concurrent preparation rejection, pending save/read/archive/reducer disposal, cooperative hook deadlines and bounded teardown.
- Observation packing: strict byte thresholds, full output on the first two prepared requests, failed checkpoints, store failure/expiry/capacity, failure evidence beyond previews, Unicode code-point paging and lone surrogates.
- Milestones: ROI after observation packing, archive-before-projection, future/overlapping boundaries, initial request/app state retention, redaction and regular compaction invalidation.
- Evidence reduction: authoritative status and required-line capture before asynchronous callbacks, exact original line reconstruction, malformed/reordered/duplicate/missing proposals, unrecognized log formats and safe raw fallback.

These checks do not replace the documented integration requirements: optimization remains opt-in, controllers/stores must be scoped to their session, host callbacks must honor cancellation, milestone summaries are host-verified, and the application mounts the retrieval tool and fusion grant.

## Current validation

| Gate | Result | Evidence |
| --- | --- | --- |
| Workspace build + CLI build | Passed | `checks/build.log`, `checks/build-cli-final.log` |
| Root + workspace typecheck | Passed; 38 successful Turbo tasks including dependency builds | `checks/typecheck.log` |
| Full root suite on CI's Node 22.18.0 | 3,172 tests / 246 files passed | `checks/root-tests-final.log` |
| 25 package Vitest suites on Node 22.18.0 | 1,754 tests / 117 files passed | `checks/package-tests.log` |
| Remaining package, observability-browser, on Node 22.18.0 | Real Chromium recovery test passed | `checks/observability-browser-test.log` |
| 26 packages: publint, export/type resolution and packed fixtures | Passed on Node 24.9.0; runtime matrices as defined by each package | `checks/packed.log` |
| Changed core tarball on CI's Node 22.18.0 | Node, standards, types, Chromium and workerd passed | `checks/core-packed-node22.log` |
| Portable native no-follow | Node 22.18.0, Deno 2.9.6, Chromium and workerd passed | `checks/no-follow-final.log` |
| Graph/runtime boundaries and invalid-boundary fixtures | Passed; seven invalid workspaces rejected | `checks/static.log` |
| Supply-chain integrity/licenses + release docs | Passed | `checks/static.log` |
| Human-command artifact declarations | Passed, 23 commands | `checks/human-typecheck.log` |
| Fresh tarball contents | 26 checked; no dev-build/.env/node_modules paths, no matches for known root credential values | `checks/tarball-verification.json` |

Package suite counts overlap the root suite and must not be added to it. Browser/Worker checks use actual local runtimes; provider fixture HTTP is controlled. No live provider or hosted Edge deployment was rerun in this turn. The complete 26-package packed matrix used Node 24.9.0, so it is not a full reproduction of hosted Linux CI; core and functional/package suites were additionally tested on CI's Node version.

One initial root-test attempt was invalidated because `workspace:typecheck` rebuilt dependency `dist` files concurrently, causing transient import failures and load-related timeouts. It was stopped and excluded from acceptance. Builds were completed before the successful bounded-worker rerun. The portable gate initially lacked Deno; Deno was supplied from a tool cache before its successful rerun. No workspace dependency or lockfile was changed for either correction.

## Remaining issues outside the new package fix

The [sample harness audit](../sample-harness-audit-2026-09-27/findings.md) still records strict Team Auto output failures: the final Edge production harness was 7/8 on gpt-4.1-mini. SDK lifecycle success does not establish model output correctness. Those live sample failures were not rerun or declared resolved here.

The index still contains 735 generated `.next-harness-audit` files. Four staged Turbopack cache files match known root credential values. This was rechecked without printing any credentials. The previous cleanup confirmation remains pending; these directories were left intact. They must not be committed. The ignore rules do not remove already-staged files. Fresh package tarballs did not contain these directories or known root credential values; this limited check is not a general secret scanner.

`checks/worktree-verification.json` confirms that the index metadata hash is unchanged from the start of this turn. Nothing was staged, committed, pushed, or published. Existing staged source and caches were preserved.
