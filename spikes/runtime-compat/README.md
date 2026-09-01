# Runtime compatibility spike

This fixture tests package closures in an actual local Cloudflare Worker. It is not production code.

Prerequisite: build the current package so `dist/mcp-client.js` and `dist/mcp-server.js` exist.

```sh
npm run build
npm exec --yes --package=wrangler@4.127.1 -- \
  wrangler dev --config spikes/runtime-compat/wrangler.jsonc --ip 127.0.0.1 --port 8791
```

In another shell:

```sh
curl -fsS http://127.0.0.1:8791/runtime
curl -fsS http://127.0.0.1:8791/mcp
```

The MCP fixture explicitly sets `globalThis.Buffer` and `globalThis.process` to `undefined`. Expected results are `{"buffer":"undefined","process":"undefined"}` and a ready MCP HTTP connection.

Run the A2A fixture separately:

```sh
npm exec --yes --package=wrangler@4.127.1 -- \
  wrangler dev --config spikes/runtime-compat/wrangler-a2a.jsonc --ip 127.0.0.1 --port 8791
curl -fsS http://127.0.0.1:8791/a2a-text
curl -i http://127.0.0.1:8791/a2a-binary
```

At `@a2a-js/sdk@1.1.0`, text serialization succeeds but raw binary serialization fails because the upstream codec calls `Buffer.from`. This fixture therefore prevents the A2A package from being labelled Universal until that codec is replaced or fixed upstream.

Run the API-only OpenTelemetry fixture separately after installing the exact API packages used as development peers:

```sh
npm install --no-save --package-lock=false --ignore-scripts \
  @opentelemetry/api@1.9.1 @opentelemetry/api-logs@0.222.0
npm exec --yes --package=wrangler@4.127.1 -- \
  wrangler dev --config spikes/runtime-compat/wrangler-otel.jsonc --ip 127.0.0.1 --port 8791
curl -fsS http://127.0.0.1:8791/runtime
curl -fsS http://127.0.0.1:8791/otel
```

This fixture exercises caller-supplied tracer, meter, and logger API objects only. It does not prove that any concrete OpenTelemetry SDK or OTLP exporter is Universal; those remain host-selected dependencies.

`worker-baseline.mjs` records which Node-like globals the local Worker tool exposes before the strict fixtures remove them. It is diagnostic only and is not used as compatibility proof.
