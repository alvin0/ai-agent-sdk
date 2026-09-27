import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Hash the index as a stream; retained evaluation evidence can exceed execFile's buffer. */
export function stagedDiffHash(): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const child = spawn('git', ['diff', '--cached', '--binary'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let errorText = ''
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk))
    child.stderr.on('data', (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(0, 1_024) })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(new Error(`Unable to hash staged diff: ${errorText || String(code)}`))
      else resolve(hash.digest('hex'))
    })
  })
}
