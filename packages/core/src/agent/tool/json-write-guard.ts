import { TOOL_ERROR_CODES, ToolError } from './errors.ts'
import { jsonErrorOffset } from './json-error-offset.ts'

/** Host policy for tools that write complete workspace file contents. */
export interface JsonWriteGuardOptions {
  /** Validate .json writes with JSON.parse before writing. Defaults to true. */
  readonly validateJsonWrites?: boolean
}

/**
 * Validate the complete post-write/edit text before any filesystem mutation.
 * One leading BOM is tolerated; accepted text is never modified or reserialized.
 * Hosts retain ownership of paths, authorization, size limits and the actual write.
 * @param path - Host-resolved target file path (including symlink resolution when
 * supported), used for suffix matching and diagnostics. Terminal POSIX `/` and
 * `/.` segments are also stripped defensively; authorization remains host-owned.
 * @param content - Complete proposed file content, including all edits.
 * @param options - Host opt-out for intentionally incomplete JSON files.
 */
export function validateJsonFileContent(
  path: string, content: string, options: JsonWriteGuardOptions = {},
): void {
  const target = trimTerminalSegments(path)
  if (options.validateJsonWrites === false || !/\.json$/iu.test(target)) return
  const bom = content.startsWith('\uFEFF') ? 1 : 0
  const text = content.slice(bom)
  try { JSON.parse(text) }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const position = /\bat position (\d+)(?: \(line \d+ column \d+\))?$/u.exec(message)
    const offset = (position === null ? jsonErrorOffset(text) : Number(position[1])) + bom
    const prefix = content.slice(0, offset)
    const line = prefix.split('\n').length
    const column = offset - prefix.lastIndexOf('\n')
    const start = Math.max(0, Math.min(offset - 40, content.length - 80))
    const excerpt = JSON.stringify(content.slice(start, start + 80))
    // Native messages can embed source snippets. Keep those bounded too.
    const reason = message.slice(0, 160)
    throw ToolError.respondToModel(
      `Invalid JSON in ${JSON.stringify(target.slice(0, 200))}: ${reason}; line ${line}, column ${column}. `
      + `Near: ${excerpt}. Fix the JSON and retry; no file was written.`,
      TOOL_ERROR_CODES.INVALID_ARGUMENTS,
    )
  }
}

function trimTerminalSegments(path: string): string {
  let end = path.length
  while (end > 0) {
    if (path[end - 1] === '/') end--
    else if (path[end - 1] === '.' && path[end - 2] === '/') end -= 2
    else break
  }
  return path.slice(0, end)
}
