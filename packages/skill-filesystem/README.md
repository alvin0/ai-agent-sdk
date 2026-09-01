# @ai-agent-sdk/skill-filesystem

Runtime: **Node 22.12+**.

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/agent @ai-agent-sdk/skill-filesystem
```

Lazy Node filesystem discovery and activation for `SKILL.md` bundles.

```ts
import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'
```

The package is Node-only. Add the returned provider to an agent's `skills` list;
skill bodies and resources are read lazily with bounded filesystem operations.
