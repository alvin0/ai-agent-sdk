function browserCommand(url: string) {
  if (process.platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '', url] }
  if (process.platform === 'darwin') return { file: 'open', args: [url] }
  return { file: 'xdg-open', args: [url] }
}

/** Best-effort browser launch; the printed URL remains available on failure. */
export async function openBrowser(url: string): Promise<void> {
  try {
    const { spawn } = await import('node:child_process')
    const command = browserCommand(url)
    spawn(command.file, command.args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Auto-open is only a convenience.
  }
}
