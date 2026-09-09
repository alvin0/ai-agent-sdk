import { AGENT_CONTROL_TOOLS } from '@ai-agent-sdk/core/agent'

export const SKILL_TOOLS = new Set([
  'load_skill',
  'search_skill_resources',
  'read_skill_resource',
])
export const CONTROL_TOOLS = new Set<string>(Object.values(AGENT_CONTROL_TOOLS))
export const MATERIAL_AGENTCODE_TOOLS = new Set([
  'write_file',
  'replace_in_file',
  'run_command',
])
export const SUCCESSFUL_NATIVE_STATUSES = new Set([
  'completed',
  'success',
  'succeeded',
])
