/** Exercise new public APIs in each packed Web/Node runtime, without Node globals. */
export async function contextOptimizationEvidence({ ModelAdapter, createAgentRuntime }) {
  const [tools, { createContextOptimizer }, { ToolCallId }] = await Promise.all([
    import('@alvin0/ai-agent-sdk-core/tools'),
    import('@alvin0/ai-agent-sdk-core/memory'),
    import('@alvin0/ai-agent-sdk-core'),
  ])
  const big = 'portable inventory row\n'.repeat(800)
  const requests = [], bodies = []
  const adapter = fixtureAdapter(ModelAdapter, ToolCallId, requests)
  const runtime = await createAgentRuntime({ providers: [{
    kind: 'model-provider-plugin', apiVersion: 1, id: 'fixture-optimization',
    family: 'fixture', routes: ['fixture'], displayName: 'Fixture',
    setup(registrar) { registrar.registerAdapter(['fixture'], adapter) },
  }] })
  try {
    const { edit, test, fusion } = fixtureTools(tools, bodies, big)
    const optimizer = createContextOptimizer({ store: tools.createMemorySpillStore() })
    const agent = runtime.agent({
      id: 'fixture', model: { provider: 'fixture', id: 'm' }, instructions: 'Use tools.', compaction: false,
      tools: [edit, test, fusion.tool, optimizer.retrievalTool, tools.defineTool({
        name: 'noop', description: 'Continue', parameters: { type: 'object' }, execute: () => 'ok',
      })],
    })
    const session = agent.createSession({ hooks: optimizer.hooks, experimentalPrograms: [fusion.grant] })
    await session.run('start')
    assertPacking(requests)
    if (bodies.join(',') !== 'edit,test') throw new Error('fusion failed')
    await assertReduction(tools)
    optimizer.dispose()
    return { fused: true, packed: true, verified: true }
  } finally { await runtime.close() }
}

function fixtureAdapter(ModelAdapter, ToolCallId, requests) {
  return new class extends ModelAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 32000 } }
    }
    async *stream(request) {
      requests.push(request)
      const step = requests.length
      yield { type: 'block-end', index: 0, block: step <= 3
        ? { type: 'tool-call', id: ToolCallId(`opt-${step}`),
          name: step === 1 ? 'edit_and_test' : 'noop', arguments: '{}' }
        : { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: step <= 3 ? 'tool-calls' : 'stop' } }
    }
  }()
}

function fixtureTools({ defineTool, defineActionFusion }, bodies, big) {
  const edit = defineTool({
    name: 'apply_edit', description: 'Edit fixture state', parameters: { type: 'object' },
    execute() { bodies.push('edit'); return { edited: true } },
  })
  const test = defineTool({
    name: 'test_edit', description: 'Check fixture state', parameters: { type: 'object' },
    execute() {
      if (bodies[0] !== 'edit') throw new Error('edit did not precede test')
      bodies.push('test'); return big
    },
  })
  const fusion = defineActionFusion({
    name: 'edit_and_test', description: 'Edit then test', parameters: { type: 'object' },
    steps: [{ tool: edit.name, arguments: () => ({}) }, { tool: test.name, arguments: () => ({}) }],
  })
  return { edit, test, fusion }
}

// JSON escapes line breaks, so inspect the text blocks instead.
function resultText(request) {
  return request.messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'tool-result' && block.toolCallId === 'opt-1'
      ? block.content.flatMap(child => child.type === 'text' ? child.text : []) : [])).join('\n')
}

function assertPacking(requests) {
  const first = resultText(requests[1]), second = resultText(requests[2]), third = resultText(requests[3])
  if (first !== second || !third.includes('Observation stored') || third.length >= first.length / 5) {
    throw new Error('observation packing failed')
  }
}

async function assertReduction({ reduceEvidence, diagnosticLineNumbers }) {
  const log = 'ordinary compilation\n'.repeat(300) + 'FAIL fixture.ts:9\nUnstructured cause\nexit 1\n'
  const reduced = await reduceEvidence({ text: log, status: 'fail', signal: new AbortController().signal }, {
    async reduce(input) {
      const lines = input.text.split('\n')
      return { status: input.status,
        lines: diagnosticLineNumbers(input.text).map(line => ({ line, text: lines[line - 1] })) }
    },
  })
  if (!reduced.accepted || !reduced.text.includes('Unstructured cause')) throw new Error('evidence reducer failed')
}
