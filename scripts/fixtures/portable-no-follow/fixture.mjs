import { createObservability } from '@alvin0/ai-agent-sdk-core/observability'
import { createMcpHttpClient } from '@alvin0/ai-agent-sdk-mcp'
import { fetchObservationExporter } from '@alvin0/ai-agent-sdk-observability-fetch'
import { createHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'
import {
  codexAdapter,
  memoryCodexCredentialStore,
  requestDeviceCode,
} from '@alvin0/ai-agent-sdk-provider-codex'

const protocol = Object.freeze({
  id: 'native-no-follow',
  defaultDialect: Object.freeze({}),
  endpointPath: () => '/start',
  serialize: request => ({ model: request.options.model }),
  async * translate() { yield { type: 'finish', reason: { kind: 'stop' } } },
})

export async function runPortableNoFollowFixture(endpoint) {
  const base = String(endpoint).replace(/\/+$/u, '')
  const provider = createHttpProvider({
    displayName: 'Native no-follow provider', protocol,
    baseUrl: `${base}/provider`, allowInsecureHttp: true,
    auth: { kind: 'bearer', token: 'private-provider-credential' },
  })
  const providerRejected = await rejects(async () => {
    for await (const _chunk of provider.stream({
      provider: 'native', model: 'native-model', messages: [],
    })) { /* a redirect must fail before protocol output */ }
  })

  const credentials = memoryCodexCredentialStore({
    tokens: {
      id_token: jwt({}),
      access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
      refresh_token: 'private-refresh-credential',
    },
  })
  const codex = codexAdapter({ authStore: credentials, baseUrl: `${base}/codex` })
  const codexCatalogRejected = await rejects(() => codex.modelCatalog('codex'))
  const codexOAuthRejected = await rejects(() => requestDeviceCode({
    issuer: `${base}/oauth`, allowInsecureIssuer: true,
  }))

  const mcp = createMcpHttpClient({
    serverName: 'native-no-follow', url: `${base}/mcp/start`,
    reconnect: false, legacySse: false, allowRedirects: false,
    allowPrivateNetwork: true,
    operationTimeoutMs: 5_000, closeTimeoutMs: 1_000,
  })
  const mcpRejected = await rejects(() => mcp.connect())
  await mcp.close()

  const observation = createObservability()
  const exporter = fetchObservationExporter({
    endpoint: `${base}/observability/start`, allowInsecureHttp: true,
    maxAttempts: 1,
  })
  await exporter.export({
    id: '33333333333333333333333333333333',
    resource: observation.resource,
    events: [],
    runRecords: [{ kind: 'run-terminal-record', runId: 'portable-no-follow-run' }],
  }, new AbortController().signal)

  const state = await fetch(`${base}/state`).then(response => response.json())
  return {
    providerRejected,
    codexCatalogRejected,
    codexOAuthRejected,
    mcpRejected,
    state,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}

export function assertPortableNoFollowResult(result, runtime) {
  const names = ['provider', 'codex', 'oauth', 'mcp', 'observability']
  const rejected = result.providerRejected && result.codexCatalogRejected
    && result.codexOAuthRejected && result.mcpRejected
  const counts = names.every(name => result.state?.[name]?.starts === 1
    && result.state?.[name]?.targets === 0)
  if (!rejected || !counts) {
    throw new Error(`${runtime} no-follow evidence is invalid: ${JSON.stringify(result)}`)
  }
}

async function rejects(operation) {
  try { await operation(); return false } catch { return true }
}

function jwt(payload) {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `e30.${encoded}.signature`
}
