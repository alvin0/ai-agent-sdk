/**
 * The Hono application. The Next.js route handler forwards every `/api/*`
 * request here, so all backend behaviour lives in this package and the
 * frontend owns nothing but rendering.
 */

import { Hono } from 'hono'
import { cancelCodexLogin, codexAccount, codexLoginState, startCodexLogin } from './auth'
import {
  deleteConversation, getConversation, listConversations, readMessages, updateConversation,
} from './conversations'
import {
  createAgent, createMcpServer, createSkill, deleteAgent, deleteMcpServer, deleteSkill,
  listAgents, listMcpServers, listSkills, updateAgent, updateMcpServer, updateSkill,
} from './agents'
import { credentialViews, saveCredential } from './credentials'
import { createGroup, deleteGroup, getGroup, listGroups, updateGroup } from './groups'
import { groupToolSurface } from './runtime-tools'
import { listModels, listProviders } from './registry'
import {
  abortRun, answer, approve, forgetSession, pendingApprovals, runPrompt, session, steer,
} from './session'
import { grantPermission, listPermissions, revokePermission } from './approvals'
import { browseDirectory, currentWorkspace, defaultWorkspace, setWorkspace } from './workspace'
import type {
  AnswerRequestBody, ApproveRequestBody, ChatRequestBody, SteerRequestBody, WireApprovalScope,
  WireEvent,
} from './wire'

const APPROVAL_SCOPES: readonly WireApprovalScope[] = ['once', 'session', 'workspace']

function sse(event: WireEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function failed(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the chat backend.
 * @param basePath - Path prefix the host mounts the app under, e.g. `/api`.
 * @returns A Hono app whose `fetch` handles the request.
 */
export function createChatApp(basePath = '/api') {
  const app = new Hono().basePath(basePath)

  app.get('/health', c => c.json({ ok: true }))

  // ---- chat ---------------------------------------------------------------

  app.post('/chat', async (c) => {
    const body = await c.req.json<ChatRequestBody>()
    if (typeof body.sessionId !== 'string' || typeof body.prompt !== 'string') {
      return c.json({ error: 'sessionId and prompt are required' }, 400)
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of runPrompt(body.sessionId, body.prompt, body.groupId)) {
            controller.enqueue(encoder.encode(sse(event)))
          }
        } catch (error) {
          controller.enqueue(encoder.encode(sse({ t: 'error', message: failed(error) })))
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  })

  /**
   * Add a message to the run in flight.
   *
   * Answers "the agent is going the wrong way and I do not want to stop it":
   * the message lands in the agent's history now, so the turn already running
   * reads it. `steered: false` means no run was there to receive it, and the
   * client should send it as an ordinary prompt instead.
   */
  app.post('/steer', async (c) => {
    const body = await c.req.json<SteerRequestBody>()
    if (typeof body.sessionId !== 'string' || typeof body.prompt !== 'string') {
      return c.json({ error: 'sessionId and prompt are required' }, 400)
    }
    return c.json({ steered: await steer(body.sessionId, body.prompt) })
  })

  app.post('/answer', async (c) => {
    const body = await c.req.json<AnswerRequestBody>()
    return c.json({ resolved: await answer(body.sessionId, body.requestId, body.answers) })
  })

  /**
   * Answer a parked permission prompt.
   *
   * `scope` decides how long the answer lasts: this call, the whole
   * conversation, or every conversation in the project's directory.
   */
  app.post('/approve', async (c) => {
    const body = await c.req.json<ApproveRequestBody>()
    if (typeof body.sessionId !== 'string' || typeof body.callId !== 'string') {
      return c.json({ error: 'sessionId and callId are required' }, 400)
    }
    if (!['allow', 'deny', 'abort'].includes(body.decision)) {
      return c.json({ error: 'decision must be allow, deny, or abort' }, 400)
    }
    const scope = body.scope ?? 'once'
    if (!APPROVAL_SCOPES.includes(scope)) {
      return c.json({ error: `scope must be one of ${APPROVAL_SCOPES.join(', ')}` }, 400)
    }
    return c.json({ resolved: await approve(body.sessionId, body.callId, body.decision, scope) })
  })

  // ---- standing permissions ----------------------------------------------

  /** The workspace-wide grants for one project, so the user can review them. */
  app.get('/groups/:id/permissions', async (c) => {
    const group = await getGroup(c.req.param('id'))
    return c.json({ permissions: await listPermissions(group.workspaceRoot) })
  })

  app.post('/groups/:id/permissions', async (c) => {
    const body = await c.req.json<{ ruleKey: string }>()
    if (typeof body.ruleKey !== 'string' || body.ruleKey === '') {
      return c.json({ error: 'ruleKey is required' }, 400)
    }
    const group = await getGroup(c.req.param('id'))
    await grantPermission(group.workspaceRoot, body.ruleKey)
    return c.json({ permissions: await listPermissions(group.workspaceRoot) })
  })

  app.delete('/groups/:id/permissions/:ruleKey', async (c) => {
    const group = await getGroup(c.req.param('id'))
    await revokePermission(group.workspaceRoot, decodeURIComponent(c.req.param('ruleKey')))
    return c.json({ permissions: await listPermissions(group.workspaceRoot) })
  })

  app.post('/abort', async (c) => {
    const body = await c.req.json<{ sessionId: string }>()
    return c.json({ aborted: await abortRun(body.sessionId) })
  })

  // ---- conversations ------------------------------------------------------

  app.get('/conversations', async (c) => {
    const groupId = c.req.query('groupId')
    return c.json({ conversations: await listConversations(groupId) })
  })

  /**
   * Read one conversation. Deliberately does NOT create it: opening a blank
   * chat must not leave an empty row in the list — the first prompt does that.
   */
  app.get('/conversations/:id', async (c) => {
    const id = c.req.param('id')
    const conversation = await getConversation(id)
    if (conversation === undefined) {
      return c.json({ conversation: null, messages: [], pendingQuestions: 0, pendingApprovals: [] })
    }
    const live = await session(id)
    return c.json({
      conversation,
      messages: await readMessages(id),
      pendingQuestions: live.broker.pending().length,
      // A prompt still waiting is not in the transcript, so a reload has to be
      // handed the live ones to re-render.
      pendingApprovals: await pendingApprovals(id),
    })
  })

  /**
   * Patch a conversation: title, provider/model, loop mode, or workspace.
   *
   * `groupId` names the project the conversation belongs to and is NOT applied
   * as an update — it exists because this route can be the first thing that
   * touches a brand-new conversation (picking a model before typing a prompt),
   * and whichever request creates the row decides its group and therefore the
   * directory its tools will write to. Sending it does not move an existing
   * conversation: an implicit reassignment is exactly how a conversation ends
   * up running against the wrong folder.
   */
  app.patch('/conversations/:id', async (c) => {
    const id = c.req.param('id')
    const { groupId, ...patch } = await c.req.json<{
      title?: string
      provider?: string | null
      model?: string | null
      mode?: string
      workspaceRoot?: string
      groupId?: string
      agentId?: string | null
      reasoningEffort?: string | null
    }>()
    const MODES = ['basic', 'deep', 'deep-human-in-loop', 'team', 'team-dynamic']
    if (patch.mode !== undefined && !MODES.includes(patch.mode)) {
      return c.json({ error: `mode must be one of ${MODES.join(', ')}` }, 400)
    }
    await session(id, groupId)
    await updateConversation(id, patch)
    return c.json({ conversation: await getConversation(id) })
  })

  app.delete('/conversations/:id', async (c) => {
    const id = c.req.param('id')
    forgetSession(id)
    await deleteConversation(id)
    return c.json({ deleted: true })
  })

  // ---- groups -------------------------------------------------------------

  app.get('/groups', async c => c.json({ groups: await listGroups() }))

  app.post('/groups', async (c) => {
    // A project IS a folder: the name defaults to the folder's own name, so
    // creating one is just picking a directory.
    const body = await c.req.json<{ name?: string; workspaceRoot: string }>()
    try {
      return c.json({ group: await createGroup(body) })
    } catch (error) {
      return c.json({ error: failed(error) }, 400)
    }
  })

  app.patch('/groups/:id', async (c) => {
    const body = await c.req.json<{ name?: string; workspaceRoot?: string }>()
    try {
      return c.json({ group: await updateGroup(c.req.param('id'), body) })
    } catch (error) {
      return c.json({ error: failed(error) }, 400)
    }
  })

  app.delete('/groups/:id', async (c) => {
    try {
      await deleteGroup(c.req.param('id'))
      return c.json({ deleted: true })
    } catch (error) {
      return c.json({ error: failed(error) }, 400)
    }
  })

  // ---- agents, MCP servers, skills ---------------------------------------

  app.get('/groups/:id/agents', async c => c.json({ agents: await listAgents(c.req.param('id')) }))

  app.post('/groups/:id/agents', async (c) => {
    const body = await c.req.json<Record<string, unknown>>()
    const group = await getGroup(c.req.param('id'))
    return c.json({
      agent: await createAgent({
        // Global by default: these settings are app-wide, not per project.
        groupId: body.projectOnly === true ? group.id : null,
        name: String(body.name ?? ''),
        description: (body.description as string | null | undefined) ?? null,
        systemPrompt: (body.systemPrompt as string | null | undefined) ?? null,
        provider: (body.provider as string | null | undefined) ?? null,
        model: (body.model as string | null | undefined) ?? null,
        mode: (body.mode as string | undefined) ?? 'basic',
        reasoningEffort: (body.reasoningEffort as string | null | undefined) ?? null,
        inTeam: body.inTeam === true,
      }),
    })
  })

  app.patch('/agents/:id', async (c) => {
    await updateAgent(c.req.param('id'), await c.req.json())
    return c.json({ updated: true })
  })

  app.delete('/agents/:id', async (c) => {
    await deleteAgent(c.req.param('id'))
    return c.json({ deleted: true })
  })

  /** Servers plus their live connection status (connecting on demand). */
  app.get('/groups/:id/mcp', async (c) => {
    const group = await getGroup(c.req.param('id'))
    const servers = await listMcpServers(group.id)
    const surface = await groupToolSurface(group.id, group.workspaceRoot)
    return c.json({ servers, statuses: surface.mcpStatuses })
  })

  app.post('/groups/:id/mcp', async (c) => {
    const body = await c.req.json<Record<string, unknown>>()
    const group = await getGroup(c.req.param('id'))
    const transport = body.transport === 'http' ? 'http' : 'stdio'
    try {
      return c.json({
        server: await createMcpServer({
          groupId: body.projectOnly === true ? group.id : null,
          name: String(body.name ?? ''),
          transport,
          command: (body.command as string | null | undefined) ?? null,
          args: (body.args as string[] | null | undefined) ?? null,
          env: (body.env as Record<string, string> | null | undefined) ?? null,
          url: (body.url as string | null | undefined) ?? null,
          headers: (body.headers as Record<string, string> | null | undefined) ?? null,
        }),
      })
    } catch (error) {
      return c.json({ error: failed(error) }, 400)
    }
  })

  app.patch('/mcp/:id', async (c) => {
    await updateMcpServer(c.req.param('id'), await c.req.json())
    return c.json({ updated: true })
  })

  app.delete('/mcp/:id', async (c) => {
    await deleteMcpServer(c.req.param('id'))
    return c.json({ deleted: true })
  })

  app.get('/groups/:id/skills', async c => c.json({ skills: await listSkills(c.req.param('id')) }))

  app.post('/groups/:id/skills', async (c) => {
    const body = await c.req.json<{ name: string; rootPath: string; projectOnly?: boolean }>()
    const group = await getGroup(c.req.param('id'))
    return c.json({
      skill: await createSkill({
        groupId: body.projectOnly === true ? group.id : null,
        name: body.name,
        rootPath: body.rootPath,
      }),
    })
  })

  app.patch('/skills/:id', async (c) => {
    await updateSkill(c.req.param('id'), await c.req.json())
    return c.json({ updated: true })
  })

  app.delete('/skills/:id', async (c) => {
    await deleteSkill(c.req.param('id'))
    return c.json({ deleted: true })
  })

  // ---- providers and credentials -----------------------------------------

  app.get('/providers', async c => c.json({ providers: await listProviders() }))

  app.get('/providers/:id/models', async (c) => {
    try {
      return c.json({ models: await listModels(c.req.param('id')) })
    } catch (error) {
      return c.json({ error: failed(error) }, 400)
    }
  })

  /**
   * Store a provider's API key and endpoint. Both fields are tri-state:
   * omitted keeps the current value, null clears it, a string replaces it.
   * Keys are never returned by any route — only a four-character hint.
   */
  app.put('/providers/:id/credential', async (c) => {
    const provider = c.req.param('id')
    const body = await c.req.json<{ apiKey?: string | null; baseUrl?: string | null }>()
    await saveCredential(provider, body)
    const [view] = await credentialViews([provider])
    return c.json({ credential: view })
  })

  // ---- Codex device-code sign-in -----------------------------------------

  app.get('/auth/codex', async c => c.json(await codexLoginState()))

  app.post('/auth/codex/start', async (c) => {
    const account = await codexAccount()
    if (account.signedIn) return c.json({ status: 'signed-in', account })
    return c.json(await startCodexLogin())
  })

  app.post('/auth/codex/cancel', c => c.json({ cancelled: cancelCodexLogin() }))

  // ---- workspace ----------------------------------------------------------

  app.get('/workspace', async c => c.json({
    root: await currentWorkspace(),
    sandbox: defaultWorkspace(),
  }))

  app.put('/workspace', async (c) => {
    const body = await c.req.json<{ root: string }>()
    try {
      return c.json({ root: await setWorkspace(body.root) })
    } catch (error) {
      return c.json({ error: failed(error) }, 400)
    }
  })

  /** Browse directories server-side: a browser cannot hand over a real path. */
  app.get('/workspace/browse', (c) => {
    try {
      return c.json(browseDirectory(c.req.query('path')))
    } catch (error) {
      return c.json({ error: failed(error) }, 400)
    }
  })

  return app
}
