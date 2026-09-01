import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '@ai-agent-sdk/node'
import { ModelRegistry as CoreModelRegistry } from '@ai-agent-sdk/core'
import { A2AAgentLink } from '@ai-agent-sdk/node/a2a'
import { dispatchToolCall } from '@ai-agent-sdk/node/agent'
import { resolveCodexAuthPath } from '@ai-agent-sdk/node/codex'
import { envCredential } from '@ai-agent-sdk/node/env'
import { fileSystemSkills } from '@ai-agent-sdk/node/filesystem'
import { connectMcpStdio } from '@ai-agent-sdk/node/mcp'
import { JsonlObservationJournalExporter } from '@ai-agent-sdk/node/observability'
import { anthropicAdapter } from '@ai-agent-sdk/node/providers'

class FixtureAdapter extends sdk.ModelAdapter {
  requests = []
  resolveModel(provider, model) {
    const effort = sdk.ReasoningEffortId('low')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: effort, name: 'low' }], defaultEffort: effort },
    })
  }
  async * stream(options) {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'node facade completed' } }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-node-facade-'))
try {
  assert.equal(sdk.ModelRegistry, CoreModelRegistry)
  assert.equal(existsSync(resolve('node_modules/@ai-agent-sdk/observability-browser')), false)
  assert.equal('IndexedDbObservationExporter' in sdk, false)
  assert.equal(A2AAgentLink, sdk.a2a.A2AAgentLink)
  assert.equal(JsonlObservationJournalExporter, sdk.JsonlObservationJournalExporter)
  assert.equal(anthropicAdapter, sdk.anthropicAdapter)
  assert.equal(fileSystemSkills, sdk.fileSystemSkills)
  process.env.NODE_FACADE_PACKED_KEY = 'packed-key'
  assert.equal(envCredential('NODE_FACADE_PACKED_KEY')(), 'packed-key')
  assert.equal(resolveCodexAuthPath(undefined, { cwd: root, env: {} }), resolve(root, '.providers/.codex/auth.json'))
  assert.equal(sdk.codexNodePlugin({ models: [] }).id, 'codex')

  const skillDirectory = join(root, 'skills', 'packed-guidance')
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), [
    '---', 'name: packed-guidance', 'description: Proves the full Node harness.', '---',
    'Use the packed Node workflow.', '',
  ].join('\n'))

  const journal = new sdk.JsonlObservationJournalExporter({
    rootDir: join(root, 'journal'), mode: 'reliable',
  })
  await journal.ready()
  const observation = sdk.createObservability({
    mode: 'reliable',
    exporters: [{ exporter: journal, requirement: 'required', boundary: 'local-durable' }],
  })
  const adapter = new FixtureAdapter()
  const registry = new sdk.ModelRegistry({ observation })
  registry.registerAdapter(['fixture'], adapter)
  const agent = sdk.defineAgent({
    id: 'packed-node-facade', provider: 'fixture', model: 'fixture', effort: 'low',
    instructions: 'Use available skills and return the fixture response.',
    skills: [fileSystemSkills({ roots: [join(root, 'skills')] })],
  })
  const response = await agent.createSession({ registry, observation, skillCwd: root }).run('Run the harness.')
  assert.equal(response.text, 'node facade completed')
  assert.equal(response.report.usage.reported.totalTokens, 12)
  assert.match(JSON.stringify(adapter.requests), /packed-guidance/)
  await observation.flush()
  const recovered = await journal.recover()
  assert.equal(recovered.records.some(record => record.event.name === 'sdk.agent.run'), true)
  assert.equal(recovered.records.some(record => record.event.name === 'sdk.model.call'), true)

  const connection = await connectMcpStdio({
    serverName: 'node-facade', command: process.execPath, args: ['server.mjs'], reconnect: false,
  })
  try {
    const result = await dispatchToolCall({
      catalog: connection.tools,
      call: {
        callId: sdk.ToolCallId('node-facade-mcp'), toolName: 'mcp__node-facade__multiply',
        rawArguments: '{"left":6,"right":7}',
      },
      position: { turn: 1, step: 1 }, signal: new AbortController().signal,
    })
    assert.equal(result.isError, false)
    assert.match(JSON.stringify(result.value), /42/)
  } finally {
    await connection.close()
  }
  await observation.shutdown()
  console.log('node-facade-packed:pass')
} finally {
  await rm(root, { recursive: true, force: true })
}
