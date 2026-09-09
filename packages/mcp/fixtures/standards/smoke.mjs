// Node lazily initializes its built-in Web HTTP implementation through an
// internal Buffer-backed Undici bootstrap. Warm only the host Web APIs before
// removing Node globals; the package itself is imported afterwards.
void new Request('https://fixture.invalid')
void new Response()
void new Headers()
const hostBuffer = globalThis.Buffer
const hostProcess = globalThis.process
globalThis.Buffer = undefined
globalThis.process = undefined
const { runPackedMcpFixture } = await import('./fixture.mjs')
const importedWithoutNodeGlobals = typeof globalThis.Buffer === 'undefined' && typeof globalThis.process === 'undefined'
globalThis.Buffer = hostBuffer
globalThis.process = hostProcess
const result = await runPackedMcpFixture()
if (!result.ready || !result.listed || !result.called || result.sum !== 42 || !result.aborted
  || !result.authFailed || !result.authObserved || !result.boundedFailure
  || !importedWithoutNodeGlobals || result.buffer !== 'function' || result.process !== 'object') {
  throw new Error(`invalid standards MCP evidence: ${JSON.stringify(result)}`)
}
console.log('mcp-standards:pass')
