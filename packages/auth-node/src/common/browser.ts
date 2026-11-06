function browserCommand(url: string) {
  // Not `cmd /c start`: cmd would split an OAuth URL at its `&` separators.
  if (process.platform === 'win32') return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (process.platform === 'darwin') return { file: 'open', args: [url] }
  return { file: 'xdg-open', args: [url] }
}

/** Best-effort browser launch; the printed URL remains available on failure. */
export async function openBrowser(url: string): Promise<void> {
  try {
    const { spawn } = await import('node:child_process')
    const command = browserCommand(url)
    const child = spawn(command.file, command.args, { stdio: 'ignore', detached: true })
    // A missing opener (e.g. no xdg-open on a headless box) fails asynchronously; it must not end the login.
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Auto-open is only a convenience.
  }
}
