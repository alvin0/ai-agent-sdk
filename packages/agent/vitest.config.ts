import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@ai-agent-sdk/agent': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/agent-definition.spec.ts',
      '../../tests/unit/agent-modes.spec.ts',
      '../../tests/unit/agent-run-handle.spec.ts',
      '../../tests/unit/history.spec.ts',
      '../../tests/unit/memory-compaction.spec.ts',
      '../../tests/unit/run-ledger.spec.ts',
      '../../tests/unit/skill.spec.ts',
      '../../tests/unit/team.spec.ts',
      '../../tests/unit/team-concepts.spec.ts',
      '../../tests/unit/tool-loop.spec.ts',
      '../../tests/unit/tool-pipeline.spec.ts',
      '../../tests/unit/tool-registry.spec.ts',
      '../../tests/unit/trace.spec.ts'
    ]
  }
})
