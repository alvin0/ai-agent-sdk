import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@alvin0/ai-agent-sdk-auth-node/env': new URL('./src/env.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-auth-node/codex': new URL('./src/codex.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-auth-node/copilot': new URL('./src/copilot.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-auth-node': new URL('./src/index.ts', import.meta.url).pathname,
  } },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/auth-node.spec.ts',
      '../../tests/unit/copilot-auth-path.spec.ts',
      '../../tests/unit/copilot-auth-file-store.spec.ts',
      '../../tests/unit/copilot-login-cli.spec.ts',
    ],
  },
})
