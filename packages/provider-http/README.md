# @ai-agent-sdk/provider-http

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-http
```

Universal fetch/SSE transport, configurable HTTP providers, resource bounds, and physical provider-attempt accounting. Credentials are supplied explicitly; this package never reads environment variables or files.

This package is the sole direct owner of exact `eventsource-parser@4.1.0`. The
pre-1.0 owned-parser qualification retained that pin because the candidate failed
the mandatory throughput gate; see [ADR 0001](../../docs/adr/0001-eventsource-parser-ownership.md).
