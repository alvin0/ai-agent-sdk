import { readFile } from 'node:fs/promises'
import type { DiffLine } from '../wire'

/** Read a file, treating "missing" as empty so a create and an edit diff alike. */
export async function currentText(absolute: string): Promise<string> {
  try {
    return await readFile(absolute, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Apply one exact-string replacement.
 * @param text - Current file content.
 * @param oldText - The literal to replace.
 * @param newText - Its replacement.
 * @param replaceAll - Replace every occurrence instead of insisting on one.
 * @returns The new content and how many occurrences changed.
 * @throws When the literal is absent, or ambiguous without `replaceAll`.
 */
export function replaceOnce(
  text: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): { content: string; count: number } {
  const occurrences = text.split(oldText).length - 1
  if (occurrences === 0) throw new Error('"oldText" does not appear in the file')
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `"oldText" appears ${String(occurrences)} times; include more surrounding lines or set replaceAll`,
    )
  }
  return {
    content: replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText),
    count: replaceAll ? occurrences : 1,
  }
}

/** Minimal line diff (longest-common-subsequence) used by `propose_edit`. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  const lcs = longestCommonSubsequence(a, b)
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'ctx', text: a[i] as string })
      i += 1
      j += 1
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      lines.push({ kind: 'del', text: a[i] as string })
      i += 1
    } else {
      lines.push({ kind: 'add', text: b[j] as string })
      j += 1
    }
  }
  for (; i < a.length; i += 1) lines.push({ kind: 'del', text: a[i] as string })
  for (; j < b.length; j += 1) lines.push({ kind: 'add', text: b[j] as string })
  return lines
}

function longestCommonSubsequence(a: readonly string[], b: readonly string[]): (i: number, j: number) => number {
  // table[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  const lcs = (i: number, j: number): number => table[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? lcs(i + 1, j + 1) + 1
        : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }
  return lcs
}
