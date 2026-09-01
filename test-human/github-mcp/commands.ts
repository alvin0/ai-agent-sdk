import { readFile } from 'node:fs/promises'
import type { ToolExecutionResult } from '@ai-agent-sdk/agent'
import type { JsonObject } from '@ai-agent-sdk/core'
import type { GitHubMcpCliConfig } from './config.ts'
import type { GitHubMcpToolCaller, GitHubMcpToolName } from './tools.ts'

export interface GitHubMcpCommandStep {
  readonly label: string
  readonly tool: GitHubMcpToolName
  readonly arguments: JsonObject
  readonly result: ToolExecutionResult
}

export async function runGitHubMcpCommand(
  config: GitHubMcpCliConfig,
  caller: GitHubMcpToolCaller,
  now: () => Date = () => new Date(),
): Promise<readonly GitHubMcpCommandStep[]> {
  if (config.command === 'tools') return []
  if (config.command === 'whoami') {
    return [await execute(caller, 'authenticated GitHub identity', 'get_me', {})]
  }
  if (config.command === 'read') {
    const args: JsonObject = {
      ...repositoryArgs(config),
      ...(config.path === undefined ? {} : { path: config.path }),
      ...(config.ref === undefined ? {} : { ref: config.ref }),
    }
    return [await execute(caller, 'read repository content', 'get_file_contents', args)]
  }

  const owner = requireConfig(config.owner, 'owner')
  const repo = requireConfig(config.repo, 'repo')
  const path = requireConfig(config.path, 'path')
  const branch = requireConfig(config.branch, 'branch')
  const content = await resolveContent(config, now)
  const readArgs: JsonObject = { owner, repo, path, ref: `refs/heads/${branch}` }
  const preflight = await execute(caller, 'preflight: target must not exist', 'get_file_contents', readArgs)

  if (!preflight.result.isError) {
    throw new Error(`refusing to overwrite '${owner}/${repo}:${branch}/${path}'; choose a new --path`)
  }
  if (!looksLikeNotFound(preflight.result.error.message)) {
    throw new Error(
      `could not prove that '${owner}/${repo}:${branch}/${path}' is absent; refusing write: ${preflight.result.error.message}`,
    )
  }

  const createArgs: JsonObject = {
    owner,
    repo,
    path,
    branch,
    message: config.message ?? 'test: add GitHub MCP human check',
    content,
  }
  const created = await execute(caller, 'create file (plaintext, no overwrite SHA)', 'create_or_update_file', createArgs)
  assertSuccess(created)
  const verified = await execute(caller, 'verify created file', 'get_file_contents', readArgs)
  assertSuccess(verified)
  return [preflight, created, verified]
}

async function resolveContent(config: GitHubMcpCliConfig, now: () => Date): Promise<string> {
  if (config.content !== undefined) return config.content
  if (config.contentFile !== undefined) return await readFile(config.contentFile, 'utf8')
  return `# GitHub MCP human test\n\nCreated through ai-agent-sdk at ${now().toISOString()}.\n`
}

async function execute(
  caller: GitHubMcpToolCaller,
  label: string,
  tool: GitHubMcpToolName,
  args: JsonObject,
): Promise<GitHubMcpCommandStep> {
  return { label, tool, arguments: args, result: await caller.call(tool, args) }
}

function repositoryArgs(config: GitHubMcpCliConfig): JsonObject {
  return {
    owner: requireConfig(config.owner, 'owner'),
    repo: requireConfig(config.repo, 'repo'),
  }
}

function requireConfig(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing ${name} after CLI validation`)
  return value
}

function looksLikeNotFound(message: string): boolean {
  return /\b404\b|not[ _-]?found|does not exist|could not resolve/i.test(message)
}

function assertSuccess(step: GitHubMcpCommandStep): void {
  if (step.result.isError) throw new Error(`${step.label} failed: ${step.result.error.message}`)
}
