# Chat sample harness audit — 2026-09-27

Both samples were exercised through their actual Next HTTP routes, real providers, workspace tools and browser UI. The test state used a disposable SQLite database/workspace on ports 3367 and 3368. Existing application data was untouched. Production builds also served real-provider requests. This is local evidence, not a hosted Edge deployment acceptance result.

## Changes backed by regressions

- **Node cold-session admission:** parallel first requests previously hydrated different History objects, brokers and transcript counters. Hydration is now shared per conversation; forgetting a conversation invalidates its pending publication. Two regression tests failed before the fix and passed afterward.
- **Node steering:** consuming a queued UI `step-start` incorrectly acknowledged a correction not included in the already-prepared provider request. A lead-only request-preparation hook now acknowledges it. Worker requests cannot clear the lead's unread correction. The existing steering oracle caught the race during the complete sample rerun; related tests then passed.
- **Node numerical work:** a real worker mentally added a 50-row CSV incorrectly (3525 instead of 2715); the lead repeated it. The reporting instructions now require computational evidence for aggregation. Both S11 reruns passed with actual tool computation; the original failure is retained. This improves guidance and does not constitute a mathematical correctness guarantee for a model.
- **Edge admission:** construction/replacement/close serialize per credential-scoped slot. Pending construction counts against capacity. A response lease covers the period when a lead is idle but its response/workers are still active. Configuration changes during an active response return 409 instead of replacing the active runtime. Idle binding reuse now considers endpoint, host instructions and run limits.
- **Edge cancellation and terminals:** the incoming request signal and SSE body cancellation reach the SDK. The lease releases after the pump settles. Low-level Team Auto failed outcomes produce an error terminal, not a false `done`; failed lead follow-ups are checked too, and cancellation waits for worker cleanup. The deterministic provider-400 checks cover single/fixed/auto shapes; real single cancellation was verified through a closed trace and a subsequent request.
- **Edge trace projection:** successful single/fixed lead events were never observed by the trace store. Both saved and streamed spans now receive them. The credential test first failed with zero owner spans and now verifies a closed successful root plus live span frames. Browser Trace displays actual model/tool spans and usage.
- **Edge HTTPS tool:** every redirect destination is validated before dispatch; mapped/local IPv6, trailing-dot localhost, CGNAT and reserved IPv4 literals are refused. Reads respect the byte cap even for one oversized chunk, handle UTF-8 boundaries, and cancel blocked readers on abort. Thirteen tool tests found ten failures before the fixes. DNS rebinding and hosted platform egress restrictions are not established by these literal URL checks.
- **Edge independent workers:** the sample now defaults to `fresh`, matching the SDK default, and lets the model explicitly request `fork` for shared facts. A deterministic request-body test proves independent workers do not receive the entire prior chat. Switching that default back to `fork` makes the test fail: it copies both old task-memory and self-check context into worker requests. This avoids that context/token overhead; model output-format failures still remain below.
- **Browser theme:** the Edge inline theme bootstrap intentionally changes html/body before hydration. The narrowly scoped hydration flags follow the installed Next guide; reload no longer emits the mismatch. Missing favicon 404s were observed and remain outside this harness change.

## Validation and retained outcomes

| Check | Result | Evidence |
|---|---|---|
| Baseline sample tests | 377 tests / 27 files passed | `checks/baseline.txt` |
| Final complete unit suite | 3172 tests / 246 files passed | `checks/unit-final-all.txt` |
| Sample suite before last worker regression | 402 tests / 30 files passed | `checks/sample-final2-tests.txt` |
| Worker context regression | Failed with fork; 11 boundary tests passed with fresh | `checks/fresh-worker-before.txt`, `checks/fresh-worker-test.txt` |
| TypeScript | Passed | `checks/types-final7.txt` |
| Architecture lint | Package graph, dependency, team and runtime boundaries passed | `checks/lint.txt` |
| Production builds | Node and Edge passed | `checks/node-build.txt`, `checks/edge-build-fresh.txt` |
| Node real Codex 16 workflows | 15/16 initially; S11 failed real arithmetic oracle | `node-initial/` |
| Node S11 after computational guidance | Two independent reruns passed | `node-s11-repeat1/`, `node-s11-repeat2/` |
| Node actual approval identity | Allow, deny and abort passed; stale/provider-ID resolutions rejected | `feedback-live.json` |
| Node production chat + shell | 2/2 passed | `node-production/` |
| Edge final production full harness, gpt-4.1-mini | 7/8 passed; strict Team Auto output oracle failed | `edge-fresh-full/` |
| Edge strict Team Auto, gpt-4o-mini | Failed worker exact-output oracle on both turns; cleanup succeeded | `edge-fresh-strict/` |
| Browser | Real Node read receipt and both Trace dialogs verified | `browser/` |

The initial Edge runs are retained as diagnostics. Their first Team Auto oracle only checked worker lifecycle and lead output. The final oracle additionally checks each worker's actual terminal trace output against its distinct assigned phrase and runs both turns even when the first output mismatches. Initial Team Auto “passed” rows therefore do not prove correct worker answers. A startup attempt before the server became ready is also retained separately under `edge-auto-strict/`; it is not provider evidence.

Final `edge-fresh-full` passes actual clock/HTTPS, history across model switching, provider error plus recovery, credential isolation, a fixed worker's real result and disconnect plus reuse. Team Auto still sometimes adds a process report where an exact phrase was required, including a worker self-claim that an earlier exact response sufficed. No oracle was relaxed to make this pass. Earlier gpt-4o-mini recovery runs answered the previous task; request-body and trace evidence show the new user message was present. Recovery passes in the final gpt-4.1-mini production run, so reliability is model-dependent. Further model/prompt or structured-output work is needed before claiming strict output acceptance.

The production build reports the installed Next version's Edge-runtime deprecation warning. Node's filesystem sandbox also triggers Turbopack dynamic-filesystem tracing warnings. Neither build failed. Hosted isolate eviction, cross-isolate routing, platform execution deadlines, DNS-level egress safety and all provider/model combinations remain unverified.

## Worktree and cleanup

All test-owned servers have stopped. Production output directories were removed and the generator's own changes to next-env/tsconfig were restored in the working tree. Application state remains only in the disposable scratch directory. The agent did not stage, commit, push, reset or modify the index.

The index changed externally during the tests and includes 735 files from the newly created `.next-harness-audit` dev directories. Four Turbopack cache files contain known credential values from the root `.env` (both samples). No values are copied into this report. A question to remove only these generated directories from the index and disk is pending; they have been left intact to preserve staged work until answered. The new ignore entries prevent future additions but do not untrack already-staged files. Do not commit those cache directories. `checks/worktree-check.json` records only counts. The check was local; nothing was committed or pushed.

Raw provider/tool evidence was scanned for known root credential values and copied with replacement if needed. `source-sha256.json` records the tested source and harness. The saved red regressions remain separate from final passes.
