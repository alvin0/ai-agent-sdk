/**
 * Where tools live, and what the model is allowed to see of them.
 *
 * The registry's one non-obvious job is the **allowlist when producing schemas**.
 * A `ToolDefinition` carries `execute`, `timeoutMs`, `isConcurrencySafe`, `render`,
 * and `meta` alongside the three fields the provider wants. Sending the object as
 * it stands would leak internal policy into the prompt — `timeoutMs` in particular
 * invites the model to reason about deadlines it has no business knowing. So
 * {@link ToolRegistry.schemas} rebuilds each entry from exactly
 * `{ name, description, parameters }`.
 *
 * @module ai-agent-sdk/agent/tool/registry
 */

import type { ToolSchema } from '@ai-agent-sdk/core'
import { AgentSdkError } from '@ai-agent-sdk/core'
import { deepFreeze } from '@ai-agent-sdk/core'
import {
  executionModeOf,
  type ToolDefinition,
  type ToolExecutionMode,
} from './definition.ts'

/** Read-only view of a set of tools. */
export interface ToolCatalog {
  /** Look up a tool, or `undefined` when it is absent from this view. */
  get(name: string): ToolDefinition | undefined
  /** Whether this view exposes a tool by that name. */
  has(name: string): boolean
  /** Every exposed name, in registration order. */
  names(): readonly string[]
  /** The schemas to send the model — internals stripped. */
  schemas(): readonly ToolSchema[]
  /** How a call to this tool may be scheduled. Fail-closed for unknown names. */
  executionMode(name: string, args: unknown): ToolExecutionMode
}

/** Which tools a view exposes. */
export interface ToolFilter {
  /** Expose only these. Omit to start from everything. */
  allow?: readonly string[]
  /** Remove these, applied after `allow`. */
  deny?: readonly string[]
}

/** Codes the registry raises. */
export const REGISTRY_ERROR_CODES = Object.freeze({
  DUPLICATE_TOOL: 'DUPLICATE_TOOL',
  INVALID_TOOL: 'INVALID_TOOL',
  UNKNOWN_TOOL_FILTER: 'UNKNOWN_TOOL_FILTER',
} as const)

/** Rebuild a schema with only the fields the provider should receive. */
function publicSchema(definition: ToolDefinition): ToolSchema {
  return {
    name: definition.name,
    description: definition.description,
    // Snapshot and freeze: the same definition object is reused across every
    // request, and a provider adapter or a middleware that mutated `parameters`
    // in place would corrupt every later turn.
    parameters: deepFreeze(structuredClone(definition.parameters)),
  }
}

function assertValid(definition: ToolDefinition): void {
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new AgentSdkError('a tool must have a non-empty name', REGISTRY_ERROR_CODES.INVALID_TOOL)
  }
  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    // Not pedantry: the description IS the tool's interface to the model, and an
    // undescribed tool gets called wrongly or not at all.
    throw new AgentSdkError(
      `tool "${definition.name}" must have a non-empty description; it is what the model reads to decide when to call it`,
      REGISTRY_ERROR_CODES.INVALID_TOOL,
    )
  }
  if (typeof definition.parameters !== 'object' || definition.parameters === null) {
    throw new AgentSdkError(
      `tool "${definition.name}" must declare a JSON Schema object for its parameters`,
      REGISTRY_ERROR_CODES.INVALID_TOOL,
    )
  }
  if (typeof definition.execute !== 'function') {
    throw new AgentSdkError(
      `tool "${definition.name}" must implement execute()`,
      REGISTRY_ERROR_CODES.INVALID_TOOL,
    )
  }
  if (definition.timeoutMs !== undefined
    && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) {
    throw new AgentSdkError(
      `tool "${definition.name}" declared a non-positive timeoutMs`,
      REGISTRY_ERROR_CODES.INVALID_TOOL,
    )
  }
}

/**
 * A filtered, read-only projection of a registry.
 *
 * The two filter halves are evaluated LAZILY and mean different things, which is
 * the subtle part:
 *
 * - `allow` is a closed list — "only these" — so a tool registered later is not in
 *   it and correctly stays hidden.
 * - `deny` is an open subtraction — "everything except these" — so a tool
 *   registered later IS exposed.
 *
 * Snapshotting the registry's names at construction would collapse the second case
 * into the first: `view({ deny: ['exec'] })` would silently freeze the toolset,
 * and a tool added afterwards would go missing with nothing to point at.
 */
class FilteredCatalog implements ToolCatalog {
  private readonly source: ToolCatalog
  private readonly allow: ReadonlySet<string> | undefined
  private readonly deny: ReadonlySet<string>

  constructor(
    source: ToolCatalog,
    allow: ReadonlySet<string> | undefined,
    deny: ReadonlySet<string>,
  ) {
    this.source = source
    this.allow = allow
    this.deny = deny
  }

  private exposes(name: string): boolean {
    if (this.deny.has(name)) return false
    return this.allow === undefined || this.allow.has(name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.exposes(name) ? this.source.get(name) : undefined
  }

  has(name: string): boolean {
    return this.exposes(name) && this.source.has(name)
  }

  names(): readonly string[] {
    return this.source.names().filter(name => this.exposes(name))
  }

  schemas(): readonly ToolSchema[] {
    return this.source.schemas().filter(schema => this.exposes(schema.name))
  }

  executionMode(name: string, args: unknown): ToolExecutionMode {
    return executionModeOf(this.get(name), args)
  }
}

/** Holds the tools an agent may call. */
export class ToolRegistry implements ToolCatalog {
  private readonly tools = new Map<string, ToolDefinition>()

  /**
   * Register a tool.
   * @param definition - the tool; validated before it is accepted.
   * @returns a disposer that removes exactly this registration.
   */
  register<Args>(definition: ToolDefinition<Args>): () => void {
    const entry = definition as ToolDefinition
    assertValid(entry)
    if (this.tools.has(entry.name)) {
      // Silently shadowing would make which implementation runs depend on import
      // order, which is invisible at the call site.
      throw new AgentSdkError(
        `a tool named "${entry.name}" is already registered`,
        REGISTRY_ERROR_CODES.DUPLICATE_TOOL,
      )
    }
    this.tools.set(entry.name, entry)
    return () => {
      // Guard the identity: a later re-registration under the same name must not
      // be removed by a stale disposer.
      if (this.tools.get(entry.name) === entry) this.tools.delete(entry.name)
    }
  }

  /**
   * Register several tools atomically.
   *
   * All-or-nothing: if any is invalid or duplicated, none are registered, so a
   * caller cannot end up with half a toolset and no indication of it.
   * @param definitions - the tools.
   * @returns one disposer removing all of them.
   */
  registerAll(definitions: readonly ToolDefinition<never>[]): () => void {
    const disposers: (() => void)[] = []
    try {
      for (const definition of definitions) {
        disposers.push(this.register(definition as ToolDefinition))
      }
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): readonly string[] {
    return [...this.tools.keys()]
  }

  schemas(): readonly ToolSchema[] {
    return [...this.tools.values()].map(publicSchema)
  }

  executionMode(name: string, args: unknown): ToolExecutionMode {
    return executionModeOf(this.tools.get(name), args)
  }

  /**
   * A restricted view, for handing a narrower toolset to a sub-agent.
   *
   * Unknown names in the filter THROW rather than being ignored, because a typo in
   * a deny list silently grants the capability it was meant to remove — the
   * failure mode is invisible and points the wrong way.
   *
   * The view is a live projection, not a copy. An `allow` list is closed, so
   * tools registered later stay hidden; a `deny` list is an open subtraction, so
   * they appear. See {@link FilteredCatalog}.
   * @param filter - which names to expose.
   * @returns a read-only catalog.
   */
  view(filter: ToolFilter): ToolCatalog {
    for (const name of [...filter.allow ?? [], ...filter.deny ?? []]) {
      if (!this.tools.has(name)) {
        throw new AgentSdkError(
          `tool filter names "${name}", which is not registered`,
          REGISTRY_ERROR_CODES.UNKNOWN_TOOL_FILTER,
        )
      }
    }
    return new FilteredCatalog(
      this,
      filter.allow === undefined ? undefined : new Set(filter.allow),
      new Set(filter.deny ?? []),
    )
  }
}
