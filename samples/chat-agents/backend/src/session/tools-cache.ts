import { ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import { createSampleTools } from '../tools'

/**
 * One tool registry per workspace root, at MODULE scope on purpose: a hot
 * reload must rebuild tool definitions, while live sessions (below) must
 * survive it.
 */
export const toolsByRoot = new Map<string, ToolRegistry>()

export function toolsFor(root: string): ToolRegistry {
  const existing = toolsByRoot.get(root)
  if (existing !== undefined) return existing
  const created = createSampleTools(root)
  toolsByRoot.set(root, created)
  return created
}
