/**
 * Display copy for the copied primitives. The primitives are deliberately
 * locale-free: every string arrives from the render site, which in this sample
 * is this single English dictionary.
 */

import type {
  DiffBlockLabels, MarkdownLabels, ReadBlockLabels, SearchBlockLabels,
  TerminalBlockLabels, WebBlockLabels,
} from './primitives'

const copy = { copy: 'Copy', copied: 'Copied' }

const fold = {
  collapseAria: 'Collapse',
  expandAria: (hidden: number) => `Expand ${hidden} more lines`,
  collapse: 'Show less',
  expand: (hidden: number) => `Show ${hidden} more lines`,
}

export const markdownLabels: MarkdownLabels = {
  code: { copyLabel: copy.copy, copiedLabel: copy.copied },
  footnotes: 'Footnotes',
}

export const terminalLabels: TerminalBlockLabels = {
  ...copy,
  ...fold,
  exitCode: (code: number) => `exit ${code}`,
  signal: (name: string) => `signal ${name}`,
  running: 'Running',
  failed: 'Failed',
  done: 'Done',
  noOutput: 'No output',
}

export const readLabels: ReadBlockLabels = {
  ...copy,
  ...fold,
  window: (shown: number, total: number) => `Showing ${shown} of ${total} lines`,
}

export const diffLabels: DiffBlockLabels = {
  ...copy,
  ...fold,
  files: (count: number) => (count === 1 ? '1 file' : `${count} files`),
}

export const searchLabels: SearchBlockLabels = {
  ...copy,
  ...fold,
  pathsSummary: (shown: number, total: number, truncated: boolean) =>
    truncated ? `Showing ${shown} of ${total} paths` : `${total} paths`,
  matchesSummary: (shown: number, total: number, files: number, truncated: boolean) =>
    truncated
      ? `Showing ${shown} of ${total} matches in ${files} files`
      : `${total} matches in ${files} files`,
  noResults: 'No results',
}

export const webLabels: WebBlockLabels = {
  noResults: 'No results',
  sourcesTruncated: 'Some sources were dropped',
  http: 'HTTP',
  contentTruncated: 'Content truncated',
  markdown: markdownLabels,
}
