import { relative, sep } from 'node:path'
import type { Hazard } from '../hazards'
import { inRoot } from './paths'
import type { RuleChoice } from './types'

/** Longest directory a chip may name, for the same reason. */
export const MAX_LABEL_DIRECTORY = 80

/**
 * One tool argument as a canonical workspace-relative path.
 *
 * The same resolution the tools themselves use, so a rule is derived from the
 * path that will actually be written — not from the string the model typed.
 * `a/../b.txt` is `b.txt`, `./src/x` is `src/x`, and a file whose NAME
 * contains a separator character for another platform stays one name rather
 * than turning into a directory a grant could be widened through.
 * @param root - Workspace root.
 * @param path - The path argument, as the tool received it.
 * @returns The relative path with `/` separators, or undefined when it names
 *   nothing inside the workspace.
 */
export function workspacePath(root: string, path: string): string | undefined {
  if (path === '') return undefined
  try {
    const rest = relative(root, inRoot(root, path))
    return rest === '' ? '.' : rest.split(sep).join('/')
  } catch {
    // Escapes the root. The call will fail on its own terms; until it does,
    // the prompt must not imply a directory scope it cannot enforce.
    return undefined
  }
}

/**
 * The directories a path sits under, nearest first.
 *
 * `.` is the workspace root and closes the chain, so a root-level file yields
 * exactly one directory.
 * @param root - Workspace root.
 * @param path - The path argument, as the tool received it.
 * @returns The chain, or undefined when the path is not inside the workspace
 *   and so cannot be scoped.
 */
export function directoryChain(root: string, path: string): readonly string[] | undefined {
  const normal = workspacePath(root, path)
  if (normal === undefined) return undefined
  const parts = normal.split('/').filter(part => part !== '' && part !== '.')
  parts.pop()
  const chain: string[] = []
  let prefix = ''
  for (const part of parts) {
    prefix = prefix === '' ? part : `${prefix}/${part}`
    chain.push(prefix)
  }
  // Built root-outwards; the prompt wants the nearest directory first, and the
  // workspace root last, where it means "anywhere in the project".
  chain.reverse()
  chain.push('.')
  return chain
}

/**
 * Directory keys covering every path one call touches.
 *
 * A move touches two paths, and a grant must cover both or it does not cover
 * the call, so the chains are intersected rather than concatenated.
 * @param toolName - The tool the key belongs to.
 * @param paths - The workspace-relative paths the call writes.
 * @returns The keys, narrowest first; empty when any path cannot be scoped.
 */
export function pathRuleKeys(
  root: string,
  toolName: string,
  paths: readonly string[],
): readonly string[] {
  const chains = paths.map(path => directoryChain(root, path))
  if (chains.length === 0 || chains.some(chain => chain === undefined)) return []
  const [first, ...rest] = chains as readonly (readonly string[])[]
  const shared = (first ?? []).filter(dir => rest.every(chain => chain.includes(dir)))
  return shared.map(dir => `${toolName}:dir:${dir}`)
}

/**
 * The breadths a filesystem prompt offers: this directory, then the tool.
 * @param toolName - The tool about to run.
 * @param toolLabel - What a tool-wide grant covers, in words.
 * @param paths - The workspace-relative paths the call writes.
 * @returns The choices, narrowest first.
 */
export function pathRules(
  root: string,
  toolName: string,
  toolLabel: string,
  paths: readonly string[],
): readonly RuleChoice[] {
  const keys = pathRuleKeys(root, toolName, paths)
  const nearest = keys[0]
  const directory = nearest?.slice(`${toolName}:dir:`.length)
  // A directory too long to read is a chip the user cannot weigh; the
  // tool-wide width still stands, and so does answering once.
  const scoped: readonly RuleChoice[] = nearest === undefined || directory === undefined
    || directory === '.' || directory.length > MAX_LABEL_DIRECTORY
    ? []
    : [{ key: nearest, label: `${toolLabel} under \`${directory}/\`` }]
  return [...scoped, { key: toolName, label: toolLabel }]
}

/**
 * What a filesystem call would reach that the user has to be told about.
 *
 * These tools resolve every path through the workspace root and refuse to
 * leave, so an outside path is a call that will FAIL rather than one that will
 * do damage. It is still worth saying: the model asked to touch something
 * outside the project, and the user is the one who should know that.
 * @param root - Workspace root.
 * @param toolName - The tool about to run.
 * @param paths - The path arguments, as the tool received them.
 * @param recursive - Whether a delete takes everything underneath.
 * @returns The hazards, empty when there is nothing to say.
 */
export function pathHazards(
  root: string,
  toolName: string,
  paths: readonly string[],
  recursive = false,
): readonly Hazard[] {
  const hazards: Hazard[] = []
  for (const path of paths) {
    if (path === '') continue
    if (workspacePath(root, path) !== undefined) continue
    hazards.push({
      severity: 'critical',
      title: 'Points outside the workspace',
      detail: `\`${path}\` resolves outside \`${root}\`. This tool refuses to leave the workspace, `
        + 'so the call will fail — but it asked to reach the rest of the machine, '
        + 'which is worth knowing before permitting anything else it does.',
    })
  }
  if (toolName === 'delete_path' && recursive && paths.some(path => workspacePath(root, path) === '.')) {
    hazards.push({
      severity: 'critical',
      title: 'Deletes the whole workspace',
      detail: `A recursive delete of the workspace root removes every file in \`${root}\`, `
        + 'including anything not tracked by git. It is not undoable.',
    })
  }
  return hazards
}
