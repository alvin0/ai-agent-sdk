import type { ToolExecutionResult } from '../../src/agent/tool/definition.ts'
import { dispatchToolCall } from '../../src/agent/tool/pipeline.ts'
import type { ToolCatalog } from '../../src/agent/tool/registry.ts'
import { ToolCallId } from '../../src/core/primitives/brand.ts'
import type { JsonObject } from '../../src/core/primitives/json.ts'

export type GitHubMcpToolName = 'get_me' | 'get_file_contents' | 'create_or_update_file'

export interface GitHubMcpToolCaller {
  call(name: GitHubMcpToolName, args: JsonObject): Promise<ToolExecutionResult>
}

export function createGitHubMcpToolCaller(catalog: ToolCatalog): GitHubMcpToolCaller {
  let sequence = 0
  return {
    call: async (name, args) => await dispatchToolCall({
      catalog,
      call: {
        callId: ToolCallId(`github-mcp-human-${++sequence}`),
        toolName: `mcp__github__${name}`,
        rawArguments: JSON.stringify(args),
      },
      position: { turn: 1, step: sequence },
      signal: new AbortController().signal,
    }),
  }
}
