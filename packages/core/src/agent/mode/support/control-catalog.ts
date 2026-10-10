import { AGENT_CONTROL_TOOLS  } from '../control-tools.ts'
import type { ToolInterceptor  } from '../../tool/pipeline.ts'
import { type ToolDefinition, type ToolExecutionMode  } from '../../tool/definition.ts'
import type { ToolCatalog  } from '../../tool/registry.ts'

export class CombinedToolCatalog implements ToolCatalog {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>
  constructor(base: ToolCatalog | undefined, additions: readonly ToolDefinition[]) {
    const definitions = new Map<string, ToolDefinition>()
    for (const name of base?.names() ?? []) {
      const definition = base?.get(name)
      if (definition !== undefined) definitions.set(name, definition)
    }
    for (const definition of additions) {
      if (definitions.has(definition.name)) {
        throw new Error(`tool name "${definition.name}" is reserved by the selected agent mode`)
      }
      definitions.set(definition.name, definition)
    }
    this.definitions = definitions
  }
  get(name: string): ToolDefinition | undefined { return this.definitions.get(name) }
  has(name: string): boolean { return this.definitions.has(name) }
  names(): readonly string[] { return [...this.definitions.keys()] }
  schemas() {
    return [...this.definitions.values()].map(({ name, description, parameters }) => ({
      name, description, parameters: structuredClone(parameters),
    }))
  }
  executionMode(name: string, args: unknown): ToolExecutionMode {
    const definition = this.definitions.get(name)
    if (definition === undefined) return 'exclusive'
    try { return definition.isConcurrencySafe?.(args) === true ? 'parallel' : 'exclusive' }
    catch { return 'exclusive' }
  }
}

export function combineTools(base: ToolCatalog | undefined, additions: readonly ToolDefinition[]): ToolCatalog {
  return new CombinedToolCatalog(base, additions)
}

/** Control tools are host protocol, not application capabilities subject to tool policy. */
export function shieldControlTools(interceptors: readonly ToolInterceptor[]): readonly ToolInterceptor[] {
  const reserved = new Set<string>(Object.values(AGENT_CONTROL_TOOLS))
  return interceptors.map(interceptor => ({
    name: interceptor.name,
    ...interceptor.before === undefined ? {} : {
      before: (call, next) => reserved.has(call.toolName) ? next() : interceptor.before!(call, next),
    },
    ...interceptor.around === undefined ? {} : {
      around: (call, next) => reserved.has(call.toolName) ? next() : interceptor.around!(call, next),
    },
    ...interceptor.after === undefined ? {} : {
      after: (call, result, next) => reserved.has(call.toolName) ? next() : interceptor.after!(call, result, next),
    },
  }))
}
