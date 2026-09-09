/**
 * Rendering and byte accounting for the instruction section.
 *
 * @module @ai-agent-sdk/instructions-node/render
 */

import { createHash } from 'node:crypto'
import type { ResolvedInstructionsConfig } from './config.ts'
import type { LoadedInstructionFile } from './discovery.ts'

export interface RenderedInstructions {
  readonly text: string
  readonly revision: string
  /** Files that made it into the rendered text, in surface order. */
  readonly included: readonly LoadedInstructionFile[]
  /** Files dropped because the section ran out of budget. */
  readonly omitted: readonly LoadedInstructionFile[]
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Whitespace-insensitive identity, so a symlinked or copied twin collapses. */
function trimmedDigest(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex')
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content.trim()}`
}

/**
 * Drop files whose trimmed content already appeared earlier.
 * @param files - discovered files in precedence order.
 * @returns the first occurrence of each distinct content.
 */
export function dedupeByContent(files: readonly LoadedInstructionFile[]): LoadedInstructionFile[] {
  const seenPaths = new Set<string>()
  const seenContent = new Set<string>()
  const kept: LoadedInstructionFile[] = []
  for (const file of files) {
    if (seenPaths.has(file.absolutePath)) continue
    seenPaths.add(file.absolutePath)
    const digest = trimmedDigest(file.content)
    if (seenContent.has(digest)) continue
    seenContent.add(digest)
    kept.push(file)
  }
  return kept
}

/**
 * Compose the model-facing text under the total byte ceiling.
 *
 * Files are admitted whole, nearest-first is *not* used: precedence order is
 * broad-to-specific, and a specific file dropped for budget is reported rather
 * than silently cut in half.
 * @param files - deduplicated files in precedence order.
 * @param config - normalized configuration.
 * @returns the rendered section, or undefined when nothing is in scope.
 */
export function renderInstructions(
  files: readonly LoadedInstructionFile[],
  config: ResolvedInstructionsConfig,
): RenderedInstructions | undefined {
  if (files.length === 0) return undefined
  const included: LoadedInstructionFile[] = []
  const omitted: LoadedInstructionFile[] = []
  let used = utf8Bytes(config.intro)
  for (const file of files) {
    const block = sectionText(file)
    const cost = utf8Bytes(block) + 2
    if (used + cost > config.maxBytes) {
      omitted.push(file)
      continue
    }
    used += cost
    included.push(file)
  }
  if (included.length === 0) return undefined
  const notice = omitted.length === 0
    ? ''
    : `\n\nOmitted for the ${config.maxBytes}-byte instruction budget: `
      + `${omitted.map(file => file.displayPath).join(', ')}.`
  const text = `${config.intro}\n\n${included.map(sectionText).join('\n\n')}${notice}`
  // The digest covers exactly what the model reads, so any change to content,
  // ordering, or the omission notice produces a new revision and one rewrite.
  return {
    text,
    revision: createHash('sha256').update(text).digest('hex'),
    included: Object.freeze(included),
    omitted: Object.freeze(omitted),
  }
}
