import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createProjectInstructionsSection } from '@ai-agent-sdk/instructions-node'

const nested = resolve('packages/api')
await mkdir(resolve('.git'), { recursive: true })
await mkdir(nested, { recursive: true })
await writeFile(resolve('AGENTS.md'), 'Root rule.\n')
await writeFile(resolve(nested, 'AGENTS.md'), 'API rule.\n')

const section = createProjectInstructionsSection({ cwd: process.cwd() })
const input = { signal: new AbortController().signal, step: 0, touches: [], current: undefined }
const first = await section.resolve(input)
if (first === undefined || !first.text.includes('Root rule.')) {
  throw new Error('packed instruction discovery failed')
}
if (first.text.includes('API rule.')) throw new Error('packed discovery leaked a nested file')

const second = await section.resolve({
  ...input, step: 1, current: first,
  touches: [{
    toolName: 'read',
    rawArguments: JSON.stringify({ file_path: resolve(nested, 'handler.ts') }),
    failed: false,
  }],
})
if (second === undefined || !second.text.includes('API rule.')) {
  throw new Error('packed nested discovery failed')
}
if (second.revision === first.revision) throw new Error('packed revision did not change')

const third = await section.resolve({ ...input, step: 2, current: second })
if (third?.revision !== second.revision) throw new Error('packed revision was not stable')

console.log('instructions-node-packed:pass')
