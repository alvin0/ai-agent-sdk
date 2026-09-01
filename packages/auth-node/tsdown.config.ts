import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({
  entry: { index: 'src/index.ts', env: 'src/env.ts', codex: 'src/codex.ts', cli: 'src/cli.ts' },
  runtime: 'node',
})
