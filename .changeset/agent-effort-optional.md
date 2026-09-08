---
"@ai-agent-sdk/core": minor
---

`defineAgent` no longer invents a reasoning effort.

`effort` defaulted to `medium`, so every defined agent claimed a preference its
author never expressed. Two consequences, both real: the value is validated
against the model's own ladder, so such an agent could not run at all on a
provider that declares no efforts — and everywhere else it silently overrode
whatever default the provider would have chosen.

This is what pushed the chat-agents sample to run its single-agent modes on the
bare loop rather than on a session, because the loop can omit the field. That
cost those modes everything a session carries — compaction most of all — for a
default nobody had asked for.

Omitted now means omitted: the field is absent from the call config, and the
provider applies its own default. An agent that wants a level still sets one,
and an explicit level a model does not offer is still rejected rather than
quietly dropped.
