import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'

const directory = resolve('.agents/skills/packed-skill')
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, 'SKILL.md'), [
  '---', 'name: packed-skill', 'description: Proves packed Node discovery.', '---',
  'Follow the packed workflow.', '',
].join('\n'))
const provider = fileSystemSkills({ cwd: process.cwd(), includeUserAgents: false })
const candidates = await provider.list({})
const candidate = candidates.find(value => value.id === 'packed-skill')
if (candidate === undefined) throw new Error('packed skill was not discovered')
const loaded = await provider.load(candidate, {})
if (!loaded?.instructions.includes('packed workflow')) throw new Error('packed skill was not loaded')
console.log('skill-filesystem-packed:pass')
