import type { SdkLogger } from '../../logging/types.ts'
import type { ToolDefinition } from './definition.ts'

export interface ToolCatalogSnapshot {
  readonly revision: string
  readonly tools: readonly ToolDefinition[]
}

export interface ToolSourceSnapshotOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

export interface ToolSource {
  readonly kind: 'tool-source'
  readonly apiVersion: 1
  readonly id: string
  readonly snapshot: (options: ToolSourceSnapshotOptions) => ToolCatalogSnapshot
}

export type ToolSourceDefinition = Omit<ToolSource, 'kind' | 'apiVersion'>
export interface CapturedToolSource extends ToolSource {}

export interface ToolSourceRunReference {
  readonly sourceId: string
  readonly revision: string
}

export interface ToolSourceRunSnapshot {
  readonly tools: readonly ToolDefinition[]
  readonly references: readonly ToolSourceRunReference[]
}
