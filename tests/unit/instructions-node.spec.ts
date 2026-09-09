import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ancestorChain, byDepthThenPath, createProjectInstructionsSection, defaultFilePathFromTouch,
  descendantDirsBetween,
} from '@ai-agent-sdk/instructions-node'
import { History, runTurn, ToolRegistry, defineTool } from '@ai-agent-sdk/core/agent'
import { ModelAdapter, ModelRegistry, ToolCallId, createTextMessage } from '@ai-agent-sdk/core'
import type { ContextSectionResolveInput, ContextSectionState } from '@ai-agent-sdk/core'
import type { GenerateOptions, StreamChunk } from '@ai-agent-sdk/core'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agents-md-'))
  roots.push(root)
  await mkdir(join(root, '.git'))
  return root
}

function input(overrides: Partial<ContextSectionResolveInput> = {}): ContextSectionResolveInput {
  return {
    signal: AbortSignal.timeout(30_000),
    step: 0,
    touches: [],
    current: undefined,
    scope: { agentId: undefined, conversationId: undefined },
    ...overrides,
  }
}

async function resolveOnce(
  section: { resolve: (input: ContextSectionResolveInput) => unknown },
  overrides: Partial<ContextSectionResolveInput> = {},
): Promise<ContextSectionState | undefined> {
  return await section.resolve(input(overrides)) as ContextSectionState | undefined
}

describe('project instructions section', () => {
  it('concatenates AGENTS.md from the project root down to the cwd', async () => {
    const root = await workspace()
    const nested = join(root, 'packages', 'api')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    await writeFile(join(root, 'packages', 'AGENTS.md'), 'Packages rule.\n')
    await writeFile(join(nested, 'AGENTS.md'), 'API rule.\n')

    const section = createProjectInstructionsSection({ cwd: nested })
    const state = await resolveOnce(section)

    expect(state?.text).toContain('Instructions from: AGENTS.md\n\nRoot rule.')
    expect(state?.text).toContain('Instructions from: packages/AGENTS.md\n\nPackages rule.')
    expect(state?.text).toContain('Instructions from: packages/api/AGENTS.md\n\nAPI rule.')
    // Broad first, specific last.
    const order = ['Root rule.', 'Packages rule.', 'API rule.'].map(rule => state!.text.indexOf(rule))
    expect(order).toEqual([...order].sort((left, right) => left - right))
  })

  it('does not walk above the project root', async () => {
    const root = await workspace()
    const inner = join(root, 'inner')
    await mkdir(join(inner, '.git'), { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'Outer rule.\n')
    await writeFile(join(inner, 'AGENTS.md'), 'Inner rule.\n')

    const state = await resolveOnce(createProjectInstructionsSection({ cwd: inner }))

    expect(state?.text).toContain('Inner rule.')
    expect(state?.text).not.toContain('Outer rule.')
  })

  it('keeps a stable revision until a file changes', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'Run the linter.\n')
    const section = createProjectInstructionsSection({ cwd: root })

    const first = await resolveOnce(section)
    const second = await resolveOnce(section, { current: first })
    expect(second?.revision).toBe(first?.revision)

    await writeFile(join(root, 'AGENTS.md'), 'Run the linter and the type checker.\n')
    const third = await resolveOnce(section, { current: second })
    expect(third?.revision).not.toBe(first?.revision)
    expect(third?.text).toContain('type checker')
  })

  it('retracts once every instruction file is gone', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'Temporary rule.\n')
    const section = createProjectInstructionsSection({ cwd: root })

    const first = await resolveOnce(section)
    expect(first?.text).toContain('Temporary rule.')
    await rm(join(root, 'AGENTS.md'))

    expect(await resolveOnce(section, { current: first })).toBeUndefined()
    expect(section.loadedPaths()).toEqual([])
  })

  it('pulls in a subdirectory AGENTS.md after a tool touches a file there', async () => {
    const root = await workspace()
    const nested = join(root, 'packages', 'api')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    await writeFile(join(nested, 'AGENTS.md'), 'API rule.\n')

    const section = createProjectInstructionsSection({ cwd: root })
    const first = await resolveOnce(section)
    expect(first?.text).not.toContain('API rule.')

    const second = await resolveOnce(section, {
      step: 1,
      current: first,
      touches: [{
        toolName: 'read',
        rawArguments: JSON.stringify({ file_path: join(nested, 'handler.ts') }),
        failed: false,
      }],
    })

    expect(second?.text).toContain('API rule.')
    // The subtree stays in scope for the rest of the turn.
    const third = await resolveOnce(section, { step: 2, current: second })
    expect(third?.revision).toBe(second?.revision)
  })

  it('ignores the path of a failed tool call', async () => {
    const root = await workspace()
    const nested = join(root, 'pkg')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    await writeFile(join(nested, 'AGENTS.md'), 'Package rule.\n')

    const section = createProjectInstructionsSection({ cwd: root })
    const state = await resolveOnce(section, {
      touches: [{
        toolName: 'read',
        rawArguments: JSON.stringify({ file_path: join(nested, 'missing.ts') }),
        failed: true,
      }],
    })

    expect(state?.text).not.toContain('Package rule.')
  })

  it('takes the first present candidate per directory by default and all of them on request', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.override.md'), 'Override rule.\n')
    await writeFile(join(root, 'AGENTS.md'), 'Base rule.\n')

    const first = await resolveOnce(createProjectInstructionsSection({ cwd: root }))
    expect(first?.text).toContain('Override rule.')
    expect(first?.text).not.toContain('Base rule.')

    const all = await resolveOnce(createProjectInstructionsSection({ cwd: root, perDirectory: 'all' }))
    expect(all?.text).toContain('Override rule.')
    expect(all?.text).toContain('Base rule.')
  })

  it('collapses two files with identical content', async () => {
    const root = await workspace()
    const nested = join(root, 'pkg')
    await mkdir(nested)
    await writeFile(join(root, 'AGENTS.md'), 'Same rule.\n')
    await writeFile(join(nested, 'AGENTS.md'), '  Same rule.  \n')

    const state = await resolveOnce(createProjectInstructionsSection({ cwd: nested }))

    expect(state?.text.match(/Same rule\./g)).toHaveLength(1)
  })

  it('names the files it dropped for the byte budget', async () => {
    const root = await workspace()
    const nested = join(root, 'pkg')
    await mkdir(nested)
    await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(400))
    await writeFile(join(nested, 'AGENTS.md'), 'y'.repeat(400))

    const state = await resolveOnce(
      createProjectInstructionsSection({ cwd: nested, maxBytes: 700, intro: 'Intro.' }),
    )

    expect(state?.text).toContain('Omitted for the 700-byte instruction budget: pkg/AGENTS.md.')
    expect(state?.text).not.toContain('y'.repeat(400))
  })

  it('reads the configured global file before any project file', async () => {
    const root = await workspace()
    const home = await workspace()
    await writeFile(join(home, 'AGENTS.md'), 'Global rule.\n')
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')

    const state = await resolveOnce(createProjectInstructionsSection({
      cwd: root, globalFile: join(home, 'AGENTS.md'),
    }))

    expect(state!.text.indexOf('Global rule.')).toBeLessThan(state!.text.indexOf('Root rule.'))
  })

  it('returns undefined when the workspace has no instruction file', async () => {
    const root = await workspace()
    expect(await resolveOnce(createProjectInstructionsSection({ cwd: root }))).toBeUndefined()
  })
})

describe('shared across agents', () => {
  it('keeps one agent\'s discovered subtree out of another agent\'s context', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    for (const name of ['alpha', 'beta']) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'AGENTS.md'), `${name} rule.\n`)
    }
    // One section instance mounted on a definition two team members instantiate.
    const section = createProjectInstructionsSection({ cwd: root })
    const worker = (id: string) => ({ agentId: 'coder', conversationId: id })

    const first = await resolveOnce(section, {
      scope: worker('c1'),
      touches: [{
        toolName: 'read',
        rawArguments: JSON.stringify({ file_path: join(root, 'alpha', 'a.ts') }),
        failed: false,
      }],
    })
    const second = await resolveOnce(section, { scope: worker('c2') })

    expect(first?.text).toContain('alpha rule.')
    expect(second?.text).toContain('Root rule.')
    expect(second?.text).not.toContain('alpha rule.')
    expect(section.loadedPaths(worker('c1'))).toContain(join(root, 'alpha', 'AGENTS.md'))
    expect(section.loadedPaths(worker('c2'))).not.toContain(join(root, 'alpha', 'AGENTS.md'))
  })

  it('drops the least recently used conversation past the tracked-scope cap', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    await mkdir(join(root, 'alpha'), { recursive: true })
    await writeFile(join(root, 'alpha', 'AGENTS.md'), 'alpha rule.\n')
    const section = createProjectInstructionsSection({ cwd: root, maxTrackedScopes: 1 })

    await resolveOnce(section, {
      scope: { agentId: 'a', conversationId: 'c1' },
      touches: [{
        toolName: 'read',
        rawArguments: JSON.stringify({ file_path: join(root, 'alpha', 'a.ts') }),
        failed: false,
      }],
    })
    await resolveOnce(section, { scope: { agentId: 'a', conversationId: 'c2' } })
    const revisited = await resolveOnce(section, { scope: { agentId: 'a', conversationId: 'c1' } })

    // c1's bucket was evicted, so its subtree is forgotten rather than shared.
    expect(revisited?.text).not.toContain('alpha rule.')
  })
})

describe('alongside skills', () => {
  it('ignores a skill-relative resource path', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    await mkdir(join(root, 'references'), { recursive: true })
    await writeFile(join(root, 'references', 'AGENTS.md'), 'Unrelated rule.\n')

    const state = await resolveOnce(createProjectInstructionsSection({ cwd: root }), {
      touches: [{
        toolName: 'read_skill_resource',
        rawArguments: JSON.stringify({ skillId: 'some-skill', path: 'references/patterns.md' }),
        failed: false,
      }],
    })

    expect(state?.text).toContain('Root rule.')
    expect(state?.text).not.toContain('Unrelated rule.')
  })

  it('still reads a workspace path from a plain file tool', () => {
    expect(defaultFilePathFromTouch({
      toolName: 'read', rawArguments: JSON.stringify({ path: 'src/a.ts' }), failed: false,
    })).toBe('src/a.ts')
    expect(defaultFilePathFromTouch({
      toolName: 'read_skill_resource',
      rawArguments: JSON.stringify({ skillId: 's', path: 'src/a.ts' }),
      failed: false,
    })).toBeUndefined()
  })
})

describe('bounds and cancellation', () => {
  it('stops retaining subtrees once the nested-directory cap is reached', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    const reached: number[] = []
    const section = createProjectInstructionsSection({
      cwd: root, maxNestedDirs: 2, onNestedLimit: limit => reached.push(limit),
    })

    // Three distinct subtrees, only the first two may be retained.
    for (const name of ['a', 'b', 'c']) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'AGENTS.md'), `${name} rule.\n`)
    }
    const state = await resolveOnce(section, {
      touches: ['a', 'b', 'c'].map(name => ({
        toolName: 'read',
        rawArguments: JSON.stringify({ file_path: join(root, name, 'file.ts') }),
        failed: false,
      })),
    })

    expect(state?.text).toContain('a rule.')
    expect(state?.text).toContain('b rule.')
    expect(state?.text).not.toContain('c rule.')
    expect(reached).toEqual([2])
  })

  it('skips a file larger than the section budget without reading it whole', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(5_000))

    // maxFileBytes above maxBytes must not admit a file the section can never render.
    const state = await resolveOnce(createProjectInstructionsSection({
      cwd: root, maxBytes: 1_000, maxFileBytes: 1_000_000,
    }))

    expect(state).toBeUndefined()
  })

  it('honours an aborted signal instead of walking the tree', async () => {
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    const section = createProjectInstructionsSection({ cwd: root })

    await expect(resolveOnce(section, { signal: AbortSignal.abort() })).rejects.toThrow()
  })

  it('rejects a non-positive maxBytes rather than silently disabling the section', () => {
    expect(() => createProjectInstructionsSection({ maxBytes: 0 })).toThrow(/maxBytes/)
    expect(() => createProjectInstructionsSection({ fileNames: ['..', 'a/b'] }))
      .toThrow(/at least one plain file name/)
  })
})

describe('path helpers', () => {
  it('orders directories by depth, not by path length', () => {
    expect(['/a/bbbb', '/a/b/c', '/a/z'].sort(byDepthThenPath))
      .toEqual(['/a/bbbb', '/a/z', '/a/b/c'])
  })

  it('chains directories root-first', () => {
    expect(ancestorChain('/a', '/a/b/c')).toEqual(['/a', '/a/b', '/a/b/c'])
  })

  it('returns descendants only for a path inside the base', () => {
    expect(descendantDirsBetween('/a', '/a/b/c/file.ts')).toEqual(['/a/b', '/a/b/c'])
    expect(descendantDirsBetween('/a', '/a/file.ts')).toEqual([])
    expect(descendantDirsBetween('/a', '/other/file.ts')).toEqual([])
  })

  it('extracts a path only from a successful call with recognizable arguments', () => {
    expect(defaultFilePathFromTouch({ toolName: 'read', rawArguments: '{"path":"a.ts"}', failed: false }))
      .toBe('a.ts')
    expect(defaultFilePathFromTouch({ toolName: 'read', rawArguments: 'not json', failed: false }))
      .toBeUndefined()
    expect(defaultFilePathFromTouch({ toolName: 'read', rawArguments: '{"path":"a.ts"}', failed: true }))
      .toBeUndefined()
  })
})

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
}

describe('mounted on a turn', () => {
  it('puts the workspace instructions in front of the model and grows them as tools read deeper', async () => {
    const root = await workspace()
    const nested = join(root, 'packages', 'api')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'Root rule.\n')
    await writeFile(join(nested, 'AGENTS.md'), 'API rule.\n')

    const adapter = new ScriptedAdapter([
      [
        {
          type: 'block-end', index: 0,
          block: {
            type: 'tool-call', id: ToolCallId('call-1'), name: 'read',
            arguments: JSON.stringify({ file_path: join(nested, 'handler.ts') }),
          },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('fix the handler') })
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'read', description: 'Read a file.', parameters: { type: 'object' },
      parse: value => value as { file_path: string },
      execute: ({ file_path }) => ({ file_path }),
      isConcurrencySafe: () => true,
    }))

    for await (const _event of runTurn({
      registry, config: { provider: 'test', model: 'm' }, history, tools,
      contextSections: [createProjectInstructionsSection({ cwd: root })],
    })) { /* drain */ }

    const first = JSON.stringify(adapter.requests[0]?.messages)
    const second = JSON.stringify(adapter.requests[1]?.messages)
    expect(first).toContain('Root rule.')
    expect(first).not.toContain('API rule.')
    // The nested file arrives once a tool has actually gone into that subtree.
    expect(second).toContain('API rule.')
    // One live node, so the superseded text is gone rather than duplicated.
    expect(second!.match(/Root rule\./g)).toHaveLength(1)
  })
})
