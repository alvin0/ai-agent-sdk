import { overflowEvidence } from './shared/overflow.js'
import { logicReviewEvidence } from './shared/logic-review.js'
import { providerTopologyEvidence } from './shared/provider-topology.js'

export default {
  async fetch() {
    globalThis.Buffer = undefined
    globalThis.process = undefined
    const { ModelAdapter, ModelRegistry, createAgentRuntime, createTraceId } = await import('@ai-agent-sdk/core')
    class FixtureAdapter extends ModelAdapter {
      stream() {
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new FixtureAdapter())
    const call = registry.stream({ provider: 'fixture', model: 'model', messages: [] })
    for await (const _chunk of call) { /* drain */ }
    const report = await call.report
    return Response.json({
      traceId: createTraceId(),
      status: report.status,
      totalTokens: report.reported.totalTokens,
      buffer: typeof globalThis.Buffer,
      process: typeof globalThis.process,
      overflow: await overflowEvidence({ ModelAdapter, ModelRegistry }),
      logic: await logicReviewEvidence({ ModelAdapter, createAgentRuntime }),
      topology: await providerTopologyEvidence({ ModelAdapter, createAgentRuntime }),
    })
  },
}
