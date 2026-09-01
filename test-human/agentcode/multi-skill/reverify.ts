#!/usr/bin/env node
/** Re-run host-owned Signal Desk gates without contacting a model provider. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  formatSignalDeskVerificationSummary,
  verifySignalDeskWorkspace,
} from './verify.ts'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULT_WORKSPACE = join(
  PROJECT_ROOT,
  'test-human',
  'workspaces',
  'agentcode-multiskill',
)

export interface ReverifySignalDeskOptions {
  readonly workspace: string
  readonly reportPath: string
}

export function parseReverifySignalDeskArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ReverifySignalDeskOptions {
  let workspace = DEFAULT_WORKSPACE
  let reportPath = join(
    PROJECT_ROOT,
    'test-human',
    'results',
    'agentcode-multiskill',
    'reverification.json',
  )
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    const equals = token.indexOf('=')
    const key = equals > 0 ? token.slice(0, equals) : token
    if (key !== '--workspace' && key !== '--report') {
      throw new Error(`unknown option: ${key}`)
    }
    const value = equals > 0 ? token.slice(equals + 1) : argv[++index]
    if (value === undefined || value.length === 0 || (equals < 0 && value.startsWith('--'))) {
      throw new Error(`${key} requires a value`)
    }
    if (key === '--workspace') workspace = resolve(cwd, value)
    else reportPath = resolve(cwd, value)
  }
  return Object.freeze({ workspace: resolve(workspace), reportPath: resolve(reportPath) })
}

export async function reverifySignalDesk(options: ReverifySignalDeskOptions): Promise<boolean> {
  const report = await verifySignalDeskWorkspace({
    workspace: options.workspace,
    onCommandStart: request => console.log(`[reverify/command] npm ${request.args.join(' ')}`),
    onCommandEnd: result => console.log(
      `[reverify/result] ${result.name} exit=${result.exitCode ?? 'spawn-error'}`,
    ),
  })
  await mkdir(dirname(options.reportPath), { recursive: true })
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(formatSignalDeskVerificationSummary(report))
  console.log(`[reverify/report] ${options.reportPath}`)
  return report.passed
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url
}

if (isMainModule()) {
  try {
    const passed = await reverifySignalDesk(parseReverifySignalDeskArgs(process.argv.slice(2)))
    if (!passed) process.exitCode = 1
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
