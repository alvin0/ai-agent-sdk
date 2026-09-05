import {
  defineAgent,
  defineSkill,
  defineTool,
  type RuntimeAgentDefinition,
  type JsonObject,
  type JsonValue,
  type RuntimeAgent,
  type ToolDefinition,
} from '@ai-agent-sdk/core'
import {
  defineCredentialSource,
  defineCredentialStore,
} from '@ai-agent-sdk/core/provider'
import { defineMemoryStore } from '@ai-agent-sdk/core/memory'
import {
  defineObservationExporter,
  type IntegrationOperationEvidenceFields,
  type RuntimeObservationHealthSnapshot,
  type SdkLogger,
  type UsageEstimator,
} from '@ai-agent-sdk/core/observability'
import { defineSkillProviderPlugin } from '@ai-agent-sdk/core/skills'
import { defineToolSource } from '@ai-agent-sdk/core/tools'

export function logExampleIntegrationOperation(logger: SdkLogger): void {
  const fields = [
    {
      integrationSchemaVersion: 1,
      integrationFamily: 'example-client',
      integrationOperation: 'request',
      operationId: 'operation-1',
      kind: 'logical-start',
    },
    {
      integrationSchemaVersion: 1,
      integrationFamily: 'example-client',
      integrationOperation: 'request',
      operationId: 'operation-1',
      kind: 'attempt-start',
      attemptId: 'attempt-1',
      attemptNumber: 1,
    },
    {
      integrationSchemaVersion: 1,
      integrationFamily: 'example-client',
      integrationOperation: 'request',
      operationId: 'operation-1',
      kind: 'attempt-terminal',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      status: 'success',
      durationMs: 1,
    },
    {
      integrationSchemaVersion: 1,
      integrationFamily: 'example-client',
      integrationOperation: 'request',
      operationId: 'operation-1',
      kind: 'logical-terminal',
      status: 'success',
      durationMs: 1,
    },
  ] satisfies readonly IntegrationOperationEvidenceFields[]
  for (const event of fields) logger.info('integration operation evidence', event)
}

/** Zero local loss is necessary, not proof of complete export or instrumentation. */
export function integrationEvidenceHasKnownLoss(
  health: RuntimeObservationHealthSnapshot,
): boolean {
  const { accepted, filtered, dropped, rejected } = health.integrationEvidence
  void accepted // enqueue count is not an exporter acknowledgment
  return filtered > 0 || dropped > 0 || rejected > 0
}

export const exampleCredentialSource = defineCredentialSource({
  id: 'example-credential',
  resolve(options) {
    options.signal.throwIfAborted()
    options.logger.debug('resolve example credential')
    return 'injected-at-runtime'
  },
})

export const exampleCredentialStore = defineCredentialStore<{ readonly token: string }>({
  id: 'example-credential-store',
  label: 'host credential store',
  async read(options) {
    options.signal.throwIfAborted()
    options.logger.debug('read credential metadata')
    return undefined
  },
  async commit(input, options) {
    options.signal.throwIfAborted()
    options.logger.debug('commit credential revision')
    return { revision: `${input.expectedRevision ?? 'new'}:next` }
  },
})

export const exampleMemoryStore = defineMemoryStore({
  id: 'example-memory',
  async load(key, options) {
    options.signal.throwIfAborted()
    options.logger.debug('load memory revision')
    void key
    return undefined
  },
  async commit(input, options) {
    options.signal.throwIfAborted()
    options.logger.debug('commit memory revision')
    return { revision: `${input.key}:next` }
  },
})

export const examplePersistentAgent = defineAgent({
  id: 'persistent-agent',
  model: { provider: 'example', id: 'example-model' },
  instructions: 'Use explicitly scoped persistent task memory.',
  memory: {
    store: exampleMemoryStore,
    bindingId: 'default-conversation-memory',
    scope: { kind: 'conversation', namespace: 'default' },
    requirement: 'required',
  },
} satisfies RuntimeAgentDefinition)

export function createTenantMemorySession(
  agent: RuntimeAgent,
  memoryBindingId: string,
  tenantNamespace: string,
  conversationId: string,
) {
  return agent.createSession({
    conversationId,
    memory: {
      store: exampleMemoryStore,
      bindingId: memoryBindingId,
      scope: { kind: 'conversation', namespace: tenantNamespace },
      requirement: 'required',
    },
  })
}

export const exampleInlineSkill = defineSkill({
  id: 'inline-research',
  description: 'Audit research coverage.',
  whenToUse: 'Use for multi-source research.',
  instructions: 'Search, read, audit twice, then report.',
  invocation: { modelInvocable: true, userInvocable: true },
  resources: { 'references/checklist.md': 'Check coverage and contradictions.' },
})

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResearchReference(reference: {
  readonly catalogRevision: string
  readonly locator?: JsonValue
}): boolean {
  const locator = reference.locator
  return reference.catalogRevision === 'example-skills-v1'
    && isJsonObject(locator)
    && locator.id === 'research'
}

export const exampleSkills = defineSkillProviderPlugin(Object.freeze({
  id: 'example-skills',
  async list(options) {
    options.logger.debug('list skill metadata')
    return Object.freeze({
      revision: 'example-skills-v1',
      candidates: Object.freeze([Object.freeze({
        id: 'research',
        name: 'Research',
        description: 'Read sources and audit coverage.',
        source: 'remote',
        provider: 'example-skills',
        locator: { id: 'research', version: 1 },
      })]),
    })
  },
  async load(reference, options) {
    options.signal.throwIfAborted()
    options.logger.debug('load skill instructions')
    if (!isResearchReference(reference)) return undefined
    return {
      id: 'research',
      description: 'Read sources and audit coverage.',
      instructions: 'Search, read, audit coverage twice, then report.',
      resourceManifest: [{ path: 'references/checklist.md' }],
    }
  },
  async readResource(reference, path, options) {
    options.signal.throwIfAborted()
    options.logger.debug('read skill resource')
    if (!isResearchReference(reference) || path !== 'references/checklist.md') return undefined
    return 'Check coverage, independence, contradictions, and stale claims.'
  },
}))

export const exampleExporter = defineObservationExporter({
  id: 'example-exporter',
  supportedBoundaries: ['none'],
  async ready(signal) {
    signal.throwIfAborted()
  },
  async export(batch, signal) {
    signal.throwIfAborted()
    void batch.runRecords.some(report => report.usage.authoritative)
    void batch.runRecords.flatMap(report => report.modelCalls)
      .flatMap(call => call.attempts)
    void batch.runRecords.map(report => report.usage.reported.reasoningTokens)
    return {
      batchId: batch.id,
      acceptedEventIds: batch.events.map(event => event.eventId),
      acceptedRunIds: batch.runRecords.map(report => report.runId),
    }
  },
  async shutdown(signal) {
    signal.throwIfAborted()
  },
})

export const exampleUsageEstimator = Object.freeze({
  id: 'example-usage-estimator',
  estimate(input) {
    void input.runId
    // The request is local-only and must never be retained or exported.
    return { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  },
} satisfies UsageEstimator)

const clock = defineTool(Object.freeze({
  name: 'clock',
  description: 'Return a host-supplied timestamp.',
  parameters: { type: 'object', additionalProperties: false },
  async execute(input, context) {
    void input
    context.signal.throwIfAborted()
    context.logger?.debug('clock tool invoked', { callId: context.callId })
    return { now: 0 }
  },
} satisfies ToolDefinition))

export const exampleToolSource = defineToolSource({
  id: 'example-tools',
  snapshot(options) {
    options.signal.throwIfAborted()
    options.logger.debug('snapshot tool source')
    return Object.freeze({
      revision: 'example-tools-v1',
      tools: Object.freeze([clock]),
    })
  },
})
