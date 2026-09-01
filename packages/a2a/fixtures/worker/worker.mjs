import { Message, Role } from '@a2a-js/sdk'
import { A2AAgentLink } from '@ai-agent-sdk/a2a/client'

export default {
  fetch(request) {
    globalThis.Buffer = undefined
    globalThis.process = undefined
    const path = new URL(request.url).pathname
    if (path === '/runtime') return Response.json({
      buffer: typeof globalThis.Buffer,
      process: typeof globalThis.process,
      packageLoaded: typeof A2AAgentLink === 'function',
    })
    if (path === '/text') return Response.json(Message.toJSON(message({ $case: 'text', value: 'hello' }, 'text/plain')))
    if (path === '/binary') {
      try {
        const value = Message.toJSON(message({ $case: 'raw', value: new Uint8Array([1, 2, 3]) }, 'application/octet-stream'))
        return Response.json({ promotionCandidate: true, value })
      } catch (error) {
        return Response.json({
          guard: 'expected-node-elevation',
          errorType: error instanceof Error ? error.name : typeof error,
        }, { status: 500 })
      }
    }
    return Response.json({ routes: ['/runtime', '/text', '/binary'] })
  },
}

function message(content, mediaType) {
  return {
    messageId: 'worker-message', contextId: '', taskId: '', role: Role.ROLE_USER,
    parts: [{ content, mediaType, filename: '', metadata: undefined }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  }
}
