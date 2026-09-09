import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  fileSystemSkillProviderPlugin,
  fileSystemSkills,
} from '@alvin0/ai-agent-sdk-skill-filesystem'

const directory = resolve('.agents/skills/packed-skill')
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, 'SKILL.md'), [
  '---', 'name: packed-skill', 'description: Proves packed Node discovery.', '---',
  'Follow the packed workflow.', '',
].join('\n'))
const advanced = fileSystemSkills({ cwd: process.cwd(), includeUserAgents: false })
const candidates = await advanced.list({})
const candidate = candidates.find(value => value.id === 'packed-skill')
if (candidate === undefined) throw new Error('packed skill was not discovered')
const loaded = await advanced.load(candidate, {})
if (!loaded?.instructions.includes('packed workflow')) throw new Error('packed skill was not loaded')

const logger = {
  child: () => logger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
}
const plugin = fileSystemSkillProviderPlugin({ cwd: process.cwd(), includeUserAgents: false })
const catalog = await plugin.list({ signal: new AbortController().signal, logger })
const row = catalog.candidates.find(value => value.id === 'packed-skill')
if (plugin.apiVersion !== 1 || row === undefined || catalog.revision.length !== 64) {
  throw new Error('versioned filesystem skill plugin failed')
}
const pluginLoaded = await plugin.load({
  id: row.id, source: row.source, provider: row.provider,
  catalogRevision: catalog.revision, locator: row.locator,
}, { signal: new AbortController().signal, logger })
if (!pluginLoaded?.instructions.includes('packed workflow')) {
  throw new Error('versioned filesystem skill activation failed')
}
console.log('skill-filesystem-packed:pass')
