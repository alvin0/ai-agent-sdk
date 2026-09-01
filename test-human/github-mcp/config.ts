export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'

export type GitHubMcpCommand = 'whoami' | 'read' | 'tools' | 'create-file'

export type GitHubMcpAuth =
  | { readonly kind: 'pat'; readonly token: string }
  | {
    readonly kind: 'oauth'
    readonly clientId: string
    readonly clientSecret: string
    readonly redirectUrl: string
    readonly callbackTimeoutMs: number
    readonly openBrowser: boolean
  }

export interface GitHubMcpCliConfig {
  readonly help: false
  readonly command: GitHubMcpCommand
  readonly auth: GitHubMcpAuth
  readonly url: string
  readonly owner?: string
  readonly repo?: string
  readonly path?: string
  readonly ref?: string
  readonly branch?: string
  readonly content?: string
  readonly contentFile?: string
  readonly message?: string
  readonly maxOutputChars: number
}

export interface GitHubMcpHelpConfig {
  readonly help: true
}

export type ParsedGitHubMcpConfig = GitHubMcpCliConfig | GitHubMcpHelpConfig

export function parseGitHubMcpArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedGitHubMcpConfig {
  if (args.includes('--help') || args.includes('-h')) return { help: true }

  const command = parseCommand(args[0])
  const rest = command.consumed ? args.slice(1) : args
  const values = new Map<string, string>()
  const switches = new Set<string>()

  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]
    if (item === undefined) continue
    if (item === '--confirm-write' || item === '--no-open-browser') {
      switches.add(item)
      continue
    }
    if (!item.startsWith('--')) throw new TypeError(`unexpected argument '${item}'`)
    if (!VALUE_FLAGS.has(item)) throw new TypeError(`unknown option '${item}'`)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new TypeError(`${item} requires a value`)
    if (values.has(item)) throw new TypeError(`${item} may only be supplied once`)
    values.set(item, value)
    index += 1
  }

  const repo = values.get('--repo')
  const repository = repo === undefined ? undefined : parseRepository(repo)
  const maxOutputChars = parsePositiveInteger(values.get('--max-output-chars') ?? '12000', '--max-output-chars')
  const url = values.get('--url') ?? firstNonEmpty(env.GITHUB_MCP_URL) ?? GITHUB_MCP_URL
  assertHttpUrl(url)
  const auth = resolveAuth(values, switches, env)
  if (auth.kind === 'oauth' && new URL(url).origin !== new URL(GITHUB_MCP_URL).origin) {
    throw new TypeError('OAuth app credentials may only be sent through the official GitHub MCP origin; use PAT for a custom --url')
  }

  if ((command.value === 'read' || command.value === 'create-file') && repository === undefined) {
    throw new TypeError(`${command.value} requires --repo owner/name`)
  }

  if (command.value === 'create-file') {
    if (!switches.has('--confirm-write')) {
      throw new TypeError('create-file is a remote write; add --confirm-write to authorize it')
    }
    const branch = required(values, '--branch')
    const path = required(values, '--path')
    assertBranch(branch)
    assertRepositoryPath(path)
    const content = values.get('--content')
    const contentFile = values.get('--content-file')
    if (repository === undefined) throw new TypeError('create-file requires --repo owner/name')
    if (content !== undefined && contentFile !== undefined) {
      throw new TypeError('use either --content or --content-file, not both')
    }
    return {
      help: false,
      command: command.value,
      auth,
      url,
      owner: repository.owner,
      repo: repository.repo,
      branch,
      path,
      ...(content === undefined ? {} : { content }),
      ...(contentFile === undefined ? {} : { contentFile }),
      message: values.get('--message') ?? 'test: add GitHub MCP human check',
      maxOutputChars,
    }
  }

  const path = values.get('--path') ?? (command.value === 'read' ? 'README.md' : undefined)
  if (path !== undefined) assertRepositoryPath(path)
  const ref = values.get('--ref')
  return {
    help: false,
    command: command.value,
    auth,
    url,
    ...(repository === undefined ? {} : { owner: repository.owner, repo: repository.repo }),
    ...(path === undefined ? {} : { path }),
    ...(ref === undefined ? {} : { ref: normalizeRef(ref) }),
    maxOutputChars,
  }
}

export function gitHubMcpHelp(): string {
  return `GitHub MCP human test

Authentication (PowerShell):
  # OAuth 2.1 (recommended; create/register a GitHub App or OAuth App first)
  $env:GITHUB_MCP_OAUTH_CLIENT_ID = '<client id>'
  $env:GITHUB_MCP_OAUTH_CLIENT_SECRET = '<client secret>'
  npm run human:mcp:github -- whoami

  # PAT fallback for CI/headless runs
  $env:GITHUB_TOKEN = '<fine-grained PAT or GitHub token>'

Commands:
  npm run human:mcp:github -- whoami
  npm run human:mcp:github -- tools
  npm run human:mcp:github -- read --repo github/github-mcp-server --path README.md
  npm run human:mcp:github -- read --repo owner/repo --path src/index.ts --ref main
  npm run human:mcp:github -- create-file --repo owner/repo --branch mcp-test --path mcp-human-test/check.md --content "hello from MCP" --confirm-write
  npm run human:mcp:github -- create-file --repo owner/repo --branch mcp-test --path mcp-human-test/check.md --content-file ./note.md --confirm-write

Options:
  --auth <auto|oauth|pat>     Auto prefers PAT when present, otherwise configured OAuth
  --oauth-redirect-url <url>  Registered loopback callback (default http://127.0.0.1:8765/oauth/callback)
  --oauth-timeout-seconds <n> Browser callback timeout (default 180)
  --no-open-browser           Print the authorization URL without launching it
  --url <url>                 Override the official remote GitHub MCP endpoint
  --max-output-chars <count>  Limit displayed model-facing text (default 12000)
  --help                      Show this help without requiring credentials

Safety:
  whoami/read/tools request read-only MCP tools. create-file is create-only:
  it refuses an existing path, never sends a blob SHA, and verifies the file by reading it back.
  Tokens are intentionally accepted only through environment variables.`
}

const VALUE_FLAGS = new Set([
  '--repo', '--path', '--ref', '--branch', '--content', '--content-file', '--message',
  '--url', '--max-output-chars', '--auth', '--oauth-redirect-url', '--oauth-timeout-seconds',
])

function resolveAuth(
  values: ReadonlyMap<string, string>,
  switches: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): GitHubMcpAuth {
  const requested = values.get('--auth') ?? 'auto'
  if (requested !== 'auto' && requested !== 'oauth' && requested !== 'pat') {
    throw new TypeError('--auth must be auto, oauth, or pat')
  }
  const token = firstNonEmpty(env.GITHUB_MCP_TOKEN, env.GITHUB_TOKEN, env.GITHUB_PERSONAL_ACCESS_TOKEN)
  const clientId = firstNonEmpty(env.GITHUB_MCP_OAUTH_CLIENT_ID)
  const clientSecret = firstNonEmpty(env.GITHUB_MCP_OAUTH_CLIENT_SECRET)

  if (requested === 'pat' || (requested === 'auto' && token !== undefined)) {
    if (token === undefined) {
      throw new TypeError('PAT authentication requires GITHUB_MCP_TOKEN, GITHUB_TOKEN, or GITHUB_PERSONAL_ACCESS_TOKEN')
    }
    return { kind: 'pat', token }
  }
  if (clientId === undefined || clientSecret === undefined) {
    throw new TypeError(
      'OAuth authentication requires GITHUB_MCP_OAUTH_CLIENT_ID and GITHUB_MCP_OAUTH_CLIENT_SECRET. '
      + 'GitHub Remote MCP does not currently support Dynamic Client Registration; use --auth pat as a fallback.',
    )
  }
  const redirectUrl = values.get('--oauth-redirect-url')
    ?? firstNonEmpty(env.GITHUB_MCP_OAUTH_REDIRECT_URL)
    ?? 'http://127.0.0.1:8765/oauth/callback'
  assertLoopbackRedirectUrl(redirectUrl)
  const timeoutSeconds = parsePositiveInteger(
    values.get('--oauth-timeout-seconds') ?? firstNonEmpty(env.GITHUB_MCP_OAUTH_TIMEOUT_SECONDS) ?? '180',
    '--oauth-timeout-seconds',
  )
  return {
    kind: 'oauth',
    clientId,
    clientSecret,
    redirectUrl,
    callbackTimeoutMs: timeoutSeconds * 1_000,
    openBrowser: !switches.has('--no-open-browser'),
  }
}

function parseCommand(value: string | undefined): { value: GitHubMcpCommand; consumed: boolean } {
  if (value === undefined || value.startsWith('--')) return { value: 'whoami', consumed: false }
  if (value === 'whoami' || value === 'read' || value === 'tools' || value === 'create-file') {
    return { value, consumed: true }
  }
  throw new TypeError(`unknown command '${value}'`)
}

function parseRepository(value: string): { owner: string; repo: string } {
  const parts = value.split('/')
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new TypeError("--repo must use the exact 'owner/name' form")
  }
  return { owner: parts[0] as string, repo: parts[1] as string }
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag)
  if (value === undefined || value.trim().length === 0) throw new TypeError(`${flag} is required`)
  return value
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find(value => value !== undefined && value.trim().length > 0)?.trim()
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${flag} must be a positive integer`)
  return parsed
}

function assertHttpUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('--url must use HTTP or HTTPS')
}

function assertLoopbackRedirectUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('--oauth-redirect-url must be an HTTP loopback URL')
  }
  if (url.port.length === 0 || Number(url.port) === 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError('--oauth-redirect-url requires a fixed non-zero port and must not contain query or fragment')
  }
}

function assertRepositoryPath(value: string): void {
  const segments = value.replaceAll('\\', '/').split('/')
  if (value.startsWith('/') || value.endsWith('/') || segments.some(part => part === '..' || part.length === 0)) {
    throw new TypeError('--path must be a relative repository file path without empty or parent segments')
  }
}

function assertBranch(value: string): void {
  if (value.startsWith('/') || value.endsWith('/') || value.includes('..') || value.includes('@{')
    || /[\s~^:?*[\\]/.test(value)) {
    throw new TypeError('--branch is not a safe Git branch name')
  }
}

function normalizeRef(value: string): string {
  return value.startsWith('refs/') ? value : `refs/heads/${value}`
}
