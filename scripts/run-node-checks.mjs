import { spawnSync } from 'node:child_process'

export function runNodeChecks(checks) {
  let failed = false
  for (const [name, args] of checks) {
    console.log(`Running ${name}`)
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (result.error || result.status !== 0) {
      failed = true
      console.error(`${name} failed: ${result.error?.message ?? result.signal ?? result.status}`)
    }
  }
  return failed ? 1 : 0
}
