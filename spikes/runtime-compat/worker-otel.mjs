import { SpanStatusCode, metrics, trace } from '@opentelemetry/api'
import { SeverityNumber, logs } from '@opentelemetry/api-logs'

export default {
  fetch(request) {
    stripNodeGlobals()
    const pathname = new URL(request.url).pathname
    if (pathname === '/runtime') {
      return Response.json({
        buffer: typeof globalThis.Buffer,
        process: typeof globalThis.process,
      })
    }
    if (pathname === '/otel') return Response.json(runApiOnlyBridge())
    return Response.json({ routes: ['/runtime', '/otel'] })
  },
}

function stripNodeGlobals() {
  globalThis.Buffer = undefined
  globalThis.process = undefined
}

function runApiOnlyBridge() {
  const tracer = trace.getTracer('runtime-spike')
  const span = tracer.startSpan('sdk.model.call')
  span.setStatus({ code: SpanStatusCode.OK })
  span.end()

  const meter = metrics.getMeter('runtime-spike')
  meter.createCounter('ai_agent_sdk.token.usage').add(1, { type: 'input' })

  const logger = logs.getLogger('runtime-spike')
  logger.emit({ severityNumber: SeverityNumber.INFO, body: 'metadata-only' })

  return {
    status: 'ready',
    tracer: typeof tracer.startSpan,
    meter: typeof meter.createCounter,
    logger: typeof logger.emit,
  }
}
