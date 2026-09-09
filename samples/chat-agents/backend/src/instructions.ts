/**
 * Which `AGENTS.md` files a project's agents are reading.
 *
 * The section that puts them in the prompt lives in the SDK
 * (`@ai-agent-sdk/instructions-node`) and is deliberately silent: it owns one
 * node on the model surface and rewrites it when the files change. Silent is
 * right for the model and wrong for the user — a convention file that is being
 * read invisibly is indistinguishable from one that is being ignored, which is
 * how "why does it keep using tabs" becomes an afternoon.
 *
 * So this module answers the same question the section answers, for the UI: it
 * reuses the SDK's own root-finding and directory walk rather than reimplement
 * the precedence, and reports the files that exist right now.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  DEFAULT_FILE_NAMES, ancestorChain, findProjectRoot,
} from '@ai-agent-sdk/instructions-node'

/** One instruction file the agents in a project will read. */
export interface ProjectInstructionFile {
  /** Path relative to the project root, with `/` separators. */
  readonly path: string
  /** Absolute path, for a user who wants to open it. */
  readonly absolutePath: string
  /** Size in bytes, so an oversized file is visible before it is truncated. */
  readonly bytes: number
  /** First non-empty line, as a hint at what the file says. */
  readonly firstLine: string
  /** True for the user's own global file rather than one in the project. */
  readonly global?: true
}

/** What the UI needs to explain the project's instruction files. */
export interface ProjectInstructions {
  /** The directory the walk started from — the group's workspace. */
  readonly workspaceRoot: string
  /** The root the walk settled on; the same as the workspace unless walking up. */
  readonly projectRoot: string
  /** The candidate names, in precedence order, so the UI can say what to create. */
  readonly fileNames: readonly string[]
  /** The files that exist, broad-to-specific — the order the model sees them. */
  readonly files: readonly ProjectInstructionFile[]
}

/** The first line with anything on it, trimmed and shortened for a list row. */
function summarize(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * Read one candidate, or report nothing when it is absent.
 * @param root - Project root, for the relative path shown in the UI.
 * @param absolutePath - The candidate file.
 * @param isGlobal - Whether this is the user's own global file.
 * @returns The file, or undefined when it does not exist or cannot be read.
 */
async function describeFile(
  root: string,
  absolutePath: string,
  isGlobal = false,
): Promise<ProjectInstructionFile | undefined> {
  try {
    const stats = await stat(absolutePath)
    if (!stats.isFile()) return undefined
    const text = await readFile(absolutePath, 'utf8')
    const rest = relative(root, absolutePath)
    return {
      path: isGlobal || rest === '' || rest.startsWith('..')
        ? absolutePath
        : rest.split(sep).join('/'),
      absolutePath,
      bytes: stats.size,
      firstLine: summarize(text),
      ...isGlobal ? { global: true as const } : {},
    }
  } catch {
    // Absent, unreadable, or a dangling symlink: the section will skip it too,
    // so the honest answer is that this file is not in play.
    return undefined
  }
}

/**
 * The instruction files in play for one workspace.
 *
 * Mirrors the section's discovery: the global file first, then the project root
 * down to the workspace directory, taking the first present candidate in each
 * directory. It does NOT include the subtrees the section picks up mid-run when
 * a tool reaches into them — those depend on what the agent has read so far,
 * and a settings pane that changed while a run progressed would be noise.
 * @param workspaceRoot - The group's workspace directory.
 * @param options - `globalFile` and `walkUp`, matching the runtime's own.
 * @returns What the UI needs to render, files in the order the model sees them.
 */
export async function listProjectInstructions(
  workspaceRoot: string,
  options: { readonly globalFile?: string; readonly walkUp?: boolean } = {},
): Promise<ProjectInstructions> {
  const markers = options.walkUp === true ? ['.git'] : []
  const projectRoot = await findProjectRoot(workspaceRoot, markers)
  const files: ProjectInstructionFile[] = []

  if (options.globalFile !== undefined && options.globalFile !== '') {
    const global = await describeFile(projectRoot, options.globalFile, true)
    if (global !== undefined) files.push(global)
  }

  for (const directory of ancestorChain(projectRoot, workspaceRoot)) {
    for (const name of DEFAULT_FILE_NAMES) {
      const found = await describeFile(projectRoot, join(directory, name))
      if (found === undefined) continue
      files.push(found)
      // `perDirectory: 'first'` — the override wins and the plain file is not
      // also read, which is the runtime's default and has to be the UI's too.
      break
    }
  }

  return { workspaceRoot, projectRoot, fileNames: DEFAULT_FILE_NAMES, files }
}
