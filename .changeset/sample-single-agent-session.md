---
"@ai-agent-sdk/core": patch
---

Records what the chat-agents sample found while testing its own modes, and what
changed there.

- **Single-agent modes had no compaction at all.** The sample ran `basic`,
  `deep`, and `deep-human-in-loop` on the bounded loop, which carries no
  compactor, so a long conversation grew until the provider refused it. Only the
  team modes — which run on sessions — were ever condensed. They now all run on
  a session, which is possible because `defineAgent` no longer forces a
  reasoning effort.
- **A second prompt ran beside the first.** Two runs on one conversation share
  its history and its transcript counter, so both alive means two dialogues
  spliced into one. A new prompt now ends the previous run first.
- **Stopping was reported as a failure.** A run the user cancelled, or one the
  next prompt replaced, wrote a red error into the transcript. Both are now
  notices: neither is something that went wrong.
- **A correction typed at the wrong moment was never read.** Steering appends to
  history and schedules nothing: the next model round picks it up, and a run
  that ends before there is a next round leaves it sitting there. The run now
  continues for one more turn when the message arrived after the last round —
  the same rule the managed team already applies to a lead that has gone idle.
- **A reload lost an open question.** A waiting permission prompt survived a
  reload because the API hands the live ones back; an open `request_user_input`
  question returned only a COUNT, which cannot be rendered into the card the
  user has to answer — so the run stayed parked on an answer nobody could give.
  The API now returns the questions themselves and the client re-renders them.
