/** Public surface consumed by the Next.js host. */

export { createChatApp } from './app'
export {
  abortRun, answer, approve, forgetSession, pendingApprovals, pendingQuestions, runPrompt, session,
  steer,
} from './session'
export { createDoorbell, createMemberFeed, followWorkers, runSteps } from './session'
export type { ChatSession, Doorbell, MemberFeed, RunStep } from './session'
export {
  createApprovalPolicy, grantPermission, listPermissions, revokePermission,
} from './approvals'
export type { ApprovalPolicy, ApprovalPolicyOptions, ToolPermissionRow } from './approvals'
export {
  appendMessage, deleteConversation, ensureConversation, getConversation, listConversations,
  loadHistory, readMessages, saveHistory, updateConversation,
} from './conversations'
export type { ConversationRow } from './conversations'
export { credentialViews, saveCredential } from './credentials'
export type { CredentialView } from './credentials'
export { browseDirectory, currentWorkspace, defaultWorkspace, setWorkspace } from './workspace'
export {
  createGroup, deleteGroup, getGroup, listGroups, listGroupViews, updateGroup, DEFAULT_GROUP_ID,
} from './groups'
export type { GroupRow, GroupView } from './groups'
export {
  createAgent, createMcpServer, createSkill, deleteAgent, deleteMcpServer, deleteSkill,
  getAgent, listAgents, listMcpServers, listSkills, mcpTools, updateAgent, updateMcpServer,
  updateSkill,
} from './agents'
export type { AgentRow, McpServerRow, McpStatus, SkillRow } from './agents'
export { groupToolSurface, mergeTools } from './runtime-tools'
export { startRun, DEFAULT_INSTRUCTIONS } from './agent-runtime'
export {
  backoffMs, createIdleWatch, isTransient, retryHooks,
  MAX_MODEL_ATTEMPTS, MODEL_TIMEOUT_MS, PROGRESS_REPORT_MS,
} from './resilience'
export type { IdleVerdict, IdleWatch, RetryNotice } from './resilience'
export type { RunContext, RunHandles, RunMode } from './agent-runtime'
export { EventProjector } from './event-projection'
export type { EventProjectorOptions, StoredNode } from './event-projection'
export type { DirectoryEntry, DirectoryListing, PathSegment } from './workspace'
export {
  commandRuleKeys, commandRules, createSampleTools, describeMutation, diffLines, onCommandOutput,
  plainTokens, MUTATING_TOOLS, TOOL_LABELS,
} from './tools'
export type { CommandOutputListener, MutationDescription, RuleChoice } from './tools'
export { commandHazards } from './hazards'
export { listProjectInstructions } from './instructions'
export { listAvailableSkills, resolveSkillMentions, skillSourcesFor } from './skill-catalog'
export type { ResolvedMentions, SkillMention } from './skill-catalog'
export type { ProjectInstructionFile, ProjectInstructions } from './instructions'
export type { Hazard, HazardSeverity } from './hazards'
export { buildRegistry, listModels, listProviders, resolveModel } from './registry'
export type { ModelOption, ModelSelection, ProviderInfoView } from './registry'
export { cancelCodexLogin, codexAccount, codexLoginState, codexSignedIn, startCodexLogin } from './auth'
export type { CodexAccount, CodexLoginState } from './auth'
export { clearUsage, recordUsage, usageSummary } from './usage'
export { createFileSpillStore, spillRoot, sweepSpill } from './spill'
export {
  attachmentPath, attachmentRoot, projectAttachments, readAttachment, readAttachmentBytes,
  sanitizeName, sizeText, storeAttachment, AttachmentRejected,
  MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_BYTES, MAX_IMAGE_BYTES,
} from './attachments'
export type { AttachmentKind, AttachmentRecord } from './attachments'
export type { UsageRow, UsageSummary, UsageTotals } from './usage'
export { database, databaseFile, schema } from './db/client'
export type * from './wire'
