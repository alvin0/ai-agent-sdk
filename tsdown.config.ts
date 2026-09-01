import { defineConfig } from 'tsdown'

/**
 * Separate entry points so a consumer that only talks to one provider never pays
 * for the other's wire code. The Node-only request logger is isolated too, keeping
 * the core and API-key provider entries usable on edge runtimes.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    anthropic: 'src/providers/anthropic/index.ts',
    openai: 'src/providers/openai/index.ts',
    codex: 'src/providers/codex/index.ts',
    'a2a-client': 'src/a2a-client.ts',
    'a2a-server': 'src/a2a-server.ts',
    'skill-filesystem': 'src/agent/skill/filesystem.ts',
    'request-logger': 'src/providers/request-logger.ts',
    'mcp-client': 'src/mcp-client.ts',
    'mcp-server': 'src/mcp-server.ts',
    'mcp-node': 'src/mcp-node.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  // Neutral so the core and the two API-key providers stay usable on edge
  // runtimes. The `codex` entry does touch the filesystem, but only through
  // dynamic imports that never execute unless its file-backed credential store
  // is actually used.
  platform: 'neutral',
  target: 'es2023',
  // Node builtins are genuinely external. Declaring them silences a resolver
  // warning that would otherwise appear on every build and train us to ignore
  // build output.
  deps: { neverBundle: [/^node:/] },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
})
