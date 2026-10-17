# Combined direction offline evidence

`offline/` contains the final scaled fake-adapter run: all six tasks, single/team/collab,
one repetition per pair (18/18 completed with passing graders, complete synthetic usage,
zero failures/timeouts/cap hits). `manifest.json` records the seed, limits and SDK/harness hashes.

Command: `node test-human/multi-agent-bench/run.ts --provider fake --suite scaled --arms single,team,collab --reps 1 --concurrency 2 --label combined-offline-final --out docs/evaluations/multi-agent-upgrade-2026-10/combined/offline`.

`surfaces.json` records verbatim model system prompts and tool catalogs with character counts
for baseline, combined lean, combined legacy, and opt-in collaboration. Baseline was built from
an archive of `multiple-agent-upgrade` at 09684a9 in /tmp, without changing another worktree.
Same fixed ids, instructions, reporting access, no roles and no application tools in every capture.

These are synthetic protocol checks and character measurements, not live quality/performance evidence.
Reviewer must run matched live N>=3 cohorts with gpt-6-luna or a newer explicitly selected model.
Changing the fake address reader to recognize lean `target` results changes the harness hash;
copy identical harness bytes into both live comparison cohorts as required by the benchmark contract.
