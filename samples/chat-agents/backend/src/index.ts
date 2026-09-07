/** Public surface consumed by the Next.js host. */

export { createChatApp } from './app'
export { abortRun, answer, forgetSession, runPrompt, session } from './session'
export type { ChatSession } from './session'
export {
  appendMessage, deleteConversation, ensureConversation, getConversation, listConversations,
  loadHistory, readMessages, saveHistory, updateConversation,
} from './conversations'
export type { ConversationRow } from './conversations'
export { credentialViews, saveCredential } from './credentials'
export type { CredentialView } from './credentials'
export { browseDirectory, currentWorkspace, defaultWorkspace, setWorkspace } from './workspace'
export {
  createGroup, deleteGroup, getGroup, listGroups, updateGroup, DEFAULT_GROUP_ID,
} from './groups'
export type { GroupRow } from './groups'
export {
  createAgent, createMcpServer, createSkill, deleteAgent, deleteMcpServer, deleteSkill,
  getAgent, listAgents, listMcpServers, listSkills, mcpTools, updateAgent, updateMcpServer,
  updateSkill,
} from './agents'
export type { AgentRow, McpServerRow, McpStatus, SkillRow } from './agents'
export { groupToolSurface, mergeTools } from './runtime-tools'
export { startRun, DEFAULT_INSTRUCTIONS } from './agent-runtime'
export type { RunContext, RunHandles, RunMode } from './agent-runtime'
export { EventProjector } from './event-projection'
export type { StoredNode } from './event-projection'
export type { DirectoryEntry, DirectoryListing } from './workspace'
export { createSampleTools, diffLines } from './tools'
export { buildRegistry, listModels, listProviders, resolveModel } from './registry'
export type { ModelOption, ModelSelection, ProviderInfoView } from './registry'
export { cancelCodexLogin, codexAccount, codexLoginState, codexSignedIn, startCodexLogin } from './auth'
export type { CodexAccount, CodexLoginState } from './auth'
export { database, databaseFile, schema } from './db/client'
export type * from './wire'
