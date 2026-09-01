import { defineConfig } from 'tsdown'

/** Build every executable acceptance/developer CLI to JavaScript before use. */
export default defineConfig({
  entry: {
    human: 'test-human/cli.ts',
    'provider-codex-login-device': 'scripts/provider-codex-login-device.ts',
    'agentcode': 'test-human/agentcode/cli.ts',
    'agentcode-multi-skill': 'test-human/agentcode/multi-skill/cli.ts',
    'agentcode-multi-skill-verify': 'test-human/agentcode/multi-skill/reverify.ts',
    'a2a-managed': 'test-human/a2a-stress/managed.ts',
    'a2a-defined': 'test-human/a2a-stress/defined.ts',
    'skill-stress': 'test-human/skill-stress/cli.ts',
    'skill-stress-prepare': 'test-human/skill-stress/prepare.ts',
    'skill-showcase': 'test-human/skill-showcase/cli.ts',
    mcp: 'test-human/mcp/cli.ts',
    'mcp-github': 'test-human/github-mcp/cli.ts',
  },
  outDir: 'dist-cli',
  format: ['esm'],
  platform: 'node',
  target: 'node22.12',
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
})
