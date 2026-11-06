/** Node HTTP/2 transport: a `fetch` that multiplexes concurrent requests on shared sessions. */
export { createNodeHttp2Fetch, type NodeHttp2Fetch, type NodeHttp2FetchOptions } from './http2/fetch.ts'
