import {
  createAgentRuntime,
  type RuntimeAgentRunEvent,
  type RuntimeAgentSession,
  type JsonValue,
  type RunReport,
  type RuntimeCloseReport,
  type SupportSafeError,
} from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

const DEEP_RESEARCH_INSTRUCTIONS = `
Derive and expose a concise research plan. Search broadly, read the actual
sources, audit coverage and contradictions after each research round, revise
the plan when evidence is missing, and write the cited report only when the
latest audit is sufficient. The number of rounds is adaptive.
`.trim()

export type EdgeResearchMode = 'auto' | 'deep-search'

export interface EdgeChatInput {
  readonly conversationId: string
  readonly message: string
  readonly mode: EdgeResearchMode
  readonly signal?: AbortSignal
}

export interface EdgeChatWorkerOptions {
  /** Supplied by the Worker secret binding, never by browser request JSON. */
  readonly apiKey: string
  readonly projectToolEvent: (event: RuntimeAgentRunEvent) => JsonValue | undefined
}

export interface EdgeChatWorker {
  /** principalId comes from trusted host authentication, not request JSON. */
  respond(principalId: string, input: EdgeChatInput): Response
  close(): Promise<RuntimeCloseReport>
}

interface SessionEntry {
  readonly session: RuntimeAgentSession
}

export async function createEdgeChatWorker(
  options: EdgeChatWorkerOptions,
): Promise<EdgeChatWorker> {
  const runtime = await createAgentRuntime({
    providers: [openAiPlugin({ apiKey: options.apiKey })],
    resource: { serviceName: 'edge-chat-worker' },
  })
  const agent = runtime.agent({
    id: 'edge-chat',
    model: { provider: 'openai', id: 'gpt-5.4' },
    instructions: 'Help the user and expose meaningful progress before tool calls.',
  })
  const sessions = new Map<string, SessionEntry>()
  const activeControllers = new Set<AbortController>()

  return {
    respond(principalId, input) {
      // Mode is deliberately excluded: one visible conversation has one history.
      const key = JSON.stringify([1, principalId, input.conversationId])
      let entry = sessions.get(key)
      if (entry === undefined) {
        entry = { session: agent.createSession({ conversationId: input.conversationId }) }
        sessions.set(key, entry)
      }
      if (entry.session.isRunning) {
        return Response.json({ code: 'CONVERSATION_BUSY' }, { status: 409 })
      }

      const controller = new AbortController()
      activeControllers.add(controller)
      relayAbort(input.signal, controller)
      const handle = entry.session.stream(input.message, {
        signal: controller.signal,
        ...(input.mode === 'deep-search'
          ? { additionalInstructions: DEEP_RESEARCH_INSTRUCTIONS }
          : {}),
      })
      const encoder = new TextEncoder()
      let sequence = 0

      const body = new ReadableStream<Uint8Array>({
        async start(stream) {
          const send = (type: string, payload: JsonValue): void => {
            stream.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({
              schemaVersion: 1,
              runId: handle.runId,
              sequence: sequence++,
              type,
              payload,
            })}\n\n`))
          }
          let failed: { readonly error: SupportSafeError; readonly report: RunReport } | undefined
          try {
            send('start', { conversationId: input.conversationId, mode: input.mode })
            for await (const event of handle) {
              if (event.type === 'error') {
                failed = { error: event.error, report: event.report }
                continue
              }
              if (event.type === 'usage') continue
              const publicPayload = options.projectToolEvent(event)
              if (publicPayload !== undefined) send(event.type, publicPayload)
            }
            if (failed !== undefined) {
              send('failed', {
                outcome: 'failed',
                error: publicError(failed.error),
                report: publicReport(failed.report),
              })
            } else {
              const result = await handle.result
              send('complete', {
                outcome: 'complete',
                text: result.text,
                report: publicReport(result.report),
              })
            }
            stream.close()
          } catch {
            // A broken transport is deliberately not converted to a false success.
            // The browser treats EOF without a terminal envelope as incomplete.
            handle.abort('edge response stream failed')
            controller.abort('edge response stream failed')
            try {
              await entry.session.whenIdle(AbortSignal.timeout(5_000))
              await handle.report.catch(() => undefined)
            } catch { /* bounded settlement failure remains an incomplete stream */ }
            stream.error(new Error('EDGE_STREAM_INCOMPLETE'))
          } finally {
            activeControllers.delete(controller)
          }
        },
        async cancel(reason) {
          handle.abort(reason)
          controller.abort(reason)
          await entry.session.whenIdle(AbortSignal.timeout(5_000))
          await handle.report.catch(() => undefined)
          activeControllers.delete(controller)
        },
      })
      return new Response(body, {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/event-stream; charset=utf-8',
          'x-content-type-options': 'nosniff',
        },
      })
    },
    async close() {
      for (const controller of activeControllers) controller.abort('worker closing')
      return runtime.close()
    },
  }
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): void {
  if (source === undefined) return
  if (source.aborted) target.abort(source.reason)
  else source.addEventListener('abort', () => target.abort(source.reason), { once: true })
}

function publicError(error: SupportSafeError): JsonValue {
  return {
    code: error.code,
    stage: error.stage,
    message: error.message,
    requestId: error.requestId ?? null,
    possiblyBilledAttemptsWithoutUsage: error.possiblyBilledAttemptsWithoutUsage,
  }
}

function publicReport(report: RunReport): JsonValue {
  const operationTotal = Object.values(report.operationCounts)
    .reduce((total, counts) => total + counts.total, 0)
  return {
    runId: report.runId,
    traceId: report.traceId,
    status: report.status,
    durationMs: report.durationMs,
    usage: {
      authoritative: report.usage.authoritative,
      reported: {
        inputTokens: report.usage.reported.inputTokens ?? null,
        outputTokens: report.usage.reported.outputTokens ?? null,
        totalTokens: report.usage.reported.totalTokens ?? null,
        cacheReadTokens: report.usage.reported.cacheReadTokens ?? null,
        cacheWriteTokens: report.usage.reported.cacheWriteTokens ?? null,
        reasoningTokens: report.usage.reported.reasoningTokens ?? null,
      },
      coverage: {
        logicalCalls: report.usage.coverage.logicalCalls,
        attempts: report.usage.coverage.attempts,
        complete: report.usage.coverage.complete,
        partial: report.usage.coverage.partial,
        estimated: report.usage.coverage.estimated,
        missing: report.usage.coverage.missing,
        notApplicable: report.usage.coverage.notApplicable,
        possiblyBilledAttemptsWithoutUsage:
          report.usage.coverage.possiblyBilledAttemptsWithoutUsage,
      },
    },
    operationTotal,
    delivery: {
      complete: report.delivery.complete,
      reachedBoundary: report.delivery.reachedBoundary,
      requiredBoundary: report.delivery.requiredBoundary,
      rejectedCritical: report.delivery.rejectedCritical,
      pendingCritical: report.delivery.pendingCritical,
    },
  }
}
