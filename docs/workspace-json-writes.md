# Workspace JSON writes

The SDK leaves filesystem access with the host. Core exports the portable
`validateJsonFileContent(path, content, options?)` hook and `JsonWriteGuardOptions`
from `@alvin0/ai-agent-sdk-core/tools` (also `/agent`). It performs no I/O.
Call it on the **complete proposed file content**, after authorization and size checks,
before creating directories, opening/truncating a file, or committing a patch.

```ts
import { validateJsonFileContent, type JsonWriteGuardOptions }
  from '@alvin0/ai-agent-sdk-core/tools'

function writeArtifact(path: string, content: string, options: JsonWriteGuardOptions = {}) {
  validateJsonFileContent(path, content, options)
  return hostWrite(path, content) // host-owned authorization, path checks and storage
}
```

Validation defaults to **on** for paths ending in `.json`, case-insensitively.
`JSON.parse` determines validity: objects, arrays and JSON primitives are accepted;
empty, whitespace-only, incomplete, commented and trailing-comma JSON are rejected.
One leading U+FEFF (UTF-8 BOM) is ignored for validation only. Accepted text is
written byte-for-byte without formatting, normalization or BOM removal.
Other suffixes, including `.jsonc` and `.json5`, are unvalidated.

Failures throw a recoverable `ToolError` with code `INVALID_ARGUMENTS`. Normal tool
dispatch returns an error to the model so it can correct and retry. The message
includes the target path, the native parse reason (bounded to 160 characters),
one-based line/column and a JSON-escaped excerpt of up to 80 source characters.
Columns count UTF-16 code units, including any BOM, matching JavaScript offsets.
Native error offsets are used where available; a diagnostic scanner otherwise
locates the offending token. Content is not written on validation failure.
There is no semantic/schema validation or automatic JSON repair.

The repository's existing host tools apply this hook by default:

| Host | Guarded operations | Opt-out |
| --- | --- | --- |
| Chat sample | `write_file`, `edit_file` | `createSampleTools(root, { validateJsonWrites: false })` |
| Agentcode | `write_file`, `replace_in_file` | `createAgentCodeToolRegistry(root, { validateJsonWrites: false })` |
| Benchmark workspace | `write_file`, `edit_file` (entire replacement batch) | `Workspace.create(task, parent, { validateJsonWrites: false })` |

Existing calls remain valid. The host opt-out is useful for intentional incremental
JSON construction; it is not exposed as a model tool argument. Edits validate only
the final content, so they can repair an invalid existing file. Intermediate states
inside an edit batch need not be valid. Tool descriptions and schemas are unchanged.

Custom tools must mount the hook themselves. It does not intercept arbitrary tool
names, shell writes, renames, native provider tools or external processes. It adds no
filesystem locks or transaction guarantees; hosts still own concurrency, path and
symlink policy, byte limits and write durability. Team write scopes remain scheduling
declarations. This behavior applies equally to single-agent and team use.
