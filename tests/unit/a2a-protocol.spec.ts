import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
} from '@a2a-js/sdk'
import type { Client, ClientFactory } from '@a2a-js/sdk/client'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentTeam } from '../../src/agent/a2a/index.ts'
import { defineAgent } from '../../src/agent/define/index.ts'
import { createA2AAgentLink, linkA2AAgent } from '../../src/a2a/client.ts'
import {
  createAgentCardFromDefinition,
  createDefinedAgentA2AServer,
} from '../../src/a2a/server.ts'
import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ResolvedModelInfo } from '@ai-agent-sdk/core'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly replies: readonly string[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.replies[this.requests.length - 1] ?? 'done'
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

class ThrowingAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    throw new Error('secret database credential: production-password')
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

function createRegistry(replies: readonly string[] = []) {
  const adapter = new ScriptedAdapter(replies)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return { adapter, registry }
}

function localAgent(id: string) {
  return defineAgent({ id, provider: 'test', model: 'scripted', instructions: `You are ${id}.` })
}

function authenticatedContext(userName: string): ServerCallContext {
  return new ServerCallContext({
    requestedVersion: A2A_PROTOCOL_VERSION,
    user: { isAuthenticated: true, userName },
  })
}

function secureCard(definition: ReturnType<typeof localAgent>) {
  return createAgentCardFromDefinition(definition, {
    url: `https://agents.example.test/${definition.id}`,
    securitySchemes: {
      bearer: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: { description: 'Bearer token', scheme: 'Bearer', bearerFormat: 'JWT' },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  })
}

function request(text: string, contextId = ''): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: crypto.randomUUID(), contextId, taskId: '', role: Role.ROLE_USER,
      parts: [{
        content: { $case: 'text', value: text },
        mediaType: 'text/plain', filename: '', metadata: undefined,
      }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['text/plain'], taskPushNotificationConfig: undefined,
      returnImmediately: false,
    },
    metadata: undefined,
  }
}

describe('official A2A protocol integration', () => {
  it('keeps deployment auth and network policy opt-in at the SDK boundary', async () => {
    const definition = localAgent('local-standard')
    const card = createAgentCardFromDefinition(definition, {
      url: 'http://127.0.0.1:3000/a2a',
    })
    expect(card.securitySchemes).toEqual({})
    expect(card.securityRequirements).toEqual([])

    const client = {
      sendMessage: vi.fn(async (): Promise<Message> => ({
        messageId: 'reply', contextId: 'context', taskId: '', role: Role.ROLE_AGENT,
        parts: [{
          content: { $case: 'text', value: 'local ok' }, mediaType: 'text/plain',
          filename: '', metadata: undefined,
        }],
        metadata: undefined, extensions: [], referenceTaskIds: [],
      })),
    } as unknown as Client
    const clientFactory = {
      createFromAgentCard: vi.fn(async () => client),
    } as unknown as ClientFactory
    const link = await createA2AAgentLink({
      agentCard: card, clientFactory, streaming: false,
    })
    await expect(link.send({
      teamId: 'team', sender: 'lead', senderAgentId: 'lead', messageId: 'message',
      content: [{ type: 'text', text: 'work' }],
    })).resolves.toMatchObject({ succeeded: true, text: 'local ok' })
  })

  it('links an official Client into the same roster and preserves remote context', async () => {
    const calls: SendMessageRequest[] = []
    const sendMessage = vi.fn(async (input: SendMessageRequest): Promise<Message> => {
      calls.push(structuredClone(input))
      return {
        messageId: crypto.randomUUID(),
        contextId: input.message?.contextId || 'remote-context',
        taskId: '', role: Role.ROLE_AGENT,
        parts: [{
          content: { $case: 'text', value: 'remote result' },
          mediaType: 'text/plain', filename: '', metadata: undefined,
        }],
        metadata: undefined, extensions: [], referenceTaskIds: [],
      }
    })
    const client = { sendMessage } as unknown as Client
    const team = new AgentTeam({ id: 'hybrid-team' })
    const local = createRegistry()
    localAgent('lead').createSession({ registry: local.registry, team: { team } })

    await linkA2AAgent(team, {
      name: 'remote', agentId: 'remote-card-id', client, streaming: false,
    })

    const first = await team.followup('lead', 'remote', 'Investigate the issue.')
    const second = await team.followup('lead', 'remote', 'Now summarize it.')

    expect(team.members().find(member => member.name === 'remote')).toMatchObject({
      kind: 'remote', protocol: 'a2a/1.0', deliveries: ['wakeup'], status: 'idle',
    })
    expect(first.result).toMatchObject({
      kind: 'message', succeeded: true, text: 'remote result', contextId: 'remote-context',
    })
    expect(calls[0]?.message).toMatchObject({
      contextId: '', role: Role.ROLE_USER,
      metadata: { teamId: 'hybrid-team', sender: 'lead', senderAgentId: 'lead' },
    })
    expect(calls[1]?.message?.contextId).toBe('remote-context')
    await expect(team.sendMessage({ from: 'lead', target: 'remote', message: 'quiet' }))
      .rejects.toThrow(/cannot accept quiet injection/)
    expect(second.result?.text).toBe('remote result')
  })

  it('normalizes an official completed Task returned by a linked client', async () => {
    const client = {
      sendMessage: vi.fn(async (): Promise<import('@a2a-js/sdk').Task> => ({
        id: 'task-1', contextId: 'context-1',
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
        artifacts: [{
          artifactId: 'artifact-1', name: 'result', description: '',
          parts: [{
            content: { $case: 'text', value: 'artifact output' },
            mediaType: 'text/plain', filename: '', metadata: undefined,
          }],
          metadata: undefined, extensions: [],
        }],
        history: [], metadata: undefined,
      })),
    } as unknown as Client

    const link = await createA2AAgentLink({ client, agentId: 'remote', streaming: false })
    await expect(link.send({
      teamId: 'team', messageId: 'message', sender: 'lead', senderAgentId: 'lead',
      content: [{ type: 'text', text: 'work' }],
    })).resolves.toMatchObject({
      kind: 'task', succeeded: true, text: 'artifact output',
      contextId: 'context-1', taskId: 'task-1', state: 'TASK_STATE_COMPLETED',
    })
  })

  it('serves a DefinedAgent through the official request handler and resumes context', async () => {
    const state = createRegistry(['first answer', 'second answer'])
    const definition = localAgent('reviewer')
    const card = createAgentCardFromDefinition(definition, {
      url: 'https://agents.example.test/reviewer', tags: ['review'],
    })
    const server = createDefinedAgentA2AServer({
      agent: definition, registry: state.registry, agentCard: card,
    })
    const callContext = new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION })

    const first = await server.requestHandler.sendMessage(request('Review this change.'), callContext)
    expect(card).toMatchObject({
      name: 'reviewer', capabilities: { streaming: true },
      supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    })
    expect(first).toMatchObject({
      contextId: expect.any(String),
      status: { state: TaskState.TASK_STATE_COMPLETED },
      artifacts: [{ parts: [{ content: { $case: 'text', value: 'first answer' } }] }],
    })
    if (!('id' in first)) throw new Error('expected an A2A task')

    const second = await server.requestHandler.sendMessage(
      request('Check the follow-up.', first.contextId),
      callContext,
    )
    expect(second).toMatchObject({
      contextId: first.contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED },
      artifacts: [{ parts: [{ content: { $case: 'text', value: 'second answer' } }] }],
    })
    expect(state.adapter.requests).toHaveLength(2)
    expect(state.adapter.requests[0]?.messages.at(-1)?.source).toMatchObject({
      kind: 'a2a-message', messageId: expect.any(String), taskId: expect.any(String),
    })
    expect(state.adapter.requests[1]?.messages.some(message =>
      message.role === 'assistant' && message.content.some(block =>
        block.type === 'text' && block.text === 'first answer'))).toBe(true)
  })

  it('isolates identical context ids by host-defined session owner', async () => {
    const state = createRegistry(['alice first', 'bob first', 'alice second'])
    const definition = localAgent('scoped-reviewer')
    const server = createDefinedAgentA2AServer({
      agent: definition,
      registry: state.registry,
      agentCard: secureCard(definition),
    })
    const sharedContextId = 'same-client-context'

    await server.requestHandler.sendMessage(
      request('Alice starts.', sharedContextId), authenticatedContext('alice'),
    )
    await server.requestHandler.sendMessage(
      request('Bob starts.', sharedContextId), authenticatedContext('bob'),
    )
    await server.requestHandler.sendMessage(
      request('Alice follows up.', sharedContextId), authenticatedContext('alice'),
    )

    expect(state.adapter.requests[1]?.messages.some(message =>
      message.role === 'assistant' && message.content.some(block =>
        block.type === 'text' && block.text === 'alice first'))).toBe(false)
    expect(state.adapter.requests[2]?.messages.some(message =>
      message.role === 'assistant' && message.content.some(block =>
        block.type === 'text' && block.text === 'alice first'))).toBe(true)
    expect(state.adapter.requests[2]?.messages.some(message =>
      message.role === 'assistant' && message.content.some(block =>
        block.type === 'text' && block.text === 'bob first'))).toBe(false)
  })

  it('rejects unauthenticated execution and sanitizes internal failures', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], new ThrowingAdapter())
    const definition = localAgent('secure-reviewer')
    const observed: unknown[] = []
    const server = createDefinedAgentA2AServer({
      agent: definition,
      registry,
      agentCard: secureCard(definition),
      requireAuthenticated: true,
      onError: error => { observed.push(error) },
    })

    const unauthenticated = await server.requestHandler.sendMessage(
      request('Do not run.'), new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION }),
    )
    expect(unauthenticated).toMatchObject({
      status: {
        state: TaskState.TASK_STATE_FAILED,
        message: { parts: [{ content: { $case: 'text', value: 'Agent execution failed' } }] },
      },
    })

    const failed = await server.requestHandler.sendMessage(
      request('Trigger private failure.'), authenticatedContext('alice'),
    )
    expect(failed).toMatchObject({
      status: {
        state: TaskState.TASK_STATE_FAILED,
        message: { parts: [{ content: { $case: 'text', value: 'Agent execution failed' } }] },
      },
    })
    expect(JSON.stringify(failed)).not.toContain('production-password')
    expect(observed.some(error => String(error).includes('production-password'))).toBe(true)
  })

  it('bounds retained server sessions and client contexts', async () => {
    const state = createRegistry(['first'])
    const definition = localAgent('bounded-reviewer')
    const errors: unknown[] = []
    const server = createDefinedAgentA2AServer({
      agent: definition,
      registry: state.registry,
      agentCard: secureCard(definition),
      maxSessions: 1,
      onError: error => { errors.push(error) },
    })
    await server.requestHandler.sendMessage(request('first'), authenticatedContext('alice'))
    const overflow = await server.requestHandler.sendMessage(
      request('second'), authenticatedContext('alice'),
    )
    expect(overflow).toMatchObject({ status: { state: TaskState.TASK_STATE_FAILED } })
    expect(errors.some(error => String(error).includes('1-session limit'))).toBe(true)

    const sendMessage = vi.fn(async (input: SendMessageRequest): Promise<Message> => ({
      messageId: crypto.randomUUID(), contextId: input.message?.contextId || crypto.randomUUID(),
      taskId: '', role: Role.ROLE_AGENT,
      parts: [{
        content: { $case: 'text', value: 'ok' }, mediaType: 'text/plain',
        filename: '', metadata: undefined,
      }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    }))
    const link = await createA2AAgentLink({
      client: { sendMessage } as unknown as Client,
      agentId: 'bounded-remote', streaming: false, maxContexts: 1,
    })
    await link.send({
      teamId: 'team', sender: 'one', senderAgentId: 'one', messageId: 'one',
      content: [{ type: 'text', text: 'first' }],
    })
    await expect(link.send({
      teamId: 'team', sender: 'two', senderAgentId: 'two', messageId: 'two',
      content: [{ type: 'text', text: 'second' }],
    })).rejects.toThrow(/1-context limit/)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('bounds a session factory that ignores A2A task cancellation', async () => {
    const definition = localAgent('stuck-factory')
    const observed: unknown[] = []
    const server = createDefinedAgentA2AServer({
      agent: definition,
      agentCard: secureCard(definition),
      createSession: async () => await new Promise<never>(() => {}),
      taskTimeoutMs: 10,
      disposeTimeoutMs: 10,
      observerTimeoutMs: 10,
      onError: error => { observed.push(error) },
    })
    const started = Date.now()
    const result = await server.requestHandler.sendMessage(
      request('This must time out.'), authenticatedContext('alice'),
    )
    expect(result).toMatchObject({
      status: {
        state: TaskState.TASK_STATE_FAILED,
        message: { parts: [{ content: { $case: 'text', value: 'Agent execution failed' } }] },
      },
    })
    expect(Date.now() - started).toBeLessThan(250)
    expect(observed).toHaveLength(1)
    await expect(server.executor.dispose()).resolves.toBeUndefined()
  })

  it('rejects unsafe endpoint literals and oversized remote responses', async () => {
    await expect(createA2AAgentLink({
      baseUrl: 'https://127.0.0.1:8443', allowPrivateNetwork: false,
    }))
      .rejects.toThrow(/private or local/)
    await expect(createA2AAgentLink({
      baseUrl: 'http://agents.example.test', requireHttps: true,
    }))
      .rejects.toThrow(/must use https/)

    const client = {
      sendMessage: vi.fn(async (): Promise<Message> => ({
        messageId: 'reply', contextId: 'context', taskId: '', role: Role.ROLE_AGENT,
        parts: [{
          content: { $case: 'text', value: 'sensitive'.repeat(20) },
          mediaType: 'text/plain', filename: '', metadata: undefined,
        }],
        metadata: undefined, extensions: [], referenceTaskIds: [],
      })),
    } as unknown as Client
    const link = await createA2AAgentLink({
      client, agentId: 'oversized', streaming: false, maxResponseBytes: 32,
    })
    await expect(link.send({
      teamId: 'team', sender: 'lead', senderAgentId: 'lead', messageId: 'message',
      content: [{ type: 'text', text: 'work' }],
    })).rejects.toThrow(/32-byte limit/)

    const transportBounded = await createA2AAgentLink({
      client, agentId: 'transport-bounded', streaming: false,
      maxTransportBytes: 64, maxResponseBytes: 1_024,
    })
    await expect(transportBounded.send({
      teamId: 'team', sender: 'lead', senderAgentId: 'lead', messageId: 'wire-message',
      content: [{ type: 'text', text: 'work' }],
    })).rejects.toThrow(/transport response exceeds the 64-byte limit/)
  })

  it('uses terminal stream status instead of reporting an initial task as success', async () => {
    const initial: Task = {
      id: 'stream-task', contextId: 'stream-context',
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
      artifacts: [], history: [], metadata: undefined,
    }
    const events: StreamResponse[] = [
      { payload: { $case: 'task', value: initial } },
      {
        payload: {
          $case: 'statusUpdate',
          value: {
            taskId: 'stream-task', contextId: 'stream-context',
            status: {
              state: TaskState.TASK_STATE_FAILED,
              message: {
                messageId: 'failure', contextId: 'stream-context', taskId: 'stream-task',
                role: Role.ROLE_AGENT,
                parts: [{
                  content: { $case: 'text', value: 'remote failed safely' },
                  mediaType: 'text/plain', filename: '', metadata: undefined,
                }],
                metadata: undefined, extensions: [], referenceTaskIds: [],
              },
              timestamp: undefined,
            },
            metadata: undefined,
          },
        },
      },
    ]
    const client = {
      async * sendMessageStream() {
        for (const event of events) yield event
      },
    } as unknown as Client
    const observed: StreamResponse[] = []
    const link = await createA2AAgentLink({
      client, agentId: 'streamed', streaming: true,
      onStreamEvent: event => { observed.push(event) },
    })
    await expect(link.send({
      teamId: 'team', sender: 'lead', senderAgentId: 'lead', messageId: 'message',
      content: [{ type: 'text', text: 'work' }],
    })).resolves.toMatchObject({
      kind: 'task', succeeded: false, text: 'remote failed safely',
      state: 'TASK_STATE_FAILED',
    })
    expect(observed).toHaveLength(2)
    expect(observed.every(event => Object.isFrozen(event))).toBe(true)

    const bounded = await createA2AAgentLink({
      client, agentId: 'bounded-stream', streaming: true, maxStreamEvents: 1,
    })
    await expect(bounded.send({
      teamId: 'team', sender: 'lead', senderAgentId: 'lead', messageId: 'message-2',
      content: [{ type: 'text', text: 'work' }],
    })).rejects.toThrow(/1-event limit/)
  })

  it('bounds non-cooperative unary and streaming A2A clients', async () => {
    const input = {
      teamId: 'team', sender: 'lead', senderAgentId: 'lead', messageId: 'bounded-call',
      content: [{ type: 'text' as const, text: 'work' }],
    }
    const unary = await createA2AAgentLink({
      client: { sendMessage: () => new Promise(() => {}) } as unknown as Client,
      agentId: 'hung-unary', streaming: false, timeoutMs: 10,
    })
    const unaryStarted = Date.now()
    await expect(unary.send(input)).rejects.toBeDefined()
    expect(Date.now() - unaryStarted).toBeLessThan(250)

    const streaming = await createA2AAgentLink({
      client: {
        sendMessageStream: () => ({
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<StreamResponse>>(() => {}),
              return: () => new Promise<IteratorResult<StreamResponse>>(() => {}),
            }
          },
        }),
      } as unknown as Client,
      agentId: 'hung-stream', streaming: true, timeoutMs: 10, teardownTimeoutMs: 10,
    })
    const streamStarted = Date.now()
    await expect(streaming.send(input)).rejects.toBeDefined()
    expect(Date.now() - streamStarted).toBeLessThan(250)
  })
})
