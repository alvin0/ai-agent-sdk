# @ai-agent-sdk/skill-filesystem

Lazy Node filesystem discovery and activation for `SKILL.md` bundles.

```ts
import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'
```

The package is Node-only. Add the returned provider to an agent's `skills` list;
skill bodies and resources are read lazily with bounded filesystem operations.
