import { Message, Role, TaskState } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import {
  createAgentCardFromDefinition,
  createDefinedAgentA2AServer,
} from '@alvin0/ai-agent-sdk-a2a/server'

class FixtureAdapter extends ModelAdapter {
  requests = []
  async * stream(options) {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'node a2a ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'node a2a ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  resolveModel(provider, model) {
    const effort = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: effort, name: 'medium' }], defaultEffort: effort },
    })
  }
}

const adapter = new FixtureAdapter()
const registry = new ModelRegistry()
registry.registerAdapter(['fixture'], adapter)
const agent = defineAgent({
  id: 'packed-a2a', provider: 'fixture', model: 'fixture', instructions: 'Return the fixture response.',
})
const card = createAgentCardFromDefinition(agent, { url: 'https://agents.example.test/a2a' })
const server = createDefinedAgentA2AServer({ agent, registry, agentCard: card })
const wireMessage = {
  messageId: 'packed-message', contextId: '', taskId: '', role: Role.ROLE_USER,
  parts: [
    { content: { $case: 'text', value: 'hello' }, mediaType: 'text/plain', filename: '', metadata: undefined },
    { content: { $case: 'data', value: { key: 'value' } }, mediaType: 'application/json', filename: '', metadata: undefined },
    { content: { $case: 'url', value: 'https://images.example.test/a.png' }, mediaType: 'image/png', filename: '', metadata: undefined },
    { content: { $case: 'raw', value: new Uint8Array([1, 2, 3]) }, mediaType: 'image/png', filename: '', metadata: undefined },
  ],
  metadata: undefined, extensions: [], referenceTaskIds: [],
}
const binaryJson = Message.toJSON(wireMessage)
const result = await server.requestHandler.sendMessage({
  tenant: '', message: wireMessage,
  configuration: {
    acceptedOutputModes: ['text/plain'], taskPushNotificationConfig: undefined, returnImmediately: false,
  },
  metadata: undefined,
}, new ServerCallContext({ requestedVersion: card.supportedInterfaces[0].protocolVersion }))
const content = adapter.requests[0]?.messages.at(-1)?.content ?? []
const evidence = {
  text: content.some(block => block.type === 'text' && block.text === 'hello'),
  data: content.some(block => block.type === 'text' && block.text === '{"key":"value"}'),
  url: content.some(block => block.type === 'image' && block.source.kind === 'url'
    && block.source.url === 'https://images.example.test/a.png'),
  binary: content.some(block => block.type === 'image' && block.source.kind === 'base64'
    && block.source.data === 'AQID'),
  binaryWire: JSON.stringify(binaryJson).includes('AQID'),
  completed: result.status?.state === TaskState.TASK_STATE_COMPLETED,
  buffer: typeof globalThis.Buffer,
  process: typeof globalThis.process,
}
if (!evidence.text || !evidence.data || !evidence.url || !evidence.binary || !evidence.binaryWire
  || !evidence.completed || evidence.buffer !== 'function' || evidence.process !== 'object') {
  throw new Error(`invalid Node A2A evidence: ${JSON.stringify(evidence)}`)
}
await server.executor.dispose()
console.log('a2a-node:pass')
