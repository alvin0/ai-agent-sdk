# @ai-agent-sdk/skill-filesystem

Runtime: **Node 22.12+**.

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/skill-filesystem
```

Lazy Node filesystem discovery and activation for `SKILL.md` bundles.

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { fileSystemSkillProviderPlugin } from '@ai-agent-sdk/skill-filesystem'

const skills = fileSystemSkillProviderPlugin({ roots: ['./skills'] })
const runtime = await createAgentRuntime({ providers: [modelProvider] })
const agent = runtime.agent({
  id: 'coding-agent',
  instructions: 'Use the available skills when relevant.',
  skills: [skills],
})
```

The package is Node-only. The returned versioned provider is borrowed by the
runtime: creating it performs no filesystem I/O, skill metadata is discovered at
the start of a run, and bodies/resources are loaded lazily with bounded reads.
Close the runtime; the provider itself has no owned resource to close.

`fileSystemSkills()` remains the marker-free advanced compatibility API.

Composition: `runtime-agent.skills`. Lifecycle: `borrowed-caller-owned`; the
provider stays lazy and the runtime never invents an independent close action.
