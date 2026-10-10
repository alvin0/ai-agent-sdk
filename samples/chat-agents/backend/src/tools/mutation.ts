import { resolve } from 'node:path'
import { commandHazards } from '../hazards'
import { argString } from './values'
import { inRoot } from './paths'
import { currentText, replaceOnce, diffLines } from './text'
import { commandRuleKeys, commandRules } from './command-rules'
import { workspacePath, pathRuleKeys, pathRules, pathHazards } from './path-rules'
import type { MutationDescription } from './types'

/**
 * The tools that change the machine, and therefore need the user's permission.
 *
 * `propose_edit` is deliberately absent: it only computes a diff.
 */
export const MUTATING_TOOLS: readonly string[] = [
  'write_file', 'edit_file', 'delete_path', 'create_directory', 'move_path', 'run_command',
]

/**
 * Describe what a mutating call is about to do.
 *
 * Called before the tool runs, so the preview is computed by reading — never by
 * writing. A file that cannot be read yields a description without a card
 * rather than failing the call: the user is still asked, just with less detail.
 * @param root - Workspace root.
 * @param toolName - The tool about to run.
 * @param args - Its parsed arguments.
 * @returns The description, or undefined when the tool changes nothing.
 */
export async function describeMutation(
  root: string, toolName: string, args: unknown,
): Promise<MutationDescription | undefined> {
  if (!MUTATING_TOOLS.includes(toolName)) return undefined
  if (toolName === 'run_command') return describeCommand(root, args)
  if (toolName === 'write_file' || toolName === 'edit_file') return describeFileMutation(root, toolName, args)
  if (toolName === 'move_path') return describeMove(root, args)
  if (toolName === 'create_directory') return describeDirectory(root, args)
  return describeDelete(root, args)
}

function describeCommand(root: string, args: unknown): MutationDescription {
  const command = argString(args, 'command')
  // Where it runs is part of what it does: `git clean -fd` reads very
  // differently in the root and in a scratch directory, and a rule is about
  // the command line alone, so the working directory has to be on the card.
  const requested = argString(args, 'cwd') || '.'
  const cwd = workspacePath(root, requested)
  const where = cwd === undefined || cwd === '.' ? '' : ` (in ${cwd}/)`
  // Hazards are read against the directory the shell will actually get. A
  // `cwd` that escapes the root makes the tool throw, but the reading has to
  // happen against SOME directory, and the root is the honest guess.
  const hazards = commandHazards(command, {
    root,
    cwd: cwd === undefined ? root : resolve(root, cwd),
  })
  // No card: a terminal block for a command that has not run yet shows an
  // empty output pane and a settled status dot, which reads as "already
  // done". The summary carries the command line, which is the whole story.
  return {
    title: 'Run command',
    summary: `${command}${where}`,
    // A line worth warning about is a line worth asking about every time:
    // remembering it would turn one deliberate answer into a standing one.
    rules: hazards.length === 0 ? commandRules(command) : [],
    matchKeys: commandRuleKeys(command),
    hazards,
  }
}

async function describeFileMutation(root: string, toolName: string, args: unknown): Promise<MutationDescription> {
  const path = argString(args, 'path')
  const editing = toolName === 'edit_file'
  const toolLabel = editing ? 'editing files in place' : 'writing whole files'
  const base: MutationDescription = {
    title: editing ? 'Edit file' : 'Write file',
    summary: path,
    rules: pathRules(root, toolName, toolLabel, [path]),
    matchKeys: [...pathRuleKeys(root, toolName, [path]), toolName],
    hazards: pathHazards(root, toolName, [path]),
  }
  let after: string
  try {
    const absolute = inRoot(root, path)
    const before = await currentText(absolute)
    after = editing
      ? replaceOnce(before, argString(args, 'oldText'), argString(args, 'newText'), args !== null
          && typeof args === 'object' && (args as { replaceAll?: unknown }).replaceAll === true).content
      : argString(args, 'content')
    return { ...base, card: { kind: 'diff', path, lines: diffLines(before, after) } }
  } catch {
    // A missing file, an ambiguous `oldText`, or a path outside the root: the
    // call will fail on its own terms. Ask without a preview.
    return base
  }
}

function describeMove(root: string, args: unknown): MutationDescription {
  const from = argString(args, 'from')
  const to = argString(args, 'to')
  return {
    title: 'Move',
    summary: `${from} → ${to}`,
    rules: pathRules(root, 'move_path', 'moving and renaming files', [from, to]),
    matchKeys: [...pathRuleKeys(root, 'move_path', [from, to]), 'move_path'],
    hazards: pathHazards(root, 'move_path', [from, to]),
  }
}

function describeDirectory(root: string, args: unknown): MutationDescription {
  const target = argString(args, 'path')
  return {
    title: 'Create directory',
    summary: target,
    // The chain drops the last segment, which for a directory is the one
    // being created — so the scope is the parent it lands in.
    rules: pathRules(root, 'create_directory', 'creating directories', [target]),
    matchKeys: [...pathRuleKeys(root, 'create_directory', [target]), 'create_directory'],
    hazards: pathHazards(root, 'create_directory', [target]),
  }
}

function describeDelete(root: string, args: unknown): MutationDescription {

  const path = argString(args, 'path')
  const recursive = args !== null && typeof args === 'object'
    && (args as { recursive?: unknown }).recursive === true
  return {
    title: 'Delete',
    summary: recursive ? `${path} (recursive, including everything inside)` : path,
    rules: pathRules(root, 'delete_path', 'deleting files and directories', [path]),
    matchKeys: [...pathRuleKeys(root, 'delete_path', [path]), 'delete_path'],
    hazards: pathHazards(root, 'delete_path', [path], recursive),
  }

}
