import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'groups-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')

const { createChatApp } = await import('../../samples/chat-agents/backend/src/app.ts')
const app = createChatApp('/api')

const call = async (method: string, path: string, body?: unknown) =>
  await app.fetch(new Request(`http://local/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  }))

describe('a conversation belongs to the project that was open', () => {
  // Materialise the Default project first, exactly as a real database has it:
  // it is the oldest group and therefore the fallback, so a test that names
  // another project can actually tell the two apart.
  beforeAll(async () => {
    const listed = await (await call('GET', '/groups')).json() as { groups: { id: string }[] }
    expect(listed.groups.map(row => row.id)).toContain('default')
  })

  it('is created in the project a settings patch names, not the default', async () => {
    const project = mkdtempSync(join(home, 'project-'))
    const created = await (await call('POST', '/groups', { workspaceRoot: project })).json() as
      { group: { id: string; workspaceRoot: string } }

    // Picking a model before typing is what creates the row: this request has
    // always been the first to touch a brand-new conversation.
    const id = 'c_settings_first'
    await call('PATCH', `/conversations/${id}`, {
      provider: 'openai',
      model: 'gpt-5',
      groupId: created.group.id,
    })

    const body = await (await call('GET', `/conversations/${id}`)).json() as
      { conversation: { groupId: string; workspaceRoot: string } }
    expect(body.conversation.groupId).toBe(created.group.id)
    expect(body.conversation.workspaceRoot).toBe(created.group.workspaceRoot)

    // And it is listed under that project, which is how the bug showed up:
    // a full run on screen with "No conversations yet" in the sidebar.
    const listed = await (await call('GET', `/conversations?groupId=${created.group.id}`)).json() as
      { conversations: { id: string }[] }
    expect(listed.conversations.map(row => row.id)).toContain(id)
  })

  it('falls back to the default project only when no group is named', async () => {
    const listed = await (await call('GET', '/groups')).json() as { groups: { id: string }[] }
    const fallback = listed.groups.find(row => row.id === 'default') ?? listed.groups[0]
    const id = 'c_no_group'
    await call('PATCH', `/conversations/${id}`, { mode: 'deep' })
    const body = await (await call('GET', `/conversations/${id}`)).json() as
      { conversation: { groupId: string } }
    expect(body.conversation.groupId).toBe(fallback?.id)
  })

  it('does not move an existing conversation between projects', async () => {
    const first = mkdtempSync(join(home, 'first-'))
    const second = mkdtempSync(join(home, 'second-'))
    const a = await (await call('POST', '/groups', { workspaceRoot: first })).json() as { group: { id: string } }
    const b = await (await call('POST', '/groups', { workspaceRoot: second })).json() as { group: { id: string } }

    const id = 'c_stays_put'
    await call('PATCH', `/conversations/${id}`, { mode: 'deep', groupId: a.group.id })
    await call('PATCH', `/conversations/${id}`, { mode: 'basic', groupId: b.group.id })

    const body = await (await call('GET', `/conversations/${id}`)).json() as
      { conversation: { groupId: string; mode: string } }
    expect(body.conversation.groupId).toBe(a.group.id)
    expect(body.conversation.mode).toBe('basic')
  })

  it('does not create a row when a conversation is only read', async () => {
    const body = await (await call('GET', '/conversations/c_never_touched')).json() as
      { conversation: null }
    expect(body.conversation).toBeNull()
    const listed = await (await call('GET', '/conversations')).json() as
      { conversations: { id: string }[] }
    expect(listed.conversations.map(row => row.id)).not.toContain('c_never_touched')
  })
})
