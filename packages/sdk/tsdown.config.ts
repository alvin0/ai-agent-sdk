import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({
  runtime: 'universal',
  entry: {
    index: 'src/index.ts',
    anthropic: 'src/anthropic.ts',
    openai: 'src/openai.ts',
    codex: 'src/codex.ts',
    'a2a-client': 'src/a2a-client.ts',
    'a2a-server': 'src/a2a-server.ts',
    'skill-filesystem': 'src/skill-filesystem.ts',
    'request-logger': 'src/request-logger.ts',
    'mcp-client': 'src/mcp-client.ts',
    'mcp-server': 'src/mcp-server.ts',
    'mcp-node': 'src/mcp-node.ts',
    node: 'src/node.ts',
  },
})
