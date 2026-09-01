#!/usr/bin/env node

import { UnauthorizedError } from '@modelcontextprotocol/client'
import { resolve } from 'node:path'
import { HumanArtifactRecorder } from '../artifacts.ts'
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
  const artifact = new HumanArtifactRecorder({
    harness: 'github-mcp', resultsRoot: config.resultsRoot ?? resolve('test-human/results/github-mcp'),
    ...(config.runId === undefined ? {} : { runId: config.runId }),
  })
  const artifactConfig = {
    command: config.command, auth: config.auth, url: config.url,
    ...(config.owner === undefined ? {} : { owner: config.owner }),
    ...(config.repo === undefined ? {} : { repo: config.repo }),
    ...(config.path === undefined ? {} : { path: config.path }),
    ...(config.ref === undefined ? {} : { ref: config.ref }),
    ...(config.branch === undefined ? {} : { branch: config.branch }),
    ...(config.content === undefined ? {} : { content: config.content }),
    ...(config.contentFile === undefined ? {} : { contentFile: config.contentFile }),
  }
  artifact.record('config', artifactConfig)
  if (config.dryRun) {
    const summary = await artifact.finish({ status: 'dry-run', config: artifactConfig })
    console.log(`[github-mcp/artifact] ${summary.artifact.directory}`)
    return
  }

  const oauth = config.auth.kind === 'oauth'
    ? new GitHubOAuthRuntime({
      ...config.auth,
      onStatus: message => { console.log(`[oauth] ${message}`) },
    })
    : undefined
  const connection = createGitHubMcpConnection(config, {
    ...(oauth === undefined ? {} : { oauthProvider: oauth.provider }),
    onStateChange: state => {
      artifact.record('mcp-lifecycle', state)
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
  let stepCount = 0
  let discoveredTools = 0
  let failure: unknown
  try {
    await oauth?.start()
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
    discoveredTools = connection.tools.names().length
    artifact.record('mcp-tools', { names: connection.tools.names() })
    if (config.command !== 'tools') {
      const steps = await runGitHubMcpCommand(config, createGitHubMcpToolCaller(connection.tools))
      stepCount = steps.length
      for (const step of steps) {
        artifact.record('command-step', step)
        console.log(renderGitHubMcpStep(step, config.maxOutputChars))
      }
    }
  } catch (error: unknown) {
    failure = error
    throw error
  } finally {
    await Promise.allSettled([connection.close(), oauth?.close()])
    const summary = await artifact.finish({
      status: failure === undefined ? 'passed' : 'failed', config: artifactConfig,
      invariants: [{ name: 'GitHub MCP command completed', passed: failure === undefined }],
      metrics: { command: config.command, stepCount, discoveredTools },
      ...(failure === undefined ? {} : { error: failure }),
    })
    const line = `[github-mcp/artifact] ${summary.artifact.directory}`
    if (failure === undefined) console.log(line)
    else console.error(line)
  }
}

main().catch((error: unknown) => {
  console.error(`[github-mcp] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
