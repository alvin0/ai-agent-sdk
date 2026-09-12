/**
 * Behavioural tests for `Copilot_Login_Cli` (Requirement 6.6).
 *
 * Feature: github-copilot-provider — supplementary CLI-surface verification.
 *
 * This file is the OPTIONAL layer of the plan: every SHALL the CLI touches is
 * already carried by a mandatory task (6.6 by the bin-entry configuration test,
 * 9.8 by Property 35, 13.7 by Property 50). What is added here is the one thing
 * those cannot see — that the three flags a user actually types reach the right
 * code path, and that no command prints a token value even when it is holding
 * two of them.
 *
 * ## Why the CLI runs IN-PROCESS rather than as a child process
 *
 * `src/copilot-cli.ts` is a top-level-await module: importing it IS running it.
 * That makes a fresh `import()` per case a complete invocation, with
 * `process.argv` as the input and `process.exitCode` plus stdout as the output —
 * which is exactly what a spawned process would give, minus a build step.
 *
 * A child process was the other candidate and is strictly worse here for two
 * reasons, both structural rather than a matter of taste:
 *
 * - **It would need a build.** The bin entry loads `dist/copilot-cli.mjs`, and
 *   this package's `test` script does not build. A spec that silently tests a
 *   stale `dist` is worse than one that tests the source.
 * - **A local server cannot stand in for the endpoints.** All three Copilot
 *   origins are pinned by `issuerOf`, which refuses `http:` unless
 *   `allowInsecureIssuer` is set — and the CLI does not expose that option. On
 *   top of that `--models` reads `COPILOT_BASE_URL`, a hard-coded constant with
 *   no flag at all, so `http://127.0.0.1` could not be reached even in
 *   principle. Injecting `globalThis.fetch` keeps the real production URLs,
 *   real pinning and real parsing, and still touches no network.
 *
 * The one thing the in-process form must be careful about is `spawn`: the device
 * flow opens a browser best-effort, and a test run has no business launching
 * one. `node:child_process` is mocked for that reason and that reason only.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import type { CopilotAuthFile } from '../../packages/provider-copilot/src/index.ts'
import { fileCopilotCredentialStore } from '../../packages/auth-node/src/copilot-store.ts'

// `openBrowser` fires a detached `spawn` the moment the device prompt renders.
// Left alone, `--force` would open a real browser window on the machine running
// the suite.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: () => ({ unref: (): void => undefined }) }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLI_MODULE = '../../packages/auth-node/src/copilot-cli.ts'

/** The two credential values that must never reach stdout, in either tier. */
const USER_TOKEN = 'ghu_cli_spec_user_token_value'
const API_TOKEN = 'tid=cli-spec;exp=1;sku=copilot;copilot_api_token_value'

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'copilot-login-cli-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A credential path of its own per case, so no case can observe another's file. */
function credentialPath(name: string): string {
  return join(root, name, 'auth.json')
}

/** Write a signed-in credential through the store the CLI itself reads. */
async function signedIn(path: string, token = USER_TOKEN): Promise<void> {
  const file: CopilotAuthFile = {
    version: 1,
    github: { token, tokenType: 'bearer', scope: 'read:user' },
    account: { login: 'octocat', id: 4_242, name: 'Octo Cat' },
    clientId: 'Iv1.cli-spec',
  }
  await fileCopilotCredentialStore(path).commit(
    { value: file, expectedRevision: null },
    { signal: new AbortController().signal, logger: NULL_LOGGER },
  )
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** The successful token-exchange body, expiring in ten minutes. */
const exchangeBody = (): unknown => ({
  token: API_TOKEN,
  expires_at: Math.floor(Date.now() / 1_000) + 600,
  refresh_in: 300,
  endpoints: { api: 'https://api.githubcopilot.com' },
})

/**
 * A catalog covering all three endpoint sources plus both non-generation
 * outcomes, so `--models` has something to be right or wrong about:
 * a stated `responses: false` (catalog), a `gpt-5` prefix (allowlist), an id
 * neither knows (default), an embedding entry, and an entry this SDK cannot
 * describe (omitted).
 */
const catalogBody = (): unknown => ({
  data: [
    { id: 'gpt-4o', name: 'GPT-4o', capabilities: { type: 'chat', supports: { responses: false } } },
    { id: 'gpt-5-mini', capabilities: { type: 'chat' } },
    { id: 'claude-sonnet-4', capabilities: { type: 'chat' } },
    { id: 'text-embedding-3-small', capabilities: { type: 'embeddings', family: 'text-embedding' } },
    { id: 'mystery-model', capabilities: { type: 'realtime' } },
  ],
})

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

interface CliRun {
  readonly exitCode: number | undefined
  readonly output: string
  /** Every URL the run dispatched, in order. */
  readonly requests: readonly string[]
}

/** SGR sequences are noise for an assertion; the CLI colours nearly every line. */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[\d;]*m/g, '')
}

/**
 * Run the CLI once with the given argv and the given endpoint behaviour.
 *
 * `vi.resetModules()` is what makes a second run a second RUN: without it the
 * module registry would hand back the already-evaluated module and the argv
 * would never be read again.
 */
async function runCli(args: readonly string[], handler: FetchHandler): Promise<CliRun> {
  const previousArgv = process.argv
  const previousExitCode = process.exitCode
  const previousFetch = globalThis.fetch
  const chunks: string[] = []
  const requests: string[] = []
  const write = vi.spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
      return true
    })
  process.argv = ['node', 'copilot-cli.mjs', ...args]
  process.exitCode = undefined
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push(url)
    return handler(url, init)
  }) as typeof globalThis.fetch
  try {
    vi.resetModules()
    await import(CLI_MODULE)
    return {
      exitCode: typeof process.exitCode === 'number' ? process.exitCode : undefined,
      output: stripAnsi(chunks.join('')),
      requests,
    }
  } finally {
    write.mockRestore()
    process.argv = previousArgv
    // The CLI sets `process.exitCode` on the vitest process itself; leaving a 1
    // behind would fail the whole run.
    process.exitCode = previousExitCode
    globalThis.fetch = previousFetch
  }
}

/** Refuse any request the case under test did not expect. */
const noNetwork: FetchHandler = (url) => {
  throw new Error(`unexpected request to ${url}`)
}

/** Serve the token exchange, and the catalog when the case gets that far. */
const copilotEndpoints = (exchange: () => Response): FetchHandler => (url) => {
  if (url.startsWith('https://api.github.com/copilot_internal/v2/token')) return exchange()
  if (url.startsWith('https://api.githubcopilot.com/models')) return json(catalogBody())
  throw new Error(`unexpected request to ${url}`)
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

describe('Copilot_Login_Cli --status', () => {
  it('reports an empty store as not signed in, without contacting anything', async () => {
    const path = credentialPath('status-empty')
    const run = await runCli(['--status', '--path', path], noNetwork)

    expect(run.output).toContain('copilot: not signed in')
    expect(run.output).toContain(path)
    // The exchange is the only network call `--status` makes, and an absent
    // credential is answered before it: there is nothing to exchange.
    expect(run.requests).toEqual([])
    expect(run.exitCode).toBe(1)
  })

  it('proves a stored credential with one trial exchange and prints no token', async () => {
    const path = credentialPath('status-signed-in')
    await signedIn(path)
    const run = await runCli(
      ['--status', '--path', path],
      copilotEndpoints(() => json(exchangeBody())),
    )

    expect(run.output).toContain('copilot: signed in')
    expect(run.output).toContain('login    : octocat')
    expect(run.output).toContain('account  : 4242')
    expect(run.output).toContain('scope    : read:user')
    expect(run.output).toMatch(/exchange : ok \(api token valid for ~\d+s\)/)
    // The declared endpoint is a diagnostic, and saying so is half of its value.
    expect(run.output).toContain('declared : https://api.githubcopilot.com')
    expect(run.output).toContain('never used as a base URL')
    expect(run.requests).toEqual(['https://api.github.com/copilot_internal/v2/token'])
    expect(run.exitCode).toBe(0)

    // Requirement 13.7 over BOTH tiers: the CLI held the user token to send it
    // and the API token to measure its expiry, and printed neither.
    expect(run.output).not.toContain(USER_TOKEN)
    expect(run.output).not.toContain(API_TOKEN)
  })

  it('fails when the exchange refuses the credential, quoting no token value', async () => {
    const path = credentialPath('status-rejected')
    await signedIn(path)
    const run = await runCli(
      ['--status', '--path', path],
      // A body that echoes the credential back: the redaction has to hold on the
      // way to the message, not only on the way to a log record.
      copilotEndpoints(() => json({ message: `bad credentials: ${USER_TOKEN}` }, 401)),
    )

    expect(run.output).toContain('copilot: signed in')
    expect(run.output).toContain('exchange : failed')
    expect(run.output).not.toContain(USER_TOKEN)
    expect(run.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// --models
// ---------------------------------------------------------------------------

describe('Copilot_Login_Cli --models', () => {
  it('prints the endpoint chosen for each model and who chose it', async () => {
    const path = credentialPath('models-ok')
    await signedIn(path)
    const run = await runCli(
      ['--models', '--path', path],
      copilotEndpoints(() => json(exchangeBody())),
    )

    // The two facts that make this the provider's best diagnostic: WHICH
    // endpoint, and WHO decided. One line per model, all three sources.
    expect(run.output).toMatch(/gpt-4o\s+chat-completions\s+catalog · /)
    expect(run.output).toMatch(/gpt-5-mini\s+responses\s+allowlist · /)
    expect(run.output).toMatch(/claude-sonnet-4\s+chat-completions\s+default · /)
    expect(run.output).toContain('copilot: embedding models')
    expect(run.output).toContain('text-embedding-3-small')
    // Advisory, not a failure.
    expect(run.output).toContain('omitted entries (advisory)')
    expect(run.output).toContain('mystery-model — capability-type-unrecognized')
    expect(run.requests).toEqual([
      'https://api.github.com/copilot_internal/v2/token',
      'https://api.githubcopilot.com/models',
    ])
    expect(run.exitCode).toBe(0)

    expect(run.output).not.toContain(USER_TOKEN)
    expect(run.output).not.toContain(API_TOKEN)
  })

  it('names the login command instead of an exchange when no credential exists', async () => {
    const path = credentialPath('models-empty')
    const run = await runCli(['--models', '--path', path], noNetwork)

    expect(run.output).toContain('npm run provider:copilot:login-device')
    expect(run.requests).toEqual([])
    expect(run.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// --force
// ---------------------------------------------------------------------------

describe('Copilot_Login_Cli --force', () => {
  it('stops at the stored credential when the flag is absent', async () => {
    const path = credentialPath('force-absent')
    await signedIn(path)
    const run = await runCli(['--path', path], noNetwork)

    expect(run.output).toContain('copilot: already signed in as octocat')
    expect(run.output).toContain('pass --force to sign in again, or --status to verify')
    // The point of the branch: a credential that exists is not re-fetched.
    expect(run.requests).toEqual([])
    expect(run.exitCode).toBe(0)
    expect(run.output).not.toContain(USER_TOKEN)
  })

  it('runs the device flow over an existing credential and replaces it', async () => {
    const path = credentialPath('force-present')
    await signedIn(path, 'ghu_stale_previous_token')
    const issuer = 'https://github.example.test'
    const run = await runCli(
      ['--force', '--path', path, '--issuer', issuer],
      (url) => {
        if (url === `${issuer}/login/device/code`) {
          return json({
            device_code: 'device-code-value',
            user_code: 'WXYZ-4321',
            verification_uri: `${issuer}/login/device`,
            expires_in: 900,
            interval: 1,
          })
        }
        if (url === `${issuer}/login/oauth/access_token`) {
          return json({
            access_token: USER_TOKEN,
            token_type: 'bearer',
            scope: 'read:user',
            login: 'octocat',
            id: 4_242,
          })
        }
        throw new Error(`unexpected request to ${url}`)
      },
    )

    expect(run.output).toContain('Sign in to GitHub Copilot')
    expect(run.output).toContain('WXYZ-4321')
    expect(run.output).toContain(`${issuer}/login/device`)
    // The anti-phishing sentence is part of the prompt, not decoration.
    expect(run.output).toContain('Only continue if YOU started this login')
    expect(run.output).toContain('copilot: signed in')
    expect(run.output).toContain('login    : octocat')
    expect(run.requests).toEqual([
      `${issuer}/login/device/code`,
      `${issuer}/login/oauth/access_token`,
    ])
    expect(run.exitCode).toBe(0)

    // The user code is displayed; the token it produced is not.
    expect(run.output).not.toContain(USER_TOKEN)

    // `--force` means the new credential actually landed on disk.
    const stored = await fileCopilotCredentialStore(path).read({
      signal: new AbortController().signal, logger: NULL_LOGGER,
    })
    expect(stored?.value.github.token).toBe(USER_TOKEN)
  })
})

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

describe('Copilot_Login_Cli argument handling', () => {
  it('refuses an unknown flag rather than falling through to a login', async () => {
    const run = await runCli(['--stat'], noNetwork)

    expect(run.output).toContain('copilot: unknown flag "--stat"')
    expect(run.requests).toEqual([])
    expect(run.exitCode).toBe(1)
  })
})
