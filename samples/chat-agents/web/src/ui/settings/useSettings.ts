'use client'

/**
 * Everything the settings dialog drives: provider catalogue and credentials,
 * the Codex device-code sign-in, the workspace the agent may read, the loop
 * mode, and the model the open conversation runs on.
 *
 * Credentials never round-trip through this hook — a key is written to the
 * backend and only its four-character hint comes back.
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  AgentRow, CodexLoginState, ConversationRow, DirectoryListing, GroupRow, McpServerRow, McpStatus,
  ModelOption, ProviderInfoView, SkillRow,
} from '@chat-agents/backend'

/** Loop policy, mirrored from the SDK's agent modes plus the two team shapes. */
export type RunMode = 'basic' | 'deep' | 'deep-human-in-loop' | 'team' | 'team-dynamic'

export interface ModelChoice {
  readonly provider: string
  readonly model: string
}

/**
 * A reasoning effort id. The set is provider- and MODEL-specific (a Codex
 * route may offer `xhigh`, `max`, or `ultra`), so it is discovered from the
 * catalogue rather than enumerated here.
 */
export type Effort = string

/** Effort ladder used when a model discloses none. */
export const GENERIC_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high']

export interface SettingsController {
  readonly providers: readonly ProviderInfoView[]
  readonly models: Readonly<Record<string, readonly ModelOption[]>>
  readonly codex: CodexLoginState
  readonly choice: ModelChoice | undefined
  readonly mode: RunMode
  readonly effort: Effort | undefined
  readonly workspace: string
  readonly sandbox: string
  readonly group: GroupRow | undefined
  readonly agents: readonly AgentRow[]
  readonly mcpServers: readonly McpServerRow[]
  readonly mcpStatuses: readonly McpStatus[]
  readonly skills: readonly SkillRow[]
  /** The agent preset driving the open conversation, when one is chosen. */
  readonly agentId: string | undefined
  refresh: () => Promise<void>
  loadModels: (provider: string) => Promise<void>
  /** The catalogue for one provider, falling back to its static suggestions. */
  modelsFor: (provider: string) => readonly ModelOption[]
  /** Effort ids the given model accepts, or the generic ladder. */
  effortsFor: (provider: string, model: string | undefined) => readonly string[]
  choose: (choice: ModelChoice) => Promise<void>
  setMode: (mode: RunMode) => Promise<void>
  setEffort: (effort: Effort) => Promise<void>
  saveCredential: (provider: string, input: { apiKey?: string | null; baseUrl?: string | null }) => Promise<void>
  startCodexLogin: () => Promise<void>
  cancelCodexLogin: () => Promise<void>
  browse: (path?: string) => Promise<DirectoryListing | undefined>
  chooseWorkspace: (root: string) => Promise<string | undefined>
  chooseAgent: (agentId: string | null) => Promise<void>
  refreshGroupConfig: () => Promise<void>
  createAgent: (input: Record<string, unknown>) => Promise<void>
  updateAgent: (agentId: string, patch: Record<string, unknown>) => Promise<void>
  deleteAgent: (agentId: string) => Promise<void>
  createMcpServer: (input: Record<string, unknown>) => Promise<string | undefined>
  updateMcpServer: (serverId: string, patch: Record<string, unknown>) => Promise<void>
  deleteMcpServer: (serverId: string) => Promise<void>
  createSkill: (input: { name: string; rootPath: string }) => Promise<void>
  updateSkill: (skillId: string, patch: Record<string, unknown>) => Promise<void>
  deleteSkill: (skillId: string) => Promise<void>
  renameGroup: (name: string) => Promise<void>
  deleteGroup: () => Promise<void>
}

/**
 * Patch one conversation.
 *
 * `groupId` is always sent, because this request may be the first thing that
 * touches a new conversation — choosing a model before typing a prompt creates
 * the row — and the row's group decides which folder its tools write to. Omit
 * it and the conversation is created in the default project, so the agent
 * writes into the sample's sandbox while the sidebar shows another project.
 * @param id - Conversation id.
 * @param groupId - The project the user has open.
 * @param patch - Fields to change.
 */
async function patchConversation(id: string, groupId: string, patch: object): Promise<void> {
  await fetch(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...patch, groupId }),
  })
}

/**
 * Drive the settings dialog for one conversation.
 * @param conversationId - The open conversation; model and mode are per conversation.
 * @returns The settings data and actions.
 */
export function useSettings(conversationId: string, groupId: string): SettingsController {
  const [providers, setProviders] = useState<readonly ProviderInfoView[]>([])
  const [models, setModels] = useState<Record<string, readonly ModelOption[]>>({})
  const [codex, setCodex] = useState<CodexLoginState>({ status: 'idle' })
  const [choice, setChoice] = useState<ModelChoice | undefined>(undefined)
  const [mode, setModeState] = useState<RunMode>('basic')
  const [effort, setEffortState] = useState<Effort | undefined>(undefined)
  const [workspace, setWorkspace] = useState('')
  const [sandbox, setSandbox] = useState('')
  const [group, setGroup] = useState<GroupRow | undefined>(undefined)
  const [agents, setAgents] = useState<readonly AgentRow[]>([])
  const [mcpServers, setMcpServers] = useState<readonly McpServerRow[]>([])
  const [mcpStatuses, setMcpStatuses] = useState<readonly McpStatus[]>([])
  const [skills, setSkills] = useState<readonly SkillRow[]>([])
  const [agentId, setAgentId] = useState<string | undefined>(undefined)

  // The group's configuration: its workspace, agents, MCP servers, and skills.
  const refreshGroupConfig = useCallback(async () => {
    if (groupId === '') return
    const [groupsResponse, agentResponse, mcpResponse, skillResponse] = await Promise.all([
      fetch('/api/groups'),
      fetch(`/api/groups/${groupId}/agents`),
      fetch(`/api/groups/${groupId}/mcp`),
      fetch(`/api/groups/${groupId}/skills`),
    ])
    if (groupsResponse.ok) {
      const body = await groupsResponse.json() as { groups: GroupRow[] }
      const found = body.groups.find(row => row.id === groupId)
      setGroup(found)
      if (found !== undefined) setWorkspace(found.workspaceRoot)
    }
    if (agentResponse.ok) setAgents((await agentResponse.json() as { agents: AgentRow[] }).agents)
    if (mcpResponse.ok) {
      const body = await mcpResponse.json() as { servers: McpServerRow[]; statuses: McpStatus[] }
      setMcpServers(body.servers)
      setMcpStatuses(body.statuses)
    }
    if (skillResponse.ok) setSkills((await skillResponse.json() as { skills: SkillRow[] }).skills)
  }, [groupId])

  const refresh = useCallback(async () => {
    const [providerResponse, codexResponse, workspaceResponse] = await Promise.all([
      fetch('/api/providers'),
      fetch('/api/auth/codex'),
      fetch('/api/workspace'),
    ])
    if (providerResponse.ok) {
      const body = await providerResponse.json() as { providers: ProviderInfoView[] }
      setProviders(body.providers)
    }
    if (codexResponse.ok) setCodex(await codexResponse.json() as CodexLoginState)
    if (workspaceResponse.ok) {
      const body = await workspaceResponse.json() as { root: string; sandbox: string }
      setSandbox(body.sandbox)
      // The group's own root wins; the global one is only the seed.
      setWorkspace(current => (current === '' ? body.root : current))
    }
    await refreshGroupConfig()
  }, [refreshGroupConfig])

  const loadModels = useCallback(async (provider: string) => {
    const response = await fetch(`/api/providers/${provider}/models`)
    if (!response.ok) return
    const body = await response.json() as { models: ModelOption[] }
    setModels(current => ({ ...current, [provider]: body.models }))
  }, [])

  // The conversation row is authoritative for model and mode: the badge must
  // report what the next run will actually use, never a client-side guess.
  useEffect(() => {
    // No group guard: this only READS, and the route does not create a row.
    if (conversationId === '') return
    void (async () => {
      const response = await fetch(`/api/conversations/${conversationId}`)
      if (!response.ok) return
      const body = await response.json() as { conversation: ConversationRow | null }
      // A blank chat has no row yet: keep the defaults rather than reading null.
      const row = body.conversation
      if (row === null) return
      setModeState((row.mode as RunMode | undefined) ?? 'basic')
      setEffortState((row.reasoningEffort as Effort | null) ?? undefined)
      setAgentId(row.agentId ?? undefined)
      setChoice(row.provider != null && row.model != null
        ? { provider: row.provider, model: row.model }
        : undefined)
    })()
  }, [conversationId])

  useEffect(() => { void refresh() }, [refresh])

  const modelsFor = useCallback((provider: string): readonly ModelOption[] => {
    const discovered = models[provider]
    if (discovered !== undefined) return discovered
    const view = providers.find(entry => entry.id === provider)
    return (view?.models ?? []).map(id => ({ id, efforts: [] }))
  }, [models, providers])

  const effortsFor = useCallback((provider: string, model: string | undefined): readonly string[] => {
    if (model === undefined) return GENERIC_EFFORTS
    const found = modelsFor(provider).find(entry => entry.id === model)
    return found === undefined || found.efforts.length === 0 ? GENERIC_EFFORTS : found.efforts
  }, [modelsFor])

  const choose = useCallback(async (next: ModelChoice) => {
    // An unresolved project would create the row in the default one.
    if (conversationId === '' || groupId === '') return
    setChoice(next)
    await patchConversation(conversationId, groupId, { provider: next.provider, model: next.model })
  }, [conversationId, groupId])

  const setMode = useCallback(async (next: RunMode) => {
    // An unresolved project would create the row in the default one.
    if (conversationId === '' || groupId === '') return
    setModeState(next)
    await patchConversation(conversationId, groupId, { mode: next })
  }, [conversationId, groupId])

  const setEffort = useCallback(async (next: Effort) => {
    // An unresolved project would create the row in the default one.
    if (conversationId === '' || groupId === '') return
    setEffortState(next)
    await patchConversation(conversationId, groupId, { reasoningEffort: next })
  }, [conversationId, groupId])

  const saveCredential = useCallback(async (
    provider: string,
    input: { apiKey?: string | null; baseUrl?: string | null },
  ) => {
    await fetch(`/api/providers/${provider}/credential`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    await refresh()
  }, [refresh])

  const startCodexLogin = useCallback(async () => {
    const response = await fetch('/api/auth/codex/start', { method: 'POST' })
    setCodex(await response.json() as CodexLoginState)
  }, [])

  const cancelCodexLogin = useCallback(async () => {
    await fetch('/api/auth/codex/cancel', { method: 'POST' })
    setCodex({ status: 'idle' })
  }, [])

  const browse = useCallback(async (path?: string) => {
    const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
    const response = await fetch(`/api/workspace/browse${query}`)
    if (!response.ok) return undefined
    return await response.json() as DirectoryListing
  }, [])

  /** Move the OPEN GROUP's workspace; every conversation in it follows. */
  const chooseWorkspace = useCallback(async (root: string) => {
    if (groupId === '') return undefined
    const response = await fetch(`/api/groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: root }),
    })
    if (!response.ok) return undefined
    const body = await response.json() as { group: GroupRow }
    setWorkspace(body.group.workspaceRoot)
    setGroup(body.group)
    if (conversationId !== '') {
      await patchConversation(conversationId, groupId, { workspaceRoot: body.group.workspaceRoot })
    }
    return body.group.workspaceRoot
  }, [conversationId, groupId])

  const chooseAgent = useCallback(async (next: string | null) => {
    // An unresolved project would create the row in the default one.
    if (conversationId === '' || groupId === '') return
    setAgentId(next ?? undefined)
    await patchConversation(conversationId, groupId, { agentId: next })
  }, [conversationId, groupId])

  const createAgent = useCallback(async (input: Record<string, unknown>) => {
    await fetch(`/api/groups/${groupId}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    await refreshGroupConfig()
  }, [groupId, refreshGroupConfig])

  const updateAgent = useCallback(async (id: string, patch: Record<string, unknown>) => {
    await fetch(`/api/agents/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    })
    await refreshGroupConfig()
  }, [refreshGroupConfig])

  const deleteAgent = useCallback(async (id: string) => {
    await fetch(`/api/agents/${id}`, { method: 'DELETE' })
    await refreshGroupConfig()
  }, [refreshGroupConfig])

  const createMcpServer = useCallback(async (input: Record<string, unknown>) => {
    const response = await fetch(`/api/groups/${groupId}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    await refreshGroupConfig()
    if (!response.ok) {
      const body = await response.json() as { error?: string }
      return body.error ?? 'could not add the server'
    }
    return undefined
  }, [groupId, refreshGroupConfig])

  const updateMcpServer = useCallback(async (id: string, patch: Record<string, unknown>) => {
    await fetch(`/api/mcp/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    })
    await refreshGroupConfig()
  }, [refreshGroupConfig])

  const deleteMcpServer = useCallback(async (id: string) => {
    await fetch(`/api/mcp/${id}`, { method: 'DELETE' })
    await refreshGroupConfig()
  }, [refreshGroupConfig])

  const createSkill = useCallback(async (input: { name: string; rootPath: string }) => {
    await fetch(`/api/groups/${groupId}/skills`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    await refreshGroupConfig()
  }, [groupId, refreshGroupConfig])

  const updateSkill = useCallback(async (id: string, patch: Record<string, unknown>) => {
    await fetch(`/api/skills/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    })
    await refreshGroupConfig()
  }, [refreshGroupConfig])

  const deleteSkill = useCallback(async (id: string) => {
    await fetch(`/api/skills/${id}`, { method: 'DELETE' })
    await refreshGroupConfig()
  }, [refreshGroupConfig])

  const renameGroup = useCallback(async (name: string) => {
    await fetch(`/api/groups/${groupId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    })
    await refreshGroupConfig()
  }, [groupId, refreshGroupConfig])

  const deleteGroup = useCallback(async () => {
    await fetch(`/api/groups/${groupId}`, { method: 'DELETE' })
  }, [groupId])

  // While a device-code login is pending, poll until it settles.
  useEffect(() => {
    if (codex.status !== 'pending') return
    const timer = setInterval(() => {
      void (async () => {
        const response = await fetch('/api/auth/codex')
        const next = await response.json() as CodexLoginState
        setCodex(next)
        if (next.status === 'signed-in') {
          await refresh()
          await loadModels('codex')
        }
      })()
    }, 3_000)
    return () => { clearInterval(timer) }
  }, [codex.status, refresh, loadModels])

  return {
    providers,
    models,
    codex,
    choice,
    mode,
    effort,
    workspace,
    sandbox,
    group,
    agents,
    mcpServers,
    mcpStatuses,
    skills,
    agentId,
    refresh,
    refreshGroupConfig,
    modelsFor,
    effortsFor,
    loadModels,
    choose,
    setMode,
    setEffort,
    saveCredential,
    startCodexLogin,
    cancelCodexLogin,
    browse,
    chooseWorkspace,
    chooseAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    createMcpServer,
    updateMcpServer,
    deleteMcpServer,
    createSkill,
    updateSkill,
    deleteSkill,
    renameGroup,
    deleteGroup,
  }
}
