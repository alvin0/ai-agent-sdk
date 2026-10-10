import { relative } from 'node:path'
import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import { json, card, optionalString, requireString } from './values'
import { inRoot } from './paths'
import { publishOutput } from './command-output'
import type { CommandOutcome } from './shell'
import { runShell } from './shell'

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

export function runCommandTool(root: string) {
  return defineTool({
    name: 'run_command',
    description: 'Run a shell command with the workspace as its working directory. '
      + 'Returns the interleaved output and the exit code; a non-zero exit is reported, not thrown.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Workspace-relative working directory, default the root.' },
        timeoutMs: { type: 'number', description: 'Kill the command after this long, default 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    parse: raw => ({
      command: requireString(raw, 'command'),
      cwd: optionalString(raw, 'cwd') ?? '.',
      timeoutMs: Number((raw as { timeoutMs?: unknown }).timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
    }),
    execute: async ({ command, cwd, timeoutMs }, context) => {
      const absolute = inRoot(root, cwd)
      const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, 600_000)
        : DEFAULT_COMMAND_TIMEOUT_MS
      // Tagged with the call id so a run can match the output to the row it is
      // already showing for this call.
      const outcome = await runShell(command, absolute, budget, (chunk) => {
        publishOutput(context.callId, chunk)
      })
      return json({ ...outcome, cwd: relative(root, absolute) || '.' })
    },
    render: (value) => {
      const record = value as CommandOutcome | undefined
      if (record === undefined) return [{ type: 'text', text: '(no output)' }]
      const status = record.exitCode === 0 ? 'exit 0' : `exit ${String(record.exitCode)}`
      return [{ type: 'text', text: `$ ${record.command}\n${record.output}\n[${status}]` }]
    },
    meta: (value) => {
      const record = value as CommandOutcome | undefined
      return record === undefined
        ? undefined
        : card({
          kind: 'terminal',
          command: record.command,
          output: record.output,
          exitCode: record.exitCode,
        })
    },
  })
}
