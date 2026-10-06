import assert from 'node:assert/strict'
import { ModelAdapter, ModelRegistry, ToolCallId, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { History, runAgent } from '@alvin0/ai-agent-sdk-core/agent'

class Scripted extends ModelAdapter {
  round = 0
  async *stream() {
    if (this.round++ === 0) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('q'), name: 'request_user_input',
        arguments: JSON.stringify({ questions: [{ id: 'q1', header: 'Scope', question: 'Which scope?', options: [
          { label: 'A', description: 'First' }, { label: 'B', description: 'Second' },
        ] }] }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Answer using an assumption.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
}

const registry = new ModelRegistry()
registry.registerAdapter(['test'], new Scripted())
const history = new History()
history.append({ kind: 'user', message: createTextMessage('go') })
const broker = { request: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late broker rejection')), 60)) }
for await (const event of runAgent({ mode: 'deep', registry, history, config: { provider: 'test', model: 'm' },
  maxTurns: 2, bounds: { finalizeSteps: 0 }, userInputTimeoutMs: 10, userInput: broker })) {
  if (event.type === 'tool-call') await new Promise(resolve => setTimeout(resolve, 40))
}
await new Promise(resolve => setTimeout(resolve, 80))
assert.match(JSON.stringify(history.messages()), /did not answer within/)
console.log('broker backpressure regression passed')
