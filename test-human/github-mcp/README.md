# GitHub MCP human test

This command connects the SDK MCP client to GitHub's official remote MCP
server. It exercises the real HTTP handshake, authentication, `tools/list`, the
SDK namespaced `ToolCatalog`, the SDK tool pipeline, and GitHub tool execution.

## OAuth 2.1 login

GitHub Remote MCP currently does not support Dynamic Client Registration. Create
a dedicated GitHub App or OAuth App and register this exact callback URL:

```text
http://127.0.0.1:8765/oauth/callback
```

Then provide its credentials through the environment:

```powershell
$env:GITHUB_MCP_OAUTH_CLIENT_ID = '<client id>'
$env:GITHUB_MCP_OAUTH_CLIENT_SECRET = '<client secret>'
npm run human:mcp:github -- whoami
```

The command starts the loopback callback before connecting, follows the MCP
server's `WWW-Authenticate` discovery instead of hard-coding GitHub OAuth
endpoints, opens the browser, validates OAuth `state`, exchanges the code with
PKCE, and reconnects on a fresh MCP transport. Use `--no-open-browser` on a
headless terminal and open the printed URL manually.

This human test intentionally keeps access/refresh tokens in process memory and
does not write secrets to a plaintext project file. Therefore a new CLI process
logs in again. A production desktop host should back `OAuthClientProvider` with
the platform keychain; a web host should keep the client secret and token store
on its backend.

## PAT fallback

For CI or a quick headless run, set a token in the environment so it does not
appear in shell history:

```powershell
$env:GITHUB_TOKEN = '<fine-grained PAT or GitHub token>'
npm run human:mcp:github -- whoami --auth pat
```

Inspect the authenticated account or read a public/reachable repository file:

```powershell
npm run human:mcp:github -- whoami
npm run human:mcp:github -- read --repo github/github-mcp-server --path README.md
npm run human:mcp:github -- read --repo owner/repo --path src/index.ts --ref main
```

Show the exact tools discovered through MCP:

```powershell
npm run human:mcp:github -- tools
```

Create and verify a new file on an existing branch:

```powershell
npm run human:mcp:github -- create-file `
  --repo owner/repo `
  --branch mcp-test `
  --path mcp-human-test/check.md `
  --content "hello from GitHub MCP" `
  --confirm-write
```

For a larger file, replace `--content` with `--content-file ./note.md`. The
content is sent as plaintext, matching GitHub MCP's tool schema.

## Write safety

- Read commands send `X-MCP-Readonly: true` and request only `get_me` and
  `get_file_contents`.
- Write mode is unavailable unless `--confirm-write` is present.
- The target branch must already exist.
- The command first calls `get_file_contents`. It proceeds only when GitHub
  clearly reports that the path is absent.
- It never supplies an existing blob SHA, so this test does not support update
  or overwrite.
- It reads the file back after creation and fails when verification fails.

Use `npm run human:mcp:github -- --help` for all options. Override the endpoint
only for compatible gateways with `GITHUB_MCP_URL` or `--url`. To prevent OAuth
app-secret exfiltration, custom origins are accepted only in PAT mode.
