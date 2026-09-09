import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({ entry: { index: 'src/index.ts' }, runtime: 'node' })
