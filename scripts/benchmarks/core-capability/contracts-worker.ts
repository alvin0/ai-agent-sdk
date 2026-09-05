/** Tree-shaken contract-only Worker entry for the proposed merged core. */

import { ModelRegistry, createOperationId, createTextMessage } from '@ai-agent-sdk/core'

export default {
  async fetch(): Promise<Response> {
    Reflect.set(globalThis, 'Buffer', undefined)
    Reflect.set(globalThis, 'process', undefined)
    const registry = new ModelRegistry()
    const message = createTextMessage('contract fixture')
    const globals = globalThis as unknown as Record<string, unknown>
    return Response.json({
      operationIdLength: createOperationId().length,
      providerCount: registry.listProviders().length,
      role: message.role,
      buffer: typeof globals.Buffer,
      process: typeof globals.process,
    })
  },
}
