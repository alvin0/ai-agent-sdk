import { ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import { readFileTool, listDirectoryTool, searchFilesTool, proposeEditTool } from './tools/file-inspection'
import { writeFileTool, editFileTool, deletePathTool, createDirectoryTool, movePathTool } from './tools/file-mutations'
import { runCommandTool } from './tools/command'
import { writeTodosTool } from './tools/todos'
import { fetchUrlTool } from './tools/web'

export { diffLines } from './tools/text'
export { onCommandOutput } from './tools/command-output'
export { plainTokens, commandRuleKeys, commandRules } from './tools/command-rules'
export { MUTATING_TOOLS, describeMutation } from './tools/mutation'
export { TOOL_LABELS } from './tools/labels'
export type { CommandOutputListener } from './tools/command-output'
export type { RuleChoice, MutationDescription } from './tools/types'

/** Build tools in the same order as the original sample registry. */
export function createSampleTools(root: string): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register(readFileTool(root))
  tools.register(listDirectoryTool(root))
  tools.register(searchFilesTool(root))
  tools.register(proposeEditTool(root))
  tools.register(writeFileTool(root))
  tools.register(editFileTool(root))
  tools.register(deletePathTool(root))
  tools.register(createDirectoryTool(root))
  tools.register(movePathTool(root))
  tools.register(runCommandTool(root))
  tools.register(writeTodosTool(root))
  tools.register(fetchUrlTool(root))
  return tools
}
