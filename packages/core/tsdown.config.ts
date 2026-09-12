import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({
  entry: {
    index: 'src/index.ts',
    observability: 'src/observability/index.ts',
    embedding: 'src/embedding/index.ts',
    agent: 'src/agent-public.ts',
    memory: 'src/memory.ts',
    provider: 'src/provider.ts',
    skills: 'src/skills.ts',
    tools: 'src/tools.ts',
  },
  runtime: 'universal',
  minify: true,
  unbundle: true,
  root: 'src',
})
