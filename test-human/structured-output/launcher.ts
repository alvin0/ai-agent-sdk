#!/usr/bin/env node
import { spawn } from 'node:child_process'

// Repository convenience only. Provider packages remain environment-agnostic
// and always receive credentials through injection.
try { process.loadEnvFile('.env') }
catch (error: unknown) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
}

process.stdout.write('Preparing current workspace packages...')
const build = await runBuild()
if (build.code !== 0) {
  process.stdout.write(' failed\n')
  process.stderr.write(`${build.output}\n`)
  process.exitCode = build.code ?? 1
} else {
  process.stdout.write(' ready\n')
  await import('./cli.ts')
}

async function runBuild(): Promise<{ readonly code: number | null; readonly output: string }> {
  const executable = process.env.npm_execpath
  const command = executable === undefined ? 'pnpm' : process.execPath
  const args = executable === undefined ? ['build', '--silent'] : [executable, 'build', '--silent']
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks: Buffer[] = []
  let bytes = 0
  const capture = (chunk: Buffer): void => {
    chunks.push(chunk)
    bytes += chunk.byteLength
    while (bytes > 256 * 1024 && chunks.length > 1) bytes -= chunks.shift()?.byteLength ?? 0
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return Object.freeze({ code, output: Buffer.concat(chunks).toString('utf8').trim() })
}
