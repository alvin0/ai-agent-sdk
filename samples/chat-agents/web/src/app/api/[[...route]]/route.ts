/**
 * Every `/api/*` request is forwarded to the Hono app that the backend package
 * owns. The Next.js layer keeps no request logic of its own.
 */

import { createChatApp } from '@chat-agents/backend'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Streaming responses must not be buffered by the route handler.
export const fetchCache = 'force-no-store'

const app = createChatApp('/api')

const handler = (request: Request): Response | Promise<Response> => app.fetch(request)

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
