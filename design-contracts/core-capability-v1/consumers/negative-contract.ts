import {
  createAgentRuntime,
  defineTool,
  fixedApprovalBroker,
  type ComposableModelProviderPlugin,
  type RuntimeObservationExporterRegistration,
  type NativeToolSchema,
} from '@ai-agent-sdk/core'
import {
  PROVIDER_PLUGIN_API_VERSION,
  defineModelProviderPlugin,
  type CredentialInput,
  type ModelProviderPlugin,
} from '@ai-agent-sdk/core/provider'
import {
  OBSERVATION_EXPORTER_API_VERSION,
  type IntegrationOperationEvidenceFields,
  type ObservationHealthSnapshot,
  type ObservationExporterPlugin,
  type RuntimeObservationHealthSnapshot,
} from '@ai-agent-sdk/core/observability'
import {
  defineSkillProviderPlugin,
  type RuntimeSkillCandidate,
} from '@ai-agent-sdk/core/skills'
import { defineToolSource } from '@ai-agent-sdk/core/tools'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

const legacyProvider: ModelProviderPlugin = {
  id: 'fixture',
  displayName: 'Fixture',
  setup: () => undefined,
}

// @ts-expect-error Normal composition requires inert route claims before setup.
await createAgentRuntime({ providers: [legacyProvider] })

const provider = defineModelProviderPlugin({
  id: 'fixture',
  displayName: 'Fixture',
  routes: ['fixture'],
  setup: () => undefined,
})

// @ts-expect-error Capability identity is immutable after definition.
provider.id = 'mutated-provider'
// @ts-expect-error Runtime captures a stable executable method table.
provider.setup = () => undefined

const runtime = await createAgentRuntime({ providers: [provider] })

const negativeAgent = runtime.agent({
  id: 'no-string-model-shorthand',
  // @ts-expect-error Recommended v1 requires an explicit provider/model object.
  model: 'openai/gpt-5.4',
  instructions: 'Compile-only negative contract.',
})

const negativeSession = negativeAgent.createSession()
// @ts-expect-error A bound agent's resolved model is immutable.
negativeAgent.model.id = 'changed-after-binding'
openAiPlugin({
  apiKey: 'compile-only',
  // @ts-expect-error Defaults must be a model ID or complete explicit target, not a number.
  defaultModel: 123,
})
negativeSession.stream('Compile-only input.', {
  // @ts-expect-error Run-scoped instruction overlays are one bounded string, not a workflow/config array.
  additionalInstructions: ['search', 'audit', 'report'],
})

// @ts-expect-error Recommended v1 has typed capability slots, not a catch-all plugin array.
await createAgentRuntime({ providers: [provider], plugins: [] })

const incompatibleProvider: ComposableModelProviderPlugin = {
  kind: 'model-provider-plugin',
  // @ts-expect-error Executable provider protocols must carry the supported family marker.
  apiVersion: 2,
  id: 'incompatible',
  displayName: 'Incompatible',
  routes: ['incompatible'],
  setup: () => undefined,
}

void incompatibleProvider

defineModelProviderPlugin({
  id: 'async-setup-is-invalid',
  displayName: 'Async setup is invalid',
  routes: ['async-setup-is-invalid'],
  // @ts-expect-error Provider topology setup must complete synchronously.
  async setup() {},
})

defineModelProviderPlugin({
  id: 'async-cleanup-is-invalid',
  displayName: 'Async cleanup is invalid',
  routes: ['async-cleanup-is-invalid'],
  // @ts-expect-error Provider topology cleanup must also complete synchronously.
  setup() {
    return async () => undefined
  },
})

const exporter: ObservationExporterPlugin = {
  kind: 'observation-exporter',
  apiVersion: OBSERVATION_EXPORTER_API_VERSION,
  id: 'fixture-exporter',
  supportedBoundaries: ['none'],
  async export(batch) {
    return { batchId: batch.id, acceptedEventIds: [], acceptedRunIds: [] }
  },
}

// @ts-expect-error Exporter behavior references are immutable after definition.
exporter.export = async batch => ({
  batchId: batch.id,
  acceptedEventIds: [],
  acceptedRunIds: [],
})

const wrongFamilyProvider: ComposableModelProviderPlugin = {
  // @ts-expect-error A numeric API version alone cannot impersonate another family.
  kind: 'observation-exporter',
  apiVersion: PROVIDER_PLUGIN_API_VERSION,
  id: 'wrong-family',
  displayName: 'Wrong family',
  routes: ['wrong-family'],
  setup: () => undefined,
}

void wrongFamilyProvider

// @ts-expect-error Exporter shutdown ownership must never be inferred from object shape.
const ambiguousExporter: RuntimeObservationExporterRegistration = {
  exporter,
  requirement: 'best-effort',
  boundary: 'none',
}

void ambiguousExporter

// @ts-expect-error Executable credential resolvers use a versioned source object.
const unversionedCredential: CredentialInput = () => 'secret'

void unversionedCredential

const legacyCallbackPlugin = openAiPlugin({ apiKey: async () => 'secret' })
// @ts-expect-error Legacy callback overload is advanced-only, not normal runtime composition.
await createAgentRuntime({ providers: [legacyCallbackPlugin] })

const nonJsonSkillCandidate: RuntimeSkillCandidate = {
  id: 'non-json',
  name: 'Non JSON',
  description: 'Invalid locator fixture.',
  source: 'fixture',
  provider: 'fixture-skills',
  // @ts-expect-error Persisted skill locators must be JSON-safe values.
  locator: () => 'host object',
}

void nonJsonSkillCandidate

defineSkillProviderPlugin({
  id: 'bare-array-skills',
  // @ts-expect-error Discovery must return an opaque revision with candidates.
  async list() { return [] },
  async load() { return undefined },
})

defineToolSource({
  id: 'async-tool-source',
  // @ts-expect-error Invocation snapshots must be synchronous and atomic.
  async snapshot() { return { revision: 'invalid', tools: [] } },
})

const capturedTool = defineTool({
  name: 'captured-tool',
  description: 'Tool method table is immutable after definition.',
  parameters: { type: 'object', additionalProperties: false },
  execute: () => 'original',
})

// @ts-expect-error Bound local tool executable references are immutable.
capturedTool.execute = () => 'replaced'

const capturedApproval = fixedApprovalBroker('deny')
// @ts-expect-error Bound approval policy cannot be redirected after session binding.
capturedApproval.request = async () => 'allow'

const nonJsonNativeTool: NativeToolSchema = {
  type: 'native',
  name: 'web-search',
  // @ts-expect-error Built-in native tool configuration has no arbitrary host callbacks.
  resolve: () => 'host-only',
}

void nonJsonNativeTool

export function rejectLegacyHealthAsRuntimeEvidence(legacy: ObservationHealthSnapshot): void {
  // @ts-expect-error Legacy health has no integration loss counters.
  const runtimeHealth: RuntimeObservationHealthSnapshot = legacy
  void runtimeHealth
}

// @ts-expect-error An attempt start must include both attempt identity and number.
const missingAttemptIdentity: IntegrationOperationEvidenceFields = {
  integrationSchemaVersion: 1,
  integrationFamily: 'example-client',
  integrationOperation: 'request',
  operationId: 'operation-1',
  kind: 'attempt-start',
}
void missingAttemptIdentity

// @ts-expect-error A logical terminal must include status and duration.
const missingTerminalOutcome: IntegrationOperationEvidenceFields = {
  integrationSchemaVersion: 1,
  integrationFamily: 'example-client',
  integrationOperation: 'request',
  operationId: 'operation-1',
  kind: 'logical-terminal',
}
void missingTerminalOutcome
