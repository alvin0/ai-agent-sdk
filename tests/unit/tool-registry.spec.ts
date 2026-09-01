import { describe, expect, it, vi } from 'vitest'
import { isJsonValue } from '@ai-agent-sdk/core'
import {
  defineTool,
  executionModeOf,
  renderJsonValue,
  type ToolDefinition,
} from '@ai-agent-sdk/agent'
import { ToolError, toolErrorDisposition } from '@ai-agent-sdk/agent'
import { ToolRegistry } from '@ai-agent-sdk/agent'

const echo = defineTool({
  name: 'echo',
  description: 'Echo the input back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: (args: { text: string }) => args.text,
})

function tool(overrides: Partial<ToolDefinition<never>> = {}): ToolDefinition<never> {
  return {
    name: 't',
    description: 'A tool.',
    parameters: { type: 'object' },
    execute: () => null,
    ...overrides,
  } as ToolDefinition<never>
}

describe('ToolError disposition', () => {
  it('defaults an arbitrary throw to respond-to-model', () => {
    // The load-bearing default: a TypeError inside a tool body must reach the
    // model as a failed result, not end the user's turn.
    expect(toolErrorDisposition(new TypeError('oops'))).toBe('respond-to-model')
    expect(toolErrorDisposition('a string')).toBe('respond-to-model')
    expect(toolErrorDisposition(undefined)).toBe('respond-to-model')
  })

  it('honours an explicitly fatal ToolError', () => {
    expect(toolErrorDisposition(ToolError.fatal('contract broken'))).toBe('fatal')
    expect(toolErrorDisposition(ToolError.respondToModel('try again'))).toBe('respond-to-model')
  })

  it('carries a routable code', () => {
    const error = ToolError.respondToModel('nope', 'MY_CODE')
    expect(error.code).toBe('MY_CODE')
    expect(error.disposition).toBe('respond-to-model')
  })
})

describe('executionModeOf', () => {
  it('is exclusive unless a tool opts in with exactly true', () => {
    expect(executionModeOf(tool(), {})).toBe('exclusive')
    expect(executionModeOf(tool({ isConcurrencySafe: () => true }), {})).toBe('parallel')
    // Anything truthy-but-not-true is still exclusive: guessing wrong corrupts
    // state silently, so only an unambiguous yes counts.
    expect(executionModeOf(tool({ isConcurrencySafe: () => 1 as unknown as boolean }), {}))
      .toBe('exclusive')
    expect(executionModeOf(tool({ isConcurrencySafe: () => false }), {})).toBe('exclusive')
  })

  it('is exclusive when the classifier throws', () => {
    // A tool whose safety check is broken is not a tool whose safety can be assumed.
    const broken = tool({
      isConcurrencySafe: () => {
        throw new Error('classifier bug')
      },
    })
    expect(executionModeOf(broken, {})).toBe('exclusive')
  })

  it('is exclusive for an unknown tool', () => {
    expect(executionModeOf(undefined, {})).toBe('exclusive')
  })
})

describe('ToolRegistry', () => {
  it('exposes only name, description, and parameters to the model', () => {
    const registry = new ToolRegistry()
    registry.register(tool({
      name: 'secret',
      timeoutMs: 5_000,
      isConcurrencySafe: () => true,
      render: () => [],
      meta: () => ({}),
    }))
    const schema = registry.schemas()[0]
    // timeoutMs in particular must never reach the prompt — it invites the model
    // to reason about deadlines it has no business knowing.
    expect(Object.keys(schema ?? {}).sort()).toEqual(['description', 'name', 'parameters'])
  })

  it('freezes the exposed parameters so an adapter cannot corrupt later turns', () => {
    const registry = new ToolRegistry()
    registry.register(echo)
    const schema = registry.schemas()[0]
    expect(Object.isFrozen(schema?.parameters)).toBe(true)
    // The same definition object is reused every request, so the snapshot must be
    // a copy rather than the live object.
    expect(schema?.parameters).not.toBe(echo.parameters)
  })

  it('refuses a duplicate name rather than shadowing by import order', () => {
    const registry = new ToolRegistry()
    registry.register(tool({ name: 'dup' }))
    expect(() => registry.register(tool({ name: 'dup' }))).toThrow(/already registered/)
  })

  it('rejects a tool with no description', () => {
    // The description IS the tool's interface to the model.
    expect(() => new ToolRegistry().register(tool({ description: '' })))
      .toThrow(/non-empty description/)
  })

  it('rejects a non-positive timeout and a missing execute', () => {
    expect(() => new ToolRegistry().register(tool({ timeoutMs: 0 }))).toThrow(/timeoutMs/)
    expect(() => new ToolRegistry().register(tool({ execute: undefined as never })))
      .toThrow(/execute/)
  })

  it('removes exactly its own registration', () => {
    const registry = new ToolRegistry()
    const first = tool({ name: 'x' })
    const dispose = registry.register(first)
    dispose()
    expect(registry.has('x')).toBe(false)

    // A stale disposer must not remove a later tool that reused the name.
    registry.register(tool({ name: 'x', description: 'The replacement.' }))
    dispose()
    expect(registry.has('x')).toBe(true)
    expect(registry.get('x')?.description).toBe('The replacement.')
  })

  it('registers a batch all-or-nothing', () => {
    const registry = new ToolRegistry()
    expect(() => registry.registerAll([
      tool({ name: 'ok' }),
      tool({ name: 'bad', description: '' }),
    ])).toThrow(/non-empty description/)
    // A half-registered toolset with no indication would be worse than failing.
    expect(registry.names()).toEqual([])
  })

  it('disposes a batch as one unit', () => {
    const registry = new ToolRegistry()
    const dispose = registry.registerAll([tool({ name: 'a' }), tool({ name: 'b' })])
    expect(registry.names()).toEqual(['a', 'b'])
    dispose()
    expect(registry.names()).toEqual([])
  })
})

describe('ToolRegistry.view', () => {
  function seeded(): ToolRegistry {
    const registry = new ToolRegistry()
    registry.registerAll([tool({ name: 'read' }), tool({ name: 'write' }), tool({ name: 'exec' })])
    return registry
  }

  it('exposes only the allowed tools', () => {
    const view = seeded().view({ allow: ['read'] })
    expect(view.names()).toEqual(['read'])
    expect(view.has('write')).toBe(false)
    expect(view.get('write')).toBeUndefined()
    expect(view.schemas().map(s => s.name)).toEqual(['read'])
  })

  it('applies deny after allow', () => {
    const view = seeded().view({ allow: ['read', 'write'], deny: ['write'] })
    expect(view.names()).toEqual(['read'])
  })

  it('throws on a name that is not registered', () => {
    // A typo in a DENY list silently grants the capability it meant to remove, and
    // the failure points the wrong way. Fail loudly instead.
    expect(() => seeded().view({ deny: ['writ'] })).toThrow(/not registered/)
    expect(() => seeded().view({ allow: ['reed'] })).toThrow(/not registered/)
  })

  it('lets a later tool through a deny list, which means "everything except"', () => {
    const registry = seeded()
    const view = registry.view({ deny: ['exec'] })
    registry.register(tool({ name: 'search' }))
    expect(view.names()).toEqual(['read', 'write', 'search'])
  })

  it('keeps a later tool out of an allow list, which means "only these"', () => {
    // The two halves are deliberately asymmetric: snapshotting would collapse the
    // deny case into this one and silently freeze the toolset.
    const registry = seeded()
    const view = registry.view({ allow: ['read'] })
    registry.register(tool({ name: 'search' }))
    expect(view.names()).toEqual(['read'])
  })

  it('keeps fail-closed scheduling for a hidden tool', () => {
    const registry = new ToolRegistry()
    registry.register(tool({ name: 'safe', isConcurrencySafe: () => true }))
    const view = registry.view({ deny: ['safe'] })
    expect(registry.executionMode('safe', {})).toBe('parallel')
    expect(view.executionMode('safe', {})).toBe('exclusive')
  })
})

describe('renderJsonValue', () => {
  it('passes a string through and pretty-prints everything else', () => {
    expect(renderJsonValue('plain prose')).toEqual([{ type: 'text', text: 'plain prose' }])
    expect(renderJsonValue({ a: 1 })).toEqual([{ type: 'text', text: '{\n  "a": 1\n}' }])
  })

  it('marks the empty cases so the model does not read a blank result', () => {
    expect(renderJsonValue(undefined)).toEqual([{ type: 'text', text: '(no output)' }])
    expect(renderJsonValue('')).toEqual([{ type: 'text', text: '(empty)' }])
  })
})

describe('isJsonValue', () => {
  it('accepts values that survive a JSON round trip', () => {
    expect(isJsonValue({ a: [1, 'two', true, null] })).toBe(true)
    expect(isJsonValue(Object.create(null) as object)).toBe(true)
  })

  it('rejects values JSON.stringify silently corrupts', () => {
    // These do not throw in stringify — they change meaning, which is worse.
    expect(isJsonValue(new Date())).toBe(false)
    expect(isJsonValue(new Map())).toBe(false)
    expect(isJsonValue(undefined)).toBe(false)
    expect(isJsonValue(Number.NaN)).toBe(false)
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isJsonValue(() => 0)).toBe(false)
    expect(isJsonValue(10n)).toBe(false)
  })

  it('rejects a cycle instead of throwing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isJsonValue(cyclic)).toBe(false)
  })

  it('accepts a diamond, which is not a cycle', () => {
    const shared = { v: 1 }
    expect(isJsonValue({ a: shared, b: shared })).toBe(true)
  })
})

describe('defineTool', () => {
  it('runs a tool through its parse hook', async () => {
    const parse = vi.fn((raw: unknown) => {
      const value = raw as { text?: unknown }
      if (typeof value.text !== 'string') throw new Error('text must be a string')
      return { text: value.text }
    })
    const t = defineTool({
      name: 'p',
      description: 'Parses.',
      parameters: { type: 'object' },
      parse,
      execute: (args: { text: string }) => args.text.toUpperCase(),
    })
    expect(await t.execute(t.parse!({ text: 'hi' }), {} as never)).toBe('HI')
    expect(() => t.parse!({ text: 1 })).toThrow(/must be a string/)
  })
})
