# @ai-agent-sdk/observability-otel

Runtime: **Universal** (the caller chooses runtime-compatible OpenTelemetry APIs).

```sh
pnpm add @ai-agent-sdk/observability @ai-agent-sdk/observability-otel @opentelemetry/api @opentelemetry/api-logs
```

Universal mapping bridge for caller-supplied OpenTelemetry API objects. It
creates real spans synchronously, keeps explicit parent contexts without
ambient context or `AsyncLocalStorage`, and maps privacy-processed SDK events
to spans, metrics, and optional logs.

The package installs no global provider, owns no SDK or OTLP exporter, performs
no network I/O, and never claims telemetry delivery. Configure a journal or an
acknowledged exporter separately when delivery guarantees are required.

Content attributes remain disabled by default. Mapping prompt/completion bodies
requires the explicit bridge option `content: 'full'` and the same policy on the
SDK observability bus.

```ts
import { createObservability } from '@ai-agent-sdk/observability'
import { createOpenTelemetryBridge } from '@ai-agent-sdk/observability-otel'

const bridge = createOpenTelemetryBridge({
  tracer: tracerProvider.getTracer('my-agent'),
  meter: meterProvider.getMeter('my-agent'),
  // logger: loggerProvider.getLogger('my-agent'),
})

const observation = createObservability({
  openSpan: bridge.openSpan,
  processors: [bridge.processor],
})
```

Pass `observation` to the SDK core/agent entry point. The application keeps
ownership of provider registration, processors, exporters, flushing, and
shutdown. If `content: 'full'` is enabled on the bridge, enable the same policy
on `createObservability`; every other policy omits prompt and completion bodies.
