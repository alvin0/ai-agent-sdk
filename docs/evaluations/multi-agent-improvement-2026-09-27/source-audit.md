# Source audit scope

SDK baseline: HEAD 5b589b6abe6d0a61da3f55b549713456ccc8c7c4 plus the previously
validated production/sample patch 055229ab7ad31aecb71d09a0a5908462db728e28bca545b3ed4caf98b1eb3200.
Live baseline is the prepared previous-goal candidate SDK, not pristine HEAD.

Read local upstream checkouts, without executing or changing them:

- Hermes 9fc7f17906eab1dd81ddfdf8a1edeecac1e79940:
  tools/delegate_tool_dispatch.py, tools/delegate_tool_results.py,
  tools/delegate_tool_registry.py. Used early producer-owned completion records,
  exact live-child identity/ownership, bounded head/tail report presentation with
  full evidence recovery. Did not import its application registry/runtime.
- OpenClaw 37259b7cab6b1816211d381200848048a05f197d:
  subagent-spawn-lifecycle.ts, subagent-spawn-ownership.ts,
  subagent-completion-result.ts, subagent-spawn-plan.ts,
  subagent-spawn.preparation-authority.test.ts. Used post-await owner revalidation,
  separation of address/controller/completion producer, and terminal result truth.
  This is selected mechanism research, not a complete upstream security audit.

SDK call paths inspected with CodeGraph and narrow current source reads:

- lead controlTools.spawn_agent -> ManagedAgentTeam.spawn -> workerDefinition /
  workerSessionOptionsFactory -> forkLeadHistory -> createSession / team.attach ->
  required task/dependency delivery -> beginWorker -> AgentSession.runPending ->
  followWorker -> recordOutcome / notifyLead -> markSettled / releaseDependents.
- closeWorker -> controller.abort + AgentTeam.cancel -> bounded settlement ->
  exact-instance detach/release; dispose -> owner lifecycle + preparations/close.
- host wait -> awaitWorker / whenQuiet; lead onTurnEnd -> automatic worker-news
  hold; steer -> history injection + explicit/automatic wait interruption.
- AgentTeam wake scheduler -> runWakeLoop -> structural terminal response status;
  DefinedAgent and composed runtime session ports remain independent of concrete
  team implementation. Existing package/agent/runtime graph checks pass.

29 public-entrypoint controlled cases compare the same original baseline with
final v8. Test additions are audit-driven, author-exposed regression cases. New
full-read scope is only the worker's commissioned producer records. Detached
records preserve full text without retaining producer sessions/ancestor chains.

Known boundaries: declarations do not authorize or sandbox filesystem writes;
future/preparing dependencies remain unsupported; summaries are bounded, combined
handoff over a custom message cap fails visibly; ignored cancellation cannot be
forcibly terminated; reports are in-memory, not restart-durable. Per-session
limits and existing accounting tests do not establish a global workflow budget.

Index changed externally to an intermediate snapshot during the audit. The agent
never called git add/stage/commit/reset/stash. The final source used by benchmark
is the frozen working-tree v8 patch; do not claim cached v4 passed final gates.

Final SDK-neutrality pass: helper protocol guidance no longer prescribes task strategy. Host controls automatic lead coordination, worker team tool access and optional textual-result requirements. Final frozen v10, 33/33 public cases, 144-attempt provider cohort and separate native acceptance are reported in findings.md. Staged source remains intermediate v4.
