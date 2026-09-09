import type { ToolExecutionResult } from '@alvin0/ai-agent-sdk-core/agent'
import type { GitHubMcpCommandStep } from './commands.ts'

export function renderGitHubMcpStep(step: GitHubMcpCommandStep, maxChars: number): string {
  return JSON.stringify({
    step: step.label,
    tool: step.tool,
    arguments: redactLargeArguments(step.arguments),
    result: summarizeResult(step.result, maxChars),
  }, null, 2)
}

function summarizeResult(result: ToolExecutionResult, maxChars: number): unknown {
  if (result.isError) return { isError: true, error: result.error }
  let remaining = maxChars
  const content = result.content.map(block => {
    if (block.type !== 'text') return { type: block.type, detail: 'non-text MCP content' }
    const text = block.text.slice(0, remaining)
    remaining = Math.max(0, remaining - text.length)
    return {
      type: 'text',
      text: block.text.length === text.length ? text : `${text}\n... <output truncated>`,
    }
  })
  return { isError: false, content, meta: result.meta }
}

function redactLargeArguments(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    key === 'content' && typeof value === 'string' ? `<${value.length} plaintext characters>` : value,
  ]))
}
