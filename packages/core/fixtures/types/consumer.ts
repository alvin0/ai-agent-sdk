import {
  ModelAdapter, defineCredentialSource, defineModelProviderPlugin,
  type CredentialOperationOptions, type SdkLogger as ProviderLogger,
} from '@ai-agent-sdk/core/provider'
import {
  defineToolSource, type SdkLogger as ToolLogger, type ToolSourceSnapshotOptions,
} from '@ai-agent-sdk/core/tools'
import {
  defineSkillProviderPlugin, type RuntimeSkillLookupOptions, type SdkLogger as SkillLogger,
} from '@ai-agent-sdk/core/skills'
import {
  defineMemoryStore, type MemoryStoreOptions, type SdkLogger as MemoryLogger,
} from '@ai-agent-sdk/core/memory'

declare const adapter: ModelAdapter
const useLogger = (_logger: ProviderLogger | ToolLogger | SkillLogger | MemoryLogger): void => undefined

defineModelProviderPlugin({
  id: 'third-party-provider', displayName: 'Third-party provider', routes: ['third-party'],
  setup(registrar) {
    useLogger(registrar.logger)
    registrar.registerAdapter(adapter)
    return undefined
  },
})

defineCredentialSource({
  id: 'third-party-credential',
  resolve(options: CredentialOperationOptions) {
    useLogger(options.logger)
    options.signal.throwIfAborted()
    return 'opaque'
  },
})

defineToolSource({
  id: 'third-party-tools',
  snapshot(options: ToolSourceSnapshotOptions) {
    useLogger(options.logger)
    options.signal.throwIfAborted()
    return { revision: 'v1', tools: [] }
  },
})

defineSkillProviderPlugin({
  id: 'third-party-skills',
  async list(options: RuntimeSkillLookupOptions) {
    useLogger(options.logger)
    options.signal.throwIfAborted()
    return { revision: 'v1', candidates: [] }
  },
  async load(_reference, options) {
    useLogger(options.logger)
    return undefined
  },
})

defineMemoryStore({
  id: 'third-party-memory',
  async load(_key, options: MemoryStoreOptions) {
    useLogger(options.logger)
    options.signal.throwIfAborted()
    return undefined
  },
  async commit(_input, options) {
    useLogger(options.logger)
    return { revision: 'v1' }
  },
})
