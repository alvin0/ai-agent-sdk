import type {
  ModelCatalogOptions, ModelCatalogSnapshot, ModelInfo,
} from '../../contract/model-info.ts'
import type { RuntimeProviderInfo } from '../provider/types.ts'

export interface RuntimeModelCatalogSnapshot extends Omit<ModelCatalogSnapshot, 'provider'> {
  readonly provider: RuntimeProviderInfo
}

export interface ModelCatalogPolicy {
  readonly freshTtlMs?: number
  readonly staleTtlMs?: number
  readonly failureRetryMs?: number
  readonly maxFailureRetryMs?: number
}

export interface CapturedModelCatalogOptions extends ModelCatalogOptions {
  readonly refresh: 'if-stale' | 'force'
}

export interface PublishedCatalog {
  readonly snapshot: RuntimeModelCatalogSnapshot
  readonly observedMs: number
  readonly expiresMs?: number
}

export interface CatalogGeneration {
  readonly state: 'static' | 'fresh' | 'empty'
  readonly models: readonly ModelInfo[]
}
