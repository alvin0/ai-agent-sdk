---
"@ai-agent-sdk/core": patch
---

`wait_agents` now ends early when the user says something.

A lead parked in `wait_agents` is not listening to its own conversation. A
correction typed while it waits lands in history and sits there for the rest of
the wait budget — up to thirty seconds of the user watching an agent work on
the thing they just corrected. Codex documents the same behaviour on its own
wait: "the wait also ends early when new user input is steered into the active
turn".

- `AgentTeam.notifySteer(name)` ends whatever that member is waiting on.
- `ManagedAgentTeam.steer(text)` calls it, so a mid-run message reaches the lead
  immediately whether it is idle or parked in a wait.
- The wait returns `interrupted: true` rather than a timeout, and its tool
  description tells the model to read what arrived before waiting again.
