import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({
  entry: {
    index: 'src/index.ts', core: 'src/core.ts', agent: 'src/agent.ts',
    providers: 'src/providers.ts', observability: 'src/observability.ts',
    filesystem: 'src/filesystem.ts', mcp: 'src/mcp.ts', a2a: 'src/a2a.ts',
    env: 'src/env.ts', codex: 'src/codex.ts',
  },
  runtime: 'node',
})
