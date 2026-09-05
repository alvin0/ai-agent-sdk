/** Codex-style dynamic worker creation and delegation over AgentTeam. */

import type { JsonValue } from '../../primitives/index.ts'
import { createTextMessage } from '../../message/index.ts'
import type { ModelRegistry } from '../../runtime/index.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import { cloneAgent, type DefinedAgent } from '../define/definition.ts'
import {
  type AgentInput,
  type AgentInvocationOptions,
  type AgentResponse,
  type AgentSession,
  type AgentSessionOptions,
} from '../define/session.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import { ToolRegistry, type ToolCatalog } from '../tool/registry.ts'
import { AgentTeam } from './team.ts'
import type { AgentTeamOptions } from './types.ts'
import { waitForSettlement } from '../../async/index.ts'
type DetachedSessionOptions = Omit<AgentSessionOptions, 'registry' | 'team' | 'tools'>

export interface ManagedAgentSpawnRequest {
  /** Optional stable team address; generated as worker_N when omitted. */
  readonly name?: string
  readonly task: string
  /** Short specialization added to the generated worker's instructions. */
  readonly specialty?: string
}

export interface ResolvedManagedAgentSpawnRequest extends ManagedAgentSpawnRequest {
  readonly name: string
}

export interface ManagedAgentWorkerResult {
  readonly worker: string
  readonly agentId: string
  readonly conversationId: string
  readonly text: string
  readonly succeeded: boolean
}

export interface ManagedAgentWorker {
  readonly name: string
  readonly agentId: string
  readonly conversationId: string
  readonly task: string
  readonly specialty?: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly result?: ManagedAgentWorkerResult
  readonly error?: string
}

export interface ManagedAgentTeamOptions {
  readonly registry: ModelRegistry
  readonly lead: DefinedAgent
  readonly leadName?: string
  readonly leadDescription?: string
  readonly team?: AgentTeam | AgentTeamOptions
  readonly maxWorkers?: number
  /** Maximum UTF-8 worker task bytes. Defaults to 64 KiB. */
  readonly maxTaskBytes?: number
  /** Maximum UTF-8 specialty bytes. Defaults to 8 KiB. */
  readonly maxSpecialtyBytes?: number
  /** End-to-end deadline for one generated worker. Defaults to 10 minutes. */
  readonly workerTimeoutMs?: number
  /** Maximum wait per worker event observer callback. Defaults to 1 second. */
  readonly observerTimeoutMs?: number
  /** Defaults to cloning the lead definition under the generated worker id. */
  readonly workerTemplate?: DefinedAgent
  readonly workerFactory?: (
    request: ResolvedManagedAgentSpawnRequest,
  ) => DefinedAgent | Promise<DefinedAgent>
  readonly leadSessionOptions?: DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }
  readonly workerSessionOptions?: DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }
  /** Per-worker runtime dependencies for least-privilege tools and workspace policy. */
  readonly workerSessionOptionsFactory?: (
    request: ResolvedManagedAgentSpawnRequest,
  ) => (DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] })
    | Promise<DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }>
  /** Observe every generated worker's model, tool, trace, and compaction events. */
  readonly onWorkerEvent?: (
    worker: string,
    event: AgentRunEvent,
  ) => void | Promise<void>
}

interface WorkerRuntime {
  readonly request: ResolvedManagedAgentSpawnRequest
  readonly session: AgentSession
  status: 'running' | 'completed' | 'failed'
  result: ManagedAgentWorkerResult | undefined
  error: string | undefined
}

/**
 * A dynamic harness whose lead can create specialized workers with spawn_agent.
 * Each worker is a real connected AgentSession and remains addressable afterward.
 */
export class ManagedAgentTeam {
  readonly team: AgentTeam
  readonly lead: AgentSession
  readonly leadName: string
  private readonly options: ManagedAgentTeamOptions
  private readonly maxWorkers: number
  private readonly maxTaskBytes: number
  private readonly maxSpecialtyBytes: number
  private readonly workerTimeoutMs: number
  private readonly observerTimeoutMs: number
  private readonly workerRuntimes = new Map<string, WorkerRuntime>()
  private readonly reservedNames = new Set<string>()
  private workerSequence = 0

  constructor(options: ManagedAgentTeamOptions) {
    this.options = options
    this.maxWorkers = positiveInteger(options.maxWorkers ?? 7, 'maxWorkers')
    this.maxTaskBytes = positiveInteger(options.maxTaskBytes ?? 64 * 1024, 'maxTaskBytes')
    this.maxSpecialtyBytes = positiveInteger(options.maxSpecialtyBytes ?? 8 * 1024, 'maxSpecialtyBytes')
    this.workerTimeoutMs = positiveInteger(options.workerTimeoutMs ?? 10 * 60_000, 'workerTimeoutMs')
    this.observerTimeoutMs = positiveInteger(options.observerTimeoutMs ?? 1_000, 'observerTimeoutMs')
    this.team = options.team instanceof AgentTeam
      ? options.team
      : new AgentTeam({
          ...options.team,
          maxMembers: options.team?.maxMembers ?? this.maxWorkers + 1,
        })
    this.leadName = memberName(options.leadName ?? options.lead.id)
    this.lead = options.lead.createSession({
      ...options.leadSessionOptions,
      registry: options.registry,
      tools: mergeTools(options.leadSessionOptions?.tools, this.controlTools()),
      team: {
        team: this.team,
        name: this.leadName,
        role: 'lead',
        instructions: [
          'You lead a managed dynamic team.',
          'Decide whether the objective benefits from delegation; do not spawn workers for trivial work.',
          'When independent bounded subtasks exist, call spawn_agent multiple times in the same model step so they run in parallel.',
          'Synthesize worker results yourself and remain responsible for the final answer.',
        ].join(' '),
        ...(options.leadDescription === undefined ? {} : { description: options.leadDescription }),
      },
    })
  }

  /** Run the lead. It decides whether and how many workers to create. */
  run(input: AgentInput, invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    return this.lead.run(input, invocation)
  }

  /** Host-side equivalent of the model's spawn_agent tool. */
  async spawn(
    request: ManagedAgentSpawnRequest,
    signal?: AbortSignal,
  ): Promise<ManagedAgentWorkerResult> {
    signal?.throwIfAborted()
    const resolved: ResolvedManagedAgentSpawnRequest = {
      name: memberName(request.name ?? this.nextWorkerName()),
      task: boundedString(request.task, 'worker task', this.maxTaskBytes),
      ...(request.specialty === undefined
        ? {}
        : { specialty: boundedString(request.specialty, 'worker specialty', this.maxSpecialtyBytes) }),
    }
    if (this.workerRuntimes.size + this.reservedNames.size >= this.maxWorkers) {
      throw new Error(`managed agent team reached its ${this.maxWorkers}-worker limit`)
    }
    if (this.reservedNames.has(resolved.name) || this.workerRuntimes.has(resolved.name)
      || this.team.members().some(member => member.name === resolved.name)) {
      throw new Error(`managed worker '${resolved.name}' already exists`)
    }

    this.reservedNames.add(resolved.name)
    let runtime: WorkerRuntime | undefined
    try {
      const operationSignal = combineSignals(signal, AbortSignal.timeout(this.workerTimeoutMs))
      const definition = await abortable(this.workerDefinition(resolved), operationSignal)
      operationSignal.throwIfAborted()
      const scopedSessionOptions = this.options.workerSessionOptionsFactory === undefined
        ? undefined
        : await abortable(Promise.resolve(this.options.workerSessionOptionsFactory(resolved)), operationSignal)
      operationSignal.throwIfAborted()
      const session = definition.createSession({
        ...this.options.workerSessionOptions,
        ...scopedSessionOptions,
        registry: this.options.registry,
        team: {
          team: this.team,
          name: resolved.name,
          role: 'peer',
          instructions: [
            `You are a dynamically created worker reporting to '${this.leadName}'.`,
            'Complete the delegated task independently and return a concise evidence-backed result.',
            'Do not broaden the task or attempt to become team lead.',
          ].join(' '),
          ...(resolved.specialty === undefined ? {} : { description: resolved.specialty }),
        },
      })
      runtime = {
        request: resolved,
        session,
        status: 'running',
        result: undefined,
        error: undefined,
      }
      this.workerRuntimes.set(resolved.name, runtime)
      this.reservedNames.delete(resolved.name)

      await this.team.sendMessage({
        from: this.leadName,
        target: resolved.name,
        message: resolved.task,
        delivery: 'quiet',
        signal: operationSignal,
      })
      if (definition.memory.autoCaptureObjective) {
        session.memory.captureOriginalObjective(createTextMessage(resolved.task))
      }
      const response = await session.runPending({
        signal: operationSignal,
        ...(this.options.onWorkerEvent === undefined
          ? {}
          : { onEvent: (event: AgentRunEvent) => this.observeWorkerEvent(resolved.name, event) }),
      })
      const result = Object.freeze({
        worker: resolved.name,
        agentId: definition.id,
        conversationId: session.conversationId,
        text: response.text,
        succeeded: response.outcome.completed,
      })
      runtime.status = 'completed'
      runtime.result = result
      return result
    } catch (error: unknown) {
      if (runtime !== undefined) {
        runtime.status = 'failed'
        runtime.error = errorMessage(error)
      }
      throw error
    } finally {
      this.reservedNames.delete(resolved.name)
    }
  }

  /** Current detached worker lifecycle view. */
  workers(): readonly ManagedAgentWorker[] {
    return Object.freeze([...this.workerRuntimes.values()].map(runtime => Object.freeze({
      name: runtime.request.name,
      agentId: runtime.session.definition.id,
      conversationId: runtime.session.conversationId,
      task: runtime.request.task,
      status: runtime.status,
      ...(runtime.request.specialty === undefined ? {} : { specialty: runtime.request.specialty }),
      ...(runtime.result === undefined ? {} : { result: runtime.result }),
      ...(runtime.error === undefined ? {} : { error: runtime.error }),
    })))
  }

  /** Remove one idle generated worker from the harness and shared roster. */
  removeWorker(name: string): void {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    if (runtime.status === 'running' || runtime.session.isRunning) {
      throw new Error(`cannot remove running managed worker '${address}'`)
    }
    this.team.detach(address)
    this.workerRuntimes.delete(address)
  }

  private controlTools(): readonly ToolDefinition<any>[] {
    return Object.freeze([
      defineTool({
        name: 'spawn_agent',
        description: [
          'Create a connected specialist worker and delegate one task to it.',
          'Use multiple spawn_agent calls in the same turn for independent parallel work.',
          'The completed worker remains in list_agents for later peer messaging.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Optional unique worker address; omitted generates worker_N.',
            },
            task: { type: 'string', description: 'Concrete bounded task assigned to the worker.' },
            specialty: {
              type: 'string',
              description: 'Optional worker role or domain specialization.',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
        parse: parseSpawnTool,
        execute: async (request, context) => asJson(await this.spawn(request, context.signal)),
        timeoutMs: this.workerTimeoutMs,
        isConcurrencySafe: () => true,
      }),
    ])
  }

  private async workerDefinition(
    request: ResolvedManagedAgentSpawnRequest,
  ): Promise<DefinedAgent> {
    if (this.options.workerFactory !== undefined) return this.options.workerFactory(request)
    const template = this.options.workerTemplate ?? this.options.lead
    const specialty = request.specialty === undefined
      ? ''
      : ` Your specialization is: ${request.specialty}.`
    return cloneAgent(template, {
      id: request.name,
      name: request.name,
      instructions: `${template.instructions}\n\nYou are dynamically assigned worker '${request.name}'.${specialty}`,
    })
  }

  private nextWorkerName(): string {
    while (true) {
      const candidate = `worker_${++this.workerSequence}`
      if (!this.reservedNames.has(candidate) && !this.workerRuntimes.has(candidate)
        && !this.team.members().some(member => member.name === candidate)) return candidate
    }
  }

  private async observeWorkerEvent(worker: string, event: AgentRunEvent): Promise<void> {
    const observer = Promise.resolve().then(() => this.options.onWorkerEvent?.(worker, event))
    await waitForSettlement(observer, this.observerTimeoutMs)
  }
}

export function createManagedAgentTeam(options: ManagedAgentTeamOptions): ManagedAgentTeam {
  return new ManagedAgentTeam(options)
}

function mergeTools(
  supplied: ToolCatalog | readonly ToolDefinition<any>[] | undefined,
  generated: readonly ToolDefinition<any>[],
): ToolRegistry {
  const registry = new ToolRegistry()
  if (supplied !== undefined) {
    const tools = 'names' in supplied
      ? supplied.names().map(name => supplied.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
      : supplied
    for (const tool of tools) registry.register(tool)
  }
  for (const tool of generated) registry.register(tool)
  return registry
}

function parseSpawnTool(value: unknown): ManagedAgentSpawnRequest {
  const input = object(value, 'spawn_agent arguments')
  if (Object.keys(input).some(key => key !== 'name' && key !== 'task' && key !== 'specialty')) {
    throw new TypeError('spawn_agent arguments contain unknown fields')
  }
  return {
    task: nonEmpty(input.task, 'worker task'),
    ...(input.name === undefined ? {} : { name: memberName(input.name) }),
    ...(input.specialty === undefined
      ? {}
      : { specialty: nonEmpty(input.specialty, 'worker specialty') }),
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function memberName(value: unknown): string {
  const name = nonEmpty(value, 'managed agent name')
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new TypeError('managed agent name must start with a letter and contain only letters, digits, _ or -')
  }
  if (name.length > 128) throw new TypeError('managed agent name must not exceed 128 characters')
  return name
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  const text = nonEmpty(value, label)
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new TypeError(`${label} exceeds the ${maxBytes}-byte limit`)
  }
  return text
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('managed worker aborted')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('managed worker aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined)
  return active.length === 1 ? active[0]! : AbortSignal.any(active)
}

function asJson(value: unknown): JsonValue { return value as JsonValue }
