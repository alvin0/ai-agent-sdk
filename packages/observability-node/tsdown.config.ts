import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({
  entry: {
    index: 'src/index.ts',
    journal: 'src/journal-export.ts',
    diagnostic: 'src/diagnostic.ts',
  },
  runtime: 'node',
})
