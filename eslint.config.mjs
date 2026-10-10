import stylistic from '@stylistic/eslint-plugin'
import tsParser from './scripts/eslint-tooling/parser.mjs'
import sonarjs from 'eslint-plugin-sonarjs'
import testFunctionLength from './scripts/eslint-tooling/test-function-length.mjs'

const appRoots = ['samples/*/*', 'web-documents', 'website']
const appOutputs = [
  '.next', '.next-*', '.cache', '.parcel-cache', '.wrangler', '.playwright-cli',
  '.vite', '.vitepress/cache', '.vitepress/dist', '.nuxt', '.output', '.svelte-kit',
  '.docusaurus', 'dist', 'out', 'build', 'coverage',
]
const functionLengthOptions = { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }

export default [
  {
    name: 'workspace/generated-and-external-files',
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'dist-cli/**',
      'coverage/**',
      'artifacts/**',
      'packages/*/dist/**',
      'packages/*/coverage/**',
      'packages/*/artifacts/**',
      '.git/**',
      '.codegraph/**',
      '.providers/**',
      '.temp/**',
      '.turbo/**',
      '.cache/**',
      '.pnpm-store/**',
      '.playwright-cli/**',
      '.nyc_output/**',
      '.yarn/**',
      ...appRoots.flatMap(root => appOutputs.map(output => `${root}/${output}/**`)),
      ...appRoots.map(root => `${root}/next-env.d.ts`),
      'tests/negative-fixtures/**',
      'test-human/output/**',
      'test-human/results/**',
      'test-human/workspaces/**',
    ],
  },
  {
    name: 'workspace/maintainability',
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { noInlineConfig: true },
    plugins: {
      '@stylistic': stylistic,
      sonarjs,
      workspace: { rules: { 'max-lines-per-test-function': testFunctionLength } },
    },
    rules: {
      complexity: ['error', { max: 10, variant: 'classic' }],
      'sonarjs/cognitive-complexity': ['error', 15],
      // Count every physical line, including comments and whitespace.
      'max-lines': ['error', { max: 400, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': ['error', functionLengthOptions],
      // Also catch dense functions with several statements on one line.
      'max-statements': ['error', { max: 30 }, { ignoreTopLevelFunctions: false }],
      'max-depth': ['error', 4],
      'max-nested-callbacks': ['error', 3],
      'max-params': ['error', { max: 4, countThis: 'never' }],
      'no-nested-ternary': 'error',
      '@stylistic/max-len': ['error', {
        code: 120,
        comments: 120,
        tabWidth: 2,
        ignoreComments: false,
        ignoreTrailingComments: false,
        ignoreUrls: false,
        ignoreStrings: false,
        ignoreTemplateLiterals: false,
        ignoreRegExpLiterals: false,
      }],
    },
  },
  {
    name: 'workspace/test-suite-registration',
    files: [
      'tests/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
      '**/*.{spec,test}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
      'packages/*/tests/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
      'packages/*/test/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
    ],
    rules: {
      'max-lines-per-function': 'off',
      'workspace/max-lines-per-test-function': ['error', functionLengthOptions],
    },
  },
  {
    name: 'workspace/typescript-syntax',
    files: ['**/*.{ts,mts,cts,tsx}'],
    languageOptions: { parser: tsParser },
  },
]
