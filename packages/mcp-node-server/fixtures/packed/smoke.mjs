import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
})
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
let stderr = ''
child.stderr.on('data', chunk => { stderr += String(chunk) })

function request(message) {
  const response = new Promise((resolve, reject) => {
    const onLine = line => {
      cleanup()
      try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
    }
    const onExit = code => { cleanup(); reject(new Error(`server exited early with ${code}: ${stderr}`)) }
    const cleanup = () => {
      lines.off('line', onLine)
      child.off('exit', onExit)
    }
    lines.once('line', onLine)
    child.once('exit', onExit)
  })
  child.stdin.write(`${JSON.stringify(message)}\n`)
  return response
}

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'packed-fixture', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const discovery = await request({
  jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: { _meta: meta },
})
if (!discovery.result?.supportedVersions?.includes('2026-07-28')) {
  throw new Error(`MCP discovery failed: ${JSON.stringify(discovery)}`)
}
const list = await request({
  jsonrpc: '2.0', id: 'list', method: 'tools/list', params: { _meta: meta },
})
if (list.result?.tools?.[0]?.name !== 'add') {
  throw new Error(`MCP tools/list failed: ${JSON.stringify(list)}`)
}
const called = await request({
  jsonrpc: '2.0', id: 'call', method: 'tools/call',
  params: { name: 'add', arguments: { left: 20, right: 22 }, _meta: meta },
})
if (called.result?.structuredContent?.sum !== 42) {
  throw new Error(`MCP tools/call failed: ${JSON.stringify(called)}`)
}

child.kill('SIGTERM')
child.stdin.end()
const exitCode = await Promise.race([
  new Promise(resolve => child.once('exit', resolve)),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`server close timed out: ${stderr}`)), 5_000)),
])
if (exitCode !== 0 || !stderr.includes('MCP_CLOSE_REPORT')) {
  throw new Error(`MCP server close evidence missing: exit=${exitCode}; stderr=${stderr}`)
}
const reportText = stderr.slice(stderr.indexOf('MCP_CLOSE_REPORT ') + 'MCP_CLOSE_REPORT '.length).trim()
const report = JSON.parse(reportText)
if (report.state !== 'closed' || report.deadlineReached || report.unsettledRequests !== 0 || report.error) {
  throw new Error(`invalid MCP server close report: ${reportText}`)
}
console.log('mcp-node-server-packed:pass')
