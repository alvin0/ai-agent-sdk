/**
 * Every `/api/*` request is forwarded to the Hono app. The Next.js layer keeps
 * no request logic of its own.
 */

// First, so the sandbox has the web API the SDK expects before it asks.
import '../../../server/polyfill'
import { createEdgeChatApp } from '../../../server/app'

// The whole backend is web-standards only, so it runs on the Edge runtime.
export const runtime = 'edge'
export const dynamic = 'force-dynamic'
// Streaming responses must not be buffered by the route handler.
export const fetchCache = 'force-no-store'

const app = createEdgeChatApp('/api')

const handler = (request: Request): Response | Promise<Response> => app.fetch(request)

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
