#!/usr/bin/env node

import { UnauthorizedError } from '@modelcontextprotocol/client'
import { createGitHubMcpConnection } from './connection.ts'
import { gitHubMcpHelp, parseGitHubMcpArgs } from './config.ts'
import { runGitHubMcpCommand } from './commands.ts'
import { renderGitHubMcpStep } from './output.ts'
import { GitHubOAuthRuntime } from './oauth.ts'
import { createGitHubMcpToolCaller } from './tools.ts'

async function main(): Promise<void> {
  const config = parseGitHubMcpArgs(process.argv.slice(2))
  if (config.help) {
    console.log(gitHubMcpHelp())
    return
  }

  const oauth = config.auth.kind === 'oauth'
    ? new GitHubOAuthRuntime({
      ...config.auth,
      onStatus: message => { console.log(`[oauth] ${message}`) },
    })
    : undefined
  await oauth?.start()

  const connection = createGitHubMcpConnection(config, {
    ...(oauth === undefined ? {} : { oauthProvider: oauth.provider }),
    onStateChange: state => {
      const suffix = state.error === undefined ? '' : `: ${state.error.message}`
      const auth = state.authorization === undefined
        ? ''
        : ` auth=${state.authorization.kind}/${state.authorization.reason}`
          + (state.authorization.requiredScope === undefined ? '' : ` scope=${state.authorization.requiredScope}`)
      const protocol = state.protocol === undefined
        ? ''
        : ` protocol=${state.protocol.era}/${state.protocol.version ?? 'unknown'}`
          + ` transport=${state.protocol.transport}${state.protocol.fallback ? '(fallback)' : ''}`
      console.log(`[mcp/lifecycle] ${state.status}${auth}${protocol}${suffix}`)
    },
  })
  try {
    try {
      await connection.connect()
    } catch (error: unknown) {
      if (oauth === undefined || !UnauthorizedError.isInstance(error)) throw error
      console.log('[oauth] Waiting for the localhost authorization callback...')
      const callback = await oauth.waitForCallback()
      const expectedState = oauth.provider.expectedState
      if (expectedState === undefined) throw new Error('OAuth provider did not generate a state value')
      await connection.finishOAuth(callback, { expectedState })
      console.log('[oauth] Authorization completed; MCP connection is ready.')
    }
    console.log(`[mcp/tools] ${connection.tools.names().join(', ')}`)
    if (config.command === 'tools') return
    const steps = await runGitHubMcpCommand(config, createGitHubMcpToolCaller(connection.tools))
    for (const step of steps) console.log(renderGitHubMcpStep(step, config.maxOutputChars))
  } finally {
    await connection.close()
    await oauth?.close()
  }
}

main().catch((error: unknown) => {
  console.error(`[github-mcp] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
