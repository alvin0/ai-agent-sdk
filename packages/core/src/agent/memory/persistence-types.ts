import type { SdkLogger } from '../../logging/types.ts'
import type { AgentMemorySnapshot } from './memory.ts'

export interface MemoryStoreOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

export interface MemoryLoadResult {
  readonly snapshot: AgentMemorySnapshot
  readonly revision: string
}

export interface MemoryCommitInput {
  readonly key: string
  readonly snapshot: AgentMemorySnapshot
  readonly expectedRevision: string | null
}

export interface MemoryCommitResult { readonly revision: string }

export interface MemoryStore {
  readonly kind: 'memory-store'
  readonly apiVersion: 1
  readonly id: string
  readonly load: (key: string, options: MemoryStoreOptions) => Promise<MemoryLoadResult | undefined>
  readonly commit: (input: MemoryCommitInput, options: MemoryStoreOptions) => Promise<MemoryCommitResult>
}

export type MemoryStoreDefinition = Omit<MemoryStore, 'kind' | 'apiVersion'>

export type MemoryScope =
  | { readonly kind: 'conversation'; readonly namespace: string }
  | { readonly kind: 'fixed'; readonly key: string; readonly sharedAcrossSessions: true }

export interface MemoryBinding {
  readonly store: MemoryStore
  readonly bindingId: string
  readonly scope: MemoryScope
  readonly requirement: 'required' | 'best-effort'
}

export interface CapturedMemoryBinding extends MemoryBinding {}

export type MemoryLoadState =
  | { readonly status: 'loaded'; readonly snapshot: AgentMemorySnapshot; readonly revision: string }
  | { readonly status: 'not-found'; readonly revision: null }
  | { readonly status: 'disabled'; readonly error: Error }

export type MemoryCommitState =
  | { readonly status: 'committed'; readonly revision: string }
  | { readonly status: 'disabled'; readonly error: Error }

export interface RuntimeMemoryPersistence {
  readonly bindingId: string
  load(conversationId: string, signal: AbortSignal, logger: SdkLogger): Promise<MemoryLoadState>
  commit(
    conversationId: string,
    snapshot: AgentMemorySnapshot,
    expectedRevision: string | null,
    signal: AbortSignal,
    logger: SdkLogger,
  ): Promise<MemoryCommitState>
}
