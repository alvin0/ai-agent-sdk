import { fileURLToPath } from 'node:url'
import { runNodeChecks } from './run-node-checks.mjs'

const eslintBin = fileURLToPath(new URL('../bin/eslint.js', import.meta.resolve('eslint')))
process.exitCode = runNodeChecks([
  ['ESLint', [eslintBin, 'packages', '--max-warnings', '0']],
  ['Package graph', ['scripts/check-package-graph.mts']],
  ['Dependency cruiser', ['scripts/check-dependency-cruiser.mts']],
  ['Agent boundaries', ['scripts/check-agent-boundaries.mts']],
  ['Runtime boundaries', ['scripts/check-runtime-boundaries.mts']],
])
