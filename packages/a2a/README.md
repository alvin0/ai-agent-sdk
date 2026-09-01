# @ai-agent-sdk/a2a

Runtime: **Node 22.12+**.

```sh
pnpm add @ai-agent-sdk/a2a
```

Node-elevated bridge between ai-agent-sdk agents/teams and the official A2A
client/server APIs.

```ts
import { createA2AAgentLink } from '@ai-agent-sdk/a2a/client'
import { createDefinedAgentA2AServer } from '@ai-agent-sdk/a2a/server'
```

This package is intentionally classified as Node. The official A2A 1.1.0 codec
uses `Buffer.from` for raw binary `Part` serialization. Text, structured data,
URLs, and binary values are supported in Node, but the package must not be
advertised for Edge/Worker runtimes until the committed negative promotion gate
passes without Node globals.

Authentication, endpoint policy, persistence, and HTTP framework adaptation
remain host-owned. Configure explicit origins, HTTPS/private-network policy,
resource bounds, session ownership, and deadlines for the deployment boundary.
