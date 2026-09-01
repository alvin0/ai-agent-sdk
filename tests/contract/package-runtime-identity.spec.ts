import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('workspace compatibility runtime identity', () => {
  it('re-exports the single core and agent package instances', async () => {
    const compatibility = await import(pathToFileURL(resolve(root, 'dist/index.js')).href)
    const core = await import(pathToFileURL(resolve(root, 'packages/core/dist/index.js')).href)
    const agent = await import(pathToFileURL(resolve(root, 'packages/agent/dist/index.js')).href)

    expect(compatibility.ModelRegistry).toBe(core.ModelRegistry)
    expect(compatibility.AgentSession).toBe(agent.AgentSession)
    expect(compatibility.AgentTeam).toBe(agent.AgentTeam)
    expect(compatibility.ToolRegistry).toBe(agent.ToolRegistry)
    expect(compatibility.defineAgent).toBe(agent.defineAgent)
  })
})
