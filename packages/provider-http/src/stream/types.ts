import type { StreamChunk, UsageCounters } from '@alvin0/ai-agent-sdk-core'

/** Protocol output before untrusted usage crosses the transport validator. */
export type ProviderProtocolChunk =
  | Exclude<StreamChunk, { readonly type: 'usage' }>
  | { readonly type: 'usage'; readonly usage: UsageCounters }
