import { describe, expect, it } from 'vitest'
import { parseHumanCliArgs, resolveHumanModel } from '../../test-human/config.ts'
import { resolveWorkspacePath } from '../../test-human/tools.ts'
import { scenarioControls } from '../../test-human/scenarios.ts'
import { mediaTypeOf } from '../../test-human/media.ts'
import { summarizeToolResult } from '../../test-human/terminal.ts'
import { resolve } from 'node:path'

describe('human CLI config', () => {
  it('defaults to Codex luna with medium effort', () => {
    const config = parseHumanCliArgs([])
    expect(config).toMatchObject({
      provider: 'codex', mode: 'basic', scenario: 'chat', effort: 'medium', maxTurns: 8,
    })
    expect(resolveHumanModel(config, {})).toBe('gpt-5.6-luna')
  })

  it('turns native scenarios into forced-tool acceptance tests by default', () => {
    expect(parseHumanCliArgs(['--scenario', 'web']).forceTool).toBe(true)
    expect(parseHumanCliArgs(['--scenario=image-gen', '--no-force-tool']).forceTool).toBe(false)
  })

  it('accepts a prompt after -- and preserves spaces', () => {
    expect(parseHumanCliArgs(['--mode', 'deep', '--', 'inspect', 'the repo']).prompt)
      .toBe('inspect the repo')
  })

  it('requires an explicit model for non-Codex providers', () => {
    const config = parseHumanCliArgs(['--provider', 'anthropic'])
    expect(() => resolveHumanModel(config, {})).toThrow(/--model or AI_AGENT_MODEL/)
    expect(resolveHumanModel(config, { AI_AGENT_MODEL: 'claude-test' })).toBe('claude-test')
  })

  it('rejects unknown values and contradictory switches', () => {
    expect(() => parseHumanCliArgs(['--scenario', 'video'])).toThrow(/--scenario/)
    expect(() => parseHumanCliArgs(['--force-tool', '--no-force-tool'])).toThrow(/cannot be used together/)
  })

  it('recognizes short help and confines file tools to the workspace', () => {
    expect(parseHumanCliArgs(['-h']).help).toBe(true)
    const root = resolve('workspace-root')
    expect(resolveWorkspacePath(root, 'docs/readme.md')).toBe(resolve(root, 'docs/readme.md'))
    expect(() => resolveWorkspacePath(root, '../secret.txt')).toThrow(/escapes workspace/)
  })

  it('keeps scenario controls and media mapping outside the CLI controller', () => {
    const web = scenarioControls(parseHumanCliArgs(['--scenario', 'web']))
    expect(web).toEqual({
      nativeTools: [{ type: 'native', name: 'web-search' }],
      toolChoice: { type: 'native', name: 'web-search' },
    })
    expect(mediaTypeOf('photo.JPEG')).toBe('image/jpeg')
    expect(() => mediaTypeOf('video.mp4')).toThrow(/unsupported image extension/)
  })

  it('keeps bounded tool metadata visible for skill and trace diagnostics', () => {
    expect(JSON.parse(summarizeToolResult({
      isError: false,
      value: 'loaded',
      content: [{ type: 'text', text: 'loaded' }],
      meta: { kind: 'skill', skillId: 'systematic-debugging' },
    }))).toMatchObject({
      isError: false,
      meta: { kind: 'skill', skillId: 'systematic-debugging' },
    })
  })
})
