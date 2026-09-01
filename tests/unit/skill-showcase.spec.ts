import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSkillStressSourceLock } from '../../test-human/skill-stress/sources.ts'
import {
  EXTERNAL_SKILL_ID,
  SHOWCASE_SKILL_LOCK,
  verifyGeneratedWebsite,
} from '../../test-human/skill-showcase/runner.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('external skill website showcase', () => {
  it('pins a hash-verified skills.sh source rather than a locally authored SKILL', async () => {
    const lock = await readSkillStressSourceLock(SHOWCASE_SKILL_LOCK)
    expect(lock.sources).toHaveLength(1)
    expect(lock.sources[0]).toMatchObject({
      id: EXTERNAL_SKILL_ID,
      skill: EXTERNAL_SKILL_ID,
      revision: '3b3fad96af16a10759d930941b4520ba0c40edae',
      computedHash: '4eabc66183767153e404b39d1b839b1c37f2d82d86f0a0d7e880a579d8d62336',
      fileCount: 2,
      registry: 'https://skills.sh/anthropics/skills/frontend-design',
    })
  })

  it('applies host-owned behavioral checks to the generated artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-skill-showcase-'))
    cleanup.push(root)
    await mkdir(join(root, 'tests'), { recursive: true })
    await Promise.all([
      writeFile(join(root, 'index.html'), [
        '<main><h1>Nocturne Rail</h1><p>Bangkok to Chiang Mai cabin comparison</p>',
        '<form><label>Departure<select><option>20:10</option></select></label></form></main>',
      ].join(''), 'utf8'),
      writeFile(join(root, 'styles.css'), [
        ':root{--ink:#14213d;--paper:#f7f3e8;--rail:#b23a48;--brass:#ca9b43}',
        'button:focus-visible{outline:2px solid var(--rail)}',
        '@media(max-width:600px){main{display:block}}',
        '@media(prefers-reduced-motion:reduce){*{animation:none}}',
      ].join('\n'), 'utf8'),
      writeFile(join(root, 'app.js'), [
        "localStorage.getItem('departure')", "localStorage.setItem('departure','20:10')",
        "document.querySelector('form').addEventListener('submit',()=>{})",
      ].join('\n'), 'utf8'),
      writeFile(join(root, 'server.mjs'), "import { createServer } from 'node:http'\ncreateServer(()=>{}).listen(4173)\n", 'utf8'),
      writeFile(join(root, 'package.json'), '{"scripts":{"start":"node server.mjs","test":"node --test tests/site.test.mjs"}}', 'utf8'),
      writeFile(join(root, 'tests', 'site.test.mjs'), "import test from 'node:test'\ntest('site',()=>{})\n", 'utf8'),
      writeFile(join(root, 'design-rationale.md'), [
        '# Palette and color', '# Typography', '# Layout', '# Signature element',
        '# Critique and revision', 'Removed a generic card treatment after critique.',
      ].join('\n'), 'utf8'),
    ])

    const checks = await verifyGeneratedWebsite(root)
    expect(checks.every(check => check.passed)).toBe(true)
  })
})
