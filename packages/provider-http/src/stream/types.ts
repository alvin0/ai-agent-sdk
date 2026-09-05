import type { StreamChunk, UsageCounters } from '@ai-agent-sdk/core'

/** Protocol output before untrusted usage crosses the transport validator. */
export type ProviderProtocolChunk =
  | Exclude<StreamChunk, { readonly type: 'usage' }>
  | { readonly type: 'usage'; readonly usage: UsageCounters }
