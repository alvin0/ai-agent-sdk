# MCP round-trip human test

Run:

```powershell
pnpm human:mcp
pnpm human:mcp -- --requests 128 --parallel 32 --cycles 4 --run-id mcp-stress-local
```

The command performs a real MCP handshake over the official in-memory transport:

```text
SDK quote_inventory tool
  -> SDK MCP server
  -> initialize + tools/list
  -> namespaced SDK client tool (mcp__warehouse__quote_inventory)
  -> tools/call
  -> SDK tool pipeline
  -> structured result back to the caller
```

No model or provider credentials are required. This isolates MCP lifecycle,
schema translation, tool discovery, namespacing, error handling, and result
translation. HTTP and stdio use the same connection supervisor and bridges; only
their transport factory differs.

The workload mixes valid quotes, unknown SKUs, and stock-limit errors. Every run,
including `--dry-run`, writes bounded support-safe evidence under
`test-human/results/mcp/<run-id>/`.
