import {
  createHttpProvider,
  type AuthScheme,
  type CredentialSource,
  type HttpModelAdapter,
  type HttpProviderOptions,
  type ModelDiscoveryContext,
  type ProviderCatalogModel,
  type ProviderRequestLogRecord,
  type WireProtocol,
  type WireProtocolChunk,
} from '@compat/provider-http'
import {
  openAiAdapter,
  type OpenAiAdapterOptions,
  type OpenAiCredential,
} from '@compat/provider-openai'
import {
  anthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicCredential,
} from '@compat/provider-anthropic'
import {
  codexAdapter,
  type CodexAdapterOptions,
  type CodexAuthStore,
} from '@compat/provider-codex-signatures'

interface FixtureDialect { optionalFlag: boolean }

const callbackCredential: CredentialSource = async signal => {
  signal?.throwIfAborted()
  return 'fixture-secret'
}
const openAiCredential: OpenAiCredential = callbackCredential
const anthropicCredential: AnthropicCredential = callbackCredential

const protocol: WireProtocol<FixtureDialect> = {
  id: 'compatibility-wire',
  defaultDialect: { optionalFlag: false },
  endpointPath: () => '/messages',
  async serialize() { return { model: 'fixture' } },
  async *translate(): AsyncGenerator<WireProtocolChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const dynamicAuth: AuthScheme = {
  kind: 'dynamic',
  async resolve(signal, context) {
    signal?.throwIfAborted()
    void context
    return { authorization: 'fixture-secret' }
  },
}

const model: ProviderCatalogModel = { id: 'fixture-model' }
model.name = 'Mutable compatibility model'

const httpOptions: HttpProviderOptions<FixtureDialect> = {
  displayName: 'Compatibility HTTP',
  protocol,
  baseUrl: 'https://provider.example.test',
  auth: dynamicAuth,
  models: [model],
  async discoverModels(context: ModelDiscoveryContext) {
    const baseUrl: string = context.baseUrl
    void baseUrl
    context.signal?.throwIfAborted()
    return [model]
  },
}
httpOptions.baseUrl = 'https://provider-2.example.test'

const httpAdapter: HttpModelAdapter = createHttpProvider(httpOptions)
const openAiOptions: OpenAiAdapterOptions = { apiKey: openAiCredential }
const anthropicOptions: AnthropicAdapterOptions = { apiKey: anthropicCredential }
openAiOptions.baseUrl = 'https://openai.example.test/v1'
anthropicOptions.version = 'compatibility-version'
const openAiHttpAdapter: HttpModelAdapter = openAiAdapter(openAiOptions)
const anthropicHttpAdapter: HttpModelAdapter = anthropicAdapter(anthropicOptions)

const legacyCodexStore: CodexAuthStore = {
  location: '/fixture/auth.json',
  async read() { return undefined },
  async write() {},
}
const codexOptions: CodexAdapterOptions = { authStore: legacyCodexStore }
codexOptions.baseUrl = 'https://codex.example.test'
const codexHttpAdapter: HttpModelAdapter = codexAdapter(codexOptions)

export const providerSignatureCompatibility = {
  httpAdapter,
  openAiHttpAdapter,
  anthropicHttpAdapter,
  codexHttpAdapter,
}

export function inspectRequest(record: ProviderRequestLogRecord): unknown {
  return record.body
}
