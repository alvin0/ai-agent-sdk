/** Minimal async queue connecting readline events to the idle REPL loop. */

export class TerminalLineQueue {
  private readonly lines: string[] = []
  private readonly waiters: Array<(line: string | undefined) => void> = []
  private closed = false

  push(line: string): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.lines.push(line)
    else waiter(line)
  }

  take(): Promise<string | undefined> {
    const line = this.lines.shift()
    if (line !== undefined) return Promise.resolve(line)
    if (this.closed) return Promise.resolve(undefined)
    return new Promise(resolve => this.waiters.push(resolve))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
}
