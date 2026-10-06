import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** Run fixture tooling without sending paths through Windows shell shims. */
export function runPackedCommand(command: string, args: readonly string[], cwd: string): string {
  let executable = command
  let parameters = args
  if (command === 'npm' && process.platform === 'win32') {
    const cli = [dirname(process.execPath), ...(process.env.PATH?.split(delimiter) ?? [])]
      .map(directory => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
      .find(candidate => existsSync(candidate))
    if (cli === undefined) throw new Error('Cannot locate npm-cli.js beside Node or in PATH')
    executable = process.execPath
    parameters = [cli, ...args]
  }
  const result = spawnSync(executable, parameters, { cwd, encoding: 'utf8', env: process.env, windowsHide: true })
  if (result.error !== undefined) throw new Error(`${command} could not start: ${result.error.message}`, { cause: result.error })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${String(result.status)})\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
