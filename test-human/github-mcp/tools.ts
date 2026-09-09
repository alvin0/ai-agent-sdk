import type { ToolExecutionResult } from '@alvin0/ai-agent-sdk-core/agent'
import { dispatchToolCall } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolCatalog } from '@alvin0/ai-agent-sdk-core/agent'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { JsonObject } from '@alvin0/ai-agent-sdk-core'

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
