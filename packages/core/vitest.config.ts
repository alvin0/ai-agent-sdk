import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/composition/**/*.spec.ts',
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
      '../../tests/unit/trace.spec.ts',
      '../../tests/unit/observability.spec.ts',
      '../../tests/unit/assembler.spec.ts',
      '../../tests/unit/idle-timeout.spec.ts',
      '../../tests/unit/observation-core.spec.ts',
      '../../tests/unit/provider-plugin.spec.ts',
      '../../tests/unit/registry.spec.ts',
      '../../tests/unit/retry-policy.spec.ts',
      '../../tests/unit/usage-accounting.spec.ts',
      '../../tests/unit/with-retry.spec.ts'
    ]
  }
})
