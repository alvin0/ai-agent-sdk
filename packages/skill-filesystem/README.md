# @alvin0/ai-agent-sdk-skill-filesystem

The package directly owns exact `yaml@2.9.0` for bounded, fail-closed parsing of
`agents/openai.yaml` invocation policy. Aliases and duplicate keys are rejected.

Runtime: **Node 22.12+**.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-skill-filesystem
```

Lazy Node filesystem discovery and activation for `SKILL.md` bundles.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { fileSystemSkillProviderPlugin } from '@alvin0/ai-agent-sdk-skill-filesystem'

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
