---
"@ai-agent-sdk/core": patch
---

`ManagedAgentTeam.steer(text)` makes sure something reads what the user typed.

Injection alone is enough only while the lead is mid-turn: its next model round
rebuilds the request from history and picks the message up. Once the lead has
answered and is only waiting on its workers, an injected message sits in history
with nothing scheduled to read it — so a user who typed a correction while the
researchers were still running never got an answer to it.

`steer` injects and, when the lead is idle, schedules one turn for it. Hosts
that route a mid-run message straight to `AgentSession.inject` should call this
instead when the session belongs to a managed team.
