import type { AgentSessionOptions } from '@alvin0/ai-agent-sdk-core/agent'

export function snapshotSessionOptions(
  options: Omit<AgentSessionOptions, 'conversationId' | 'registry'>,
): Omit<AgentSessionOptions, 'conversationId' | 'registry'> {
  return Object.freeze({
    ...options,
    ...(options.historyLimits === undefined ? {} : {
      historyLimits: Object.freeze({ ...options.historyLimits }),
    }),
    ...(options.runtimeLimits === undefined ? {} : {
      runtimeLimits: Object.freeze({ ...options.runtimeLimits }),
    }),
    ...(Array.isArray(options.tools) ? { tools: Object.freeze([...options.tools]) } : {}),
    ...(options.skills === undefined ? {} : { skills: Object.freeze([...options.skills]) }),
    ...(options.interceptors === undefined ? {} : { interceptors: Object.freeze([...options.interceptors]) }),
    ...(options.hooks === undefined ? {} : { hooks: Object.freeze({ ...options.hooks }) }),
    ...(options.compaction === undefined || options.compaction === false
      ? {} : { compaction: Object.freeze({ ...options.compaction }) }),
    ...(options.trace === undefined ? {} : { trace: Object.freeze({ ...options.trace }) }),
    ...(options.team === undefined ? {} : { team: Object.freeze({ ...options.team }) }),
  })
}
