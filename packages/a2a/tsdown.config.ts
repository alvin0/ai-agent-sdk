import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({
  entry: { index: 'src/index.ts', client: 'src/client.ts', server: 'src/server.ts' },
  runtime: 'node',
})
