import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const originalProcess = globalThis.process
const originalBuffer = globalThis.Buffer
globalThis.process = undefined
globalThis.Buffer = undefined
const sdk = await import('ai-agent-sdk')
globalThis.process = originalProcess
globalThis.Buffer = originalBuffer

assert.equal(typeof sdk.ModelRegistry, 'function')
assert.equal(typeof sdk.defineAgent, 'function')
assert.equal(typeof sdk.createHttpProvider, 'function')
assert.equal('apiKeyFromEnv' in sdk, false)

const installed = (await readdir('node_modules/@ai-agent-sdk')).sort()
assert.deepEqual(installed, [
  'agent', 'core', 'protocol-anthropic-messages', 'protocol-responses', 'provider-http',
])
const manifest = JSON.parse(await readFile('node_modules/ai-agent-sdk/package.json', 'utf8'))
assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
  '@ai-agent-sdk/agent',
  '@ai-agent-sdk/core',
  '@ai-agent-sdk/protocol-anthropic-messages',
  '@ai-agent-sdk/protocol-responses',
  '@ai-agent-sdk/provider-http',
])
assert.equal(Object.values(manifest.peerDependenciesMeta).every(value => value.optional === true), true)
assert.equal(installed.some(name => /node|filesystem|a2a|mcp|observability/.test(name)), false)
console.log('sdk-root-only-packed:pass')
