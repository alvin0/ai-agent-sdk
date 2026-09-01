import { libraryBuild } from '../../scripts/build-config.ts'

export default libraryBuild({
  entry: {
    index: 'src/index.ts',
    'skill-validation': 'src/skill/validation-export.ts',
  },
  runtime: 'universal',
})
