import { libraryBuild } from '../../scripts/build-config.ts'
export default libraryBuild({ entry: { index: 'src/index.ts', transport: 'src/transport.ts' }, runtime: 'universal' })
