/** Receives output from a command while it is still running. */
export type CommandOutputListener = (callId: string, chunk: string) => void

/**
 * Subscribers to live command output.
 *
 * A module-level bus rather than a constructor argument, because tool
 * registries are cached per workspace root and shared by every conversation
 * using that folder, so a per-run callback cannot be baked into one. Output is
 * tagged with the call id instead, and a run picks out the calls it owns.
 *
 * `ToolRunContext` offers no channel for this: a tool result is delivered once,
 * when the tool returns. Everything a long command prints before that would
 * otherwise be invisible until it exits.
 */
export const outputListeners = new Set<CommandOutputListener>()

/**
 * Watch output from commands as they run.
 * @param listener - Called with each flushed chunk and the call that produced it.
 * @returns A disposer.
 */
export function onCommandOutput(listener: CommandOutputListener): () => void {
  outputListeners.add(listener)
  return () => void outputListeners.delete(listener)
}

export function publishOutput(callId: string, chunk: string): void {
  for (const listener of [...outputListeners]) {
    try {
      listener(callId, chunk)
    } catch {
      // A broken observer must not fail the command it is watching.
    }
  }
}
