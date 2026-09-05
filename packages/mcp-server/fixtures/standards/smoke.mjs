void new Request('https://fixture.invalid')
void new Response()
void new Headers()
const hostBuffer = globalThis.Buffer
const hostProcess = globalThis.process
globalThis.Buffer = undefined
globalThis.process = undefined
const { runPackedMcpServerFixture } = await import('./fixture.mjs')
const importedWithoutNodeGlobals = typeof globalThis.Buffer === 'undefined' && typeof globalThis.process === 'undefined'
globalThis.Buffer = hostBuffer
globalThis.process = hostProcess
const result = await runPackedMcpServerFixture()
if (!result.inert || !result.discovered || !result.listed || !result.called
  || !result.requestBounded || !result.responseBounded || !result.aborted
  || !importedWithoutNodeGlobals || result.buffer !== 'function' || result.process !== 'object') {
  throw new Error(`invalid standards MCP server evidence: ${JSON.stringify(result)}`)
}
console.log('mcp-server-standards:pass')
