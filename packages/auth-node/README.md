# @ai-agent-sdk/auth-node

Node-owned environment credentials and project-local Codex OAuth storage.

```ts
import { envCredential } from '@ai-agent-sdk/auth-node/env'
import { codexNodePlugin } from '@ai-agent-sdk/auth-node/codex'
```

Codex defaults to `.providers/.codex/auth.json` below `process.cwd()` and never
uses the Codex CLI's global credential file. Writes use a private directory,
unique same-directory temporary file, file sync, atomic rename, mode `0600`, and
directory sync. Credential-file symlinks are rejected.

Run `ai-agent-sdk-codex-login` after installation to authenticate this project.
