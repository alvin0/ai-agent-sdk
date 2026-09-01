/** Durable, explicitly inspectable task memory kept outside compactable history. */

import type { UserMessage } from '@ai-agent-sdk/core'

export type AgentMemoryKind =
  | 'objective'
  | 'constraint'
  | 'decision'
  | 'fact'
  | 'progress'
  | 'next-step'

export interface AgentMemorySeed {
  readonly id?: string
  readonly kind: AgentMemoryKind
  readonly content: string
}

export interface AgentMemoryItem {
  readonly id: string
  readonly kind: AgentMemoryKind
  readonly content: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AgentMemorySnapshot {
  readonly version: 1
  readonly items: readonly AgentMemoryItem[]
}

export interface AgentMemoryConfigInput {
  /** Pin the first real user message as the original objective. Defaults to true. */
  readonly autoCaptureObjective?: boolean
  /** Maximum rendered memory characters injected into every model request. Defaults to 12,000. */
  readonly maxInjectedChars?: number
  /** Maximum retained memory records. Defaults to 1,024. */
  readonly maxItems?: number
  /** Maximum characters retained by one record. Defaults to 65,536. */
  readonly maxItemChars?: number
  /** Maximum cumulative retained content characters. Defaults to 1 MiB. */
  readonly maxStoredChars?: number
  readonly seed?: readonly AgentMemorySeed[]
}

export interface AgentMemoryConfig {
  readonly autoCaptureObjective: boolean
  readonly maxInjectedChars: number
  readonly maxItems: number
  readonly maxItemChars: number
  readonly maxStoredChars: number
  readonly seed: readonly AgentMemorySeed[]
}

const PRIORITY: Readonly<Record<AgentMemoryKind, number>> = Object.freeze({
  objective: 0,
  constraint: 1,
  decision: 2,
  'next-step': 3,
  progress: 4,
  fact: 5,
})

export class AgentMemory {
  private readonly records = new Map<string, AgentMemoryItem>()
  private readonly limits: Pick<AgentMemoryConfig, 'maxItems' | 'maxItemChars' | 'maxStoredChars'>
  private nextId = 1
  private storedChars = 0

  constructor(
    seed: readonly AgentMemorySeed[] = [],
    limits: Partial<Pick<AgentMemoryConfig, 'maxItems' | 'maxItemChars' | 'maxStoredChars'>> = {},
  ) {
    this.limits = resolveMemoryLimits(limits)
    for (const item of seed) this.remember(item)
  }

  static fromSnapshot(
    snapshot: AgentMemorySnapshot,
    limits: Partial<Pick<AgentMemoryConfig, 'maxItems' | 'maxItemChars' | 'maxStoredChars'>> = {},
  ): AgentMemory {
    if (typeof snapshot !== 'object' || snapshot === null
      || snapshot.version !== 1 || !Array.isArray(snapshot.items)) {
      throw new TypeError('unsupported agent memory snapshot')
    }
    const memory = new AgentMemory([], limits)
    if (snapshot.items.length > memory.limits.maxItems) {
      throw new RangeError(`agent memory snapshot exceeds the ${memory.limits.maxItems}-item limit`)
    }
    for (const item of snapshot.items) {
      validateItem(item)
      if (memory.records.has(item.id)) throw new TypeError(`duplicate agent memory id '${item.id}'`)
      if (item.content.length > memory.limits.maxItemChars) {
        throw new RangeError(`agent memory item '${item.id}' exceeds the ${memory.limits.maxItemChars}-character limit`)
      }
      if (memory.storedChars + item.content.length > memory.limits.maxStoredChars) {
        throw new RangeError(`agent memory snapshot exceeds the ${memory.limits.maxStoredChars}-character limit`)
      }
      memory.records.set(item.id, Object.freeze({
        id: item.id,
        kind: item.kind,
        content: item.content,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }))
      memory.storedChars += item.content.length
      const successor = memoryIdSuccessor(item.id)
      if (successor !== undefined) memory.nextId = Math.max(memory.nextId, successor)
    }
    return memory
  }

  /** Add or update one stable memory item. Supplying the same id is an upsert. */
  remember(input: AgentMemorySeed): AgentMemoryItem {
    validateSeed(input)
    const id = input.id ?? `memory-${this.nextId}`
    const content = input.content.trim()
    if (content.length > this.limits.maxItemChars) {
      throw new RangeError(`agent memory item '${id}' exceeds the ${this.limits.maxItemChars}-character limit`)
    }
    const successor = memoryIdSuccessor(id)
    const previous = this.records.get(id)
    if (previous === undefined && this.records.size >= this.limits.maxItems) {
      throw new RangeError(`agent memory reached its ${this.limits.maxItems}-item limit`)
    }
    const nextStoredChars = this.storedChars - (previous?.content.length ?? 0) + content.length
    if (nextStoredChars > this.limits.maxStoredChars) {
      throw new RangeError(`agent memory reached its ${this.limits.maxStoredChars}-character limit`)
    }
    const at = new Date().toISOString()
    const item = Object.freeze({
      id,
      kind: input.kind,
      content,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    })
    this.records.set(id, item)
    this.storedChars = nextStoredChars
    if (successor !== undefined) this.nextId = Math.max(this.nextId, successor)
    return item
  }

  forget(id: string): boolean {
    const item = this.records.get(id)
    if (item === undefined) return false
    this.records.delete(id)
    this.storedChars -= item.content.length
    return true
  }

  items(): readonly AgentMemoryItem[] {
    return Object.freeze([...this.records.values()])
  }

  snapshot(): AgentMemorySnapshot {
    return Object.freeze({
      version: 1,
      items: Object.freeze(this.items().map(item => Object.freeze(structuredClone(item)))),
    })
  }

  /** Capture the first user request verbatim enough to survive every later compaction. */
  captureOriginalObjective(message: UserMessage): AgentMemoryItem | undefined {
    if ([...this.records.values()].some(item => item.kind === 'objective')) return undefined
    const text = collectTextPrefix(message, this.limits.maxItemChars).trim()
    return this.remember({
      id: 'original-objective',
      kind: 'objective',
      content: text.length > 0 ? text : '[The original request contained non-text input.]',
    })
  }

  /** Render bounded pinned context, ordered by importance rather than insertion accident. */
  render(maxChars = 12_000): string {
    if (!Number.isInteger(maxChars) || maxChars < 256) {
      throw new RangeError('agent memory render maxChars must be an integer >= 256')
    }
    const ordered = [...this.records.values()].sort((a, b) =>
      PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt.localeCompare(b.createdAt))
    if (ordered.length === 0) return ''
    const preamble = [
      '<task-memory>',
      'Durable task facts follow. Preserve the original objective and obey active constraints even when older conversation turns were compacted.',
    ]
    const closing = '</task-memory>'
    let remaining = maxChars - preamble.join('\n').length - closing.length - 2
    const lines: string[] = []
    for (const item of ordered) {
      if (remaining <= 0) break
      const prefix = `- ${item.kind} [${item.id}]: `
      const contentBudget = Math.max(0, remaining - prefix.length - 1)
      const content = truncateMiddle(JSON.stringify(item.content), contentBudget)
      const line = prefix + content
      lines.push(line)
      remaining -= line.length + 1
    }
    return [...preamble, ...lines, closing].join('\n')
  }
}

export function resolveMemoryConfig(input: AgentMemoryConfigInput | undefined): AgentMemoryConfig {
  const maxInjectedChars = input?.maxInjectedChars ?? 12_000
  if (!Number.isInteger(maxInjectedChars) || maxInjectedChars < 256) {
    throw new RangeError('agent memory maxInjectedChars must be an integer >= 256')
  }
  const limits = resolveMemoryLimits(input ?? {})
  const ids = new Set<string>()
  let nextId = 1
  let storedChars = 0
  const seed = Object.freeze([...(input?.seed ?? [])].map(item => {
    validateSeed(item)
    const id = item.id ?? `memory-${nextId++}`
    const successor = memoryIdSuccessor(id)
    if (successor !== undefined) nextId = Math.max(nextId, successor)
    if (ids.has(id)) throw new TypeError(`duplicate agent memory seed id '${id}'`)
    ids.add(id)
    const chars = item.content.trim().length
    if (chars > limits.maxItemChars) {
      throw new RangeError(`agent memory seed '${id}' exceeds the ${limits.maxItemChars}-character limit`)
    }
    storedChars += chars
    if (storedChars > limits.maxStoredChars) {
      throw new RangeError(`agent memory seed exceeds the ${limits.maxStoredChars}-character limit`)
    }
    return Object.freeze({
      ...(item.id === undefined ? {} : { id: item.id }),
      kind: item.kind,
      content: item.content,
    })
  }))
  if (seed.length > limits.maxItems) {
    throw new RangeError(`agent memory seed exceeds the ${limits.maxItems}-item limit`)
  }
  return Object.freeze({
    autoCaptureObjective: input?.autoCaptureObjective ?? true,
    maxInjectedChars,
    ...limits,
    seed,
  })
}

function validateSeed(input: AgentMemorySeed): void {
  if (input.id !== undefined && (typeof input.id !== 'string'
    || input.id.trim().length === 0 || input.id.length > 256 || /\s/.test(input.id))) {
    throw new TypeError('agent memory id must be non-empty, at most 256 characters, and contain no whitespace')
  }
  if (!Object.hasOwn(PRIORITY, input.kind)) throw new TypeError(`unsupported agent memory kind '${String(input.kind)}'`)
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new TypeError('agent memory content must be a non-empty string')
  }
}

function resolveMemoryLimits(
  input: Partial<Pick<AgentMemoryConfig, 'maxItems' | 'maxItemChars' | 'maxStoredChars'>>,
): Pick<AgentMemoryConfig, 'maxItems' | 'maxItemChars' | 'maxStoredChars'> {
  const maxItems = positiveInteger(input.maxItems ?? 1_024, 'maxItems')
  const maxItemChars = positiveInteger(input.maxItemChars ?? 65_536, 'maxItemChars')
  const maxStoredChars = positiveInteger(input.maxStoredChars ?? 1024 * 1024, 'maxStoredChars')
  if (maxItemChars > maxStoredChars) {
    throw new RangeError('agent memory maxItemChars must not exceed maxStoredChars')
  }
  return Object.freeze({ maxItems, maxItemChars, maxStoredChars })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`agent memory ${name} must be a positive safe integer`)
  }
  return value
}

function validateItem(item: AgentMemoryItem): void {
  validateSeed(item)
  if (!validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt)) {
    throw new TypeError('agent memory timestamps must be bounded ISO date strings')
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  try { return new Date(parsed).toISOString() === value } catch { return false }
}

function memoryIdSuccessor(id: string): number | undefined {
  const suffix = /^memory-(\d+)$/.exec(id)?.[1]
  if (suffix === undefined) return undefined
  const numeric = Number(suffix)
  return Number.isSafeInteger(numeric) && numeric >= 1 && numeric < Number.MAX_SAFE_INTEGER
    ? numeric + 1
    : undefined
}

function collectTextPrefix(message: UserMessage, maxChars: number): string {
  const marker = '…[objective truncated]'
  let text = ''
  let truncated = false
  for (const block of message.content) {
    if (block.type !== 'text') continue
    const separator = text.length === 0 ? '' : '\n'
    const remaining = maxChars - text.length
    if (separator.length + block.text.length <= remaining) {
      text += separator + block.text
      continue
    }
    const available = Math.max(0, remaining - separator.length - marker.length)
    text += separator + block.text.slice(0, available) + marker.slice(0, Math.max(0, remaining - separator.length - available))
    truncated = true
    break
  }
  return truncated ? text.slice(0, maxChars) : text
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 1) return value.slice(0, maxChars)
  const marker = '…'
  const head = Math.ceil((maxChars - marker.length) / 2)
  const tail = Math.floor((maxChars - marker.length) / 2)
  return value.slice(0, head) + marker + value.slice(value.length - tail)
}
