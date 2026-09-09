import type { JsonValue } from '../../../primitives/index.ts'
import type { SdkLogger } from '../../../logging/types.ts'
import type {
  SkillDefinition, SkillDefinitionInput, SkillInvocationPolicy, SkillLookupOptions,
  SkillProvider, SkillResourceBase,
} from '../definition.ts'
import type { SKILL_PROVIDER_API_VERSION } from './config.ts'

export interface RuntimeSkillCandidate {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation?: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly locator?: JsonValue
}

export interface SkillCatalogSnapshot {
  readonly revision: string
  readonly candidates: readonly RuntimeSkillCandidate[]
}

export interface SkillReference {
  readonly id: string
  readonly source: string
  readonly provider: string
  readonly catalogRevision: string
  readonly locator?: JsonValue
}

export interface ActivatedSkillSnapshot extends SkillReference {
  readonly resourceBase?: SkillResourceBase
}

export type RuntimeSkillLookupOptions = Omit<SkillLookupOptions, 'signal'> & {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

export interface SkillProviderPlugin {
  readonly kind: 'skill-provider'
  readonly apiVersion: typeof SKILL_PROVIDER_API_VERSION
  readonly id: string
  readonly list: (options: RuntimeSkillLookupOptions & {
    readonly allowedSkillIds?: readonly string[]
  }) => Promise<SkillCatalogSnapshot>
  readonly load: (
    reference: SkillReference,
    options: RuntimeSkillLookupOptions,
  ) => Promise<SkillDefinitionInput | undefined>
  readonly readResource?: (
    reference: SkillReference,
    path: string,
    options: RuntimeSkillLookupOptions,
  ) => Promise<string | undefined>
}

export type SkillProviderPluginDefinition = Omit<SkillProviderPlugin, 'kind' | 'apiVersion'>
export type SkillProviderDefinition = SkillProviderPluginDefinition
export interface CapturedSkillProviderPlugin extends SkillProviderPlugin {}
export type RuntimeSkillSource = SkillDefinition | SkillProvider | SkillProviderPlugin
