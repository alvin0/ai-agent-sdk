import type { SdkStressScenario } from '../types.ts'
import { agentToolPressure } from './agent-tool-pressure.ts'
import { filesystemSkillPressure } from './filesystem-skill-pressure.ts'
import { mcpConcurrencyPressure } from './mcp-concurrency-pressure.ts'
import { observabilityPressure } from './observability-pressure.ts'
import { pluginRetryPressure } from './plugin-retry-pressure.ts'
import { streamAssemblyPressure } from './stream-assembly-pressure.ts'

export function sdkStressScenarios(): readonly SdkStressScenario[] {
  return Object.freeze([
    {
      id: 'stream-assembly-pressure',
      description: 'Randomized chunk partitioning, authoritative closes, replay alignment, and max-token tool safety.',
      weight: 4,
      run: streamAssemblyPressure,
    },
    {
      id: 'agent-tool-pressure',
      description: 'Many isolated multi-step agent runs with parallel tools, contained failures, trace closure, memory, and missing usage.',
      run: agentToolPressure,
    },
    {
      id: 'plugin-retry-pressure',
      description: 'Transactional provider install failures, retry recovery, update notifications, cleanup idempotency, and topology leak checks.',
      weight: 2,
      run: pluginRetryPressure,
    },
    {
      id: 'observability-pressure',
      description: 'Queue eviction, privacy-before-export, batching, health callback containment, and exporter failure reporting.',
      run: observabilityPressure,
    },
    {
      id: 'filesystem-skill-pressure',
      description: 'High-cardinality lazy skill discovery, selected activation, resources, hot edits, cancellation, and symlink escape defense.',
      run: filesystemSkillPressure,
    },
    {
      id: 'mcp-concurrency-pressure',
      description: 'Repeated real MCP handshakes and concurrent success/error tool calls across the SDK bridge.',
      run: mcpConcurrencyPressure,
    },
  ])
}
