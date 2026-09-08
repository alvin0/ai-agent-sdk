---
"@ai-agent-sdk/core": patch
---

`ManagedAgentTeam.whenQuiet()` answers the question the roster cannot: is there
still work coming?

A worker's last event fires before its run resolves, and the completion report
that wakes the lead is delivered after that. For the moment in between, every
member on the roster looks idle. A host that watches the roster to decide how
long to keep listening stops in exactly that gap — one instant before the
synthesis it was waiting for — and the conversation ends on a worker's own
output.

`whenQuiet(signal?)` waits for every outstanding worker to settle, which happens
only after its report has been delivered, and then for the lead to be idle. A
host re-checks the roster after it resolves and can stop with confidence.
