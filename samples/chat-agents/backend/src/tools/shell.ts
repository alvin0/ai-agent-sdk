import { spawn } from 'node:child_process'

/** Cap on captured command output, so one chatty build cannot flood the UI. */
export const MAX_COMMAND_OUTPUT = 20_000

export interface CommandOutcome {
  readonly command: string
  readonly cwd: string
  readonly output: string
  readonly exitCode: number
  readonly timedOut: boolean
}

/**
 * Run one shell command inside the workspace.
 *
 * stdout and stderr are interleaved into a single stream, because that is what
 * the terminal card shows and what the model needs to read a failure.
 * @param command - The command line, run through the platform shell.
 * @param cwd - Absolute working directory, already confined to the root.
 * @param timeoutMs - Kill the process after this long.
 * @param report - Receives output as it arrives, coalesced; omitted stays silent.
 * @returns The captured output and exit status; a non-zero exit is data, not an error.
 */
export async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  report?: (chunk: string) => void,
): Promise<CommandOutcome> {
  return await new Promise<CommandOutcome>((settle, fail) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let output = ''
    let outputCut = false
    let timedOut = false
    // Coalesced on a short timer: a build prints in bursts of many tiny writes,
    // and one wire event each would spend more on framing than on output.
    let unsent = ''
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      flushTimer = undefined
      if (unsent === '') return
      const chunk = unsent
      unsent = ''
      report?.(chunk)
    }
    const collect = (chunk: Buffer | string): void => {
      if (output.length >= MAX_COMMAND_OUTPUT) { outputCut = true; return }
      const text = String(chunk)
      if (output.length + text.length > MAX_COMMAND_OUTPUT) outputCut = true
      let kept = text.slice(0, MAX_COMMAND_OUTPUT - output.length)
      if (outputCut && /[\uD800-\uDBFF]/.test(kept.at(-1) ?? '')) kept = kept.slice(0, -1)
      output += kept
      if (report === undefined) return
      unsent += kept
      flushTimer ??= setTimeout(flush, 200)
    }
    // Decode each pipe separately so a UTF-8 character split across chunks
    // survives, including when stdout and stderr chunks interleave.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Whatever the last burst printed still belongs on screen, and the timer
      // that would have sent it is now moot.
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flush()
      // Say so when the capture was cut: a model counting lines in a cut
      // output otherwise reports the partial count as the answer.
      const cut = truncationNotice(outputCut)
      settle({
        command,
        cwd,
        output: timedOut ? `${output}${cut}\n[timed out after ${String(timeoutMs)}ms]` : `${output}${cut}`,
        // A killed process reports a null code; surface it as a failure.
        exitCode: code ?? 1,
        timedOut,
      })
    })
  })
}

function truncationNotice(outputCut: boolean): string {
  return outputCut
    ? `\n[output truncated at ${String(MAX_COMMAND_OUTPUT)} characters; `
      + 'narrow the command (grep, head, wc) to see the rest]'
    : ''
}
