/** Batteries-included Node facade. Importing this entry intentionally elevates runtime to Node. */

import * as universalMcp from '@ai-agent-sdk/mcp'
import * as nodeMcp from '@ai-agent-sdk/mcp-node'

export * from './core.ts'
export * from './agent.ts'
export * from './providers.ts'
export * from './observability.ts'
export * from './filesystem.ts'
export * from './env.ts'

/** Secondary protocol ecosystems are namespaced to keep core message types unambiguous. */
export const mcp = Object.freeze({ ...universalMcp, ...nodeMcp })
export * as a2a from '@ai-agent-sdk/a2a'
