import { Message, Role } from '@a2a-js/sdk'

export default {
  fetch(request) {
    stripNodeGlobals()
    const pathname = new URL(request.url).pathname
    if (pathname === '/runtime') {
      return Response.json({
        buffer: typeof globalThis.Buffer,
        process: typeof globalThis.process,
      })
    }
    if (pathname === '/a2a-text') {
      return Response.json(Message.toJSON(messageWith({ $case: 'text', value: 'hello' }, 'text/plain')))
    }
    if (pathname === '/a2a-binary') {
      return Response.json(Message.toJSON(messageWith(
        { $case: 'raw', value: new Uint8Array([1, 2, 3]) },
        'application/octet-stream',
      )))
    }
    return Response.json({ routes: ['/runtime', '/a2a-text', '/a2a-binary'] })
  },
}

function stripNodeGlobals() {
  globalThis.Buffer = undefined
  globalThis.process = undefined
}

function messageWith(content, mediaType) {
  return {
    messageId: 'runtime-spike-message',
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [{ content, filename: '', mediaType, metadata: undefined }],
    metadata: undefined,
    extensions: [],
  }
}
