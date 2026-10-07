/** Shell keywords that lead a segment without being the command. */
export const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case',
  'esac', 'in', '{', '}', '(', ')', '!', 'time', 'exec',
])

/** Shells whose `-c` argument is another command entirely. */
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell'])

/** Wrappers that run another command without changing what it does. */
export const TRANSPARENT = new Set(['env', 'nice', 'ionice', 'nohup', 'stdbuf', 'time', 'timeout', 'command'])

/** Remove wrappers, shell keywords and leading assignments without losing meaning. */
export function stripWrappers(argv: readonly string[]): readonly string[] {
  let current = [...argv]
  for (let guard = 0; guard < 8; guard++) {
    stripLeadingWords(current)
    const program = basename(current[0] ?? '')
    if (!TRANSPARENT.has(program)) break
    current = current.slice(1)
    stripWrapperFlags(current, program)
  }
  return current
}

/**
 * Every command an argv actually runs.
 *
 * A shell invocation carries its real command in a string, and that string can
 * hold several. Splitting it with a pattern cannot work: `grep -E 'a|b'` puts a
 * separator inside a quoted word, and a pattern either splits there — inventing
 * commands out of a regex — or refuses to split anywhere a quote appears. The
 * script is therefore walked one character at a time, so a separator only
 * separates when nothing is quoting it.
 */
export function splitCommands(argv: readonly string[]): readonly (readonly string[])[] {
  const stripped = stripWrappers(argv)
  const program = basename(stripped[0] ?? '')
  const flagIndex = stripped.findIndex(argument => argument === '-c' || argument === '-Command')

  let script: string | undefined
  if (SHELLS.has(program) && flagIndex >= 0) {
    script = stripped[flagIndex + 1]
  } else if (stripped.some(token => UNQUOTED_SEPARATOR.test(token))) {
    // An argv is not always one command. A model emits a whole command line,
    // and `if [ -f package.json ]; then npm test; fi` names `[` first — read as
    // one argv it looks like a test, while what it runs is the test suite.
    script = stripped.join(' ')
  }
  if (script === undefined) return [stripped]

  const commands = tokenizeScript(script)
  if (hasDynamicShellSyntax(script)) {
    return Object.freeze([...commands, Object.freeze(['(dynamic-shell-syntax)'])])
  }
  return commands.length === 0 ? [stripped] : commands
}

/** Syntax that can execute code our deliberately small tokenizer cannot see. */
export function hasDynamicShellSyntax(script: string): boolean {
  let quote: ShellQuote
  for (let index = 0; index < script.length; index++) {
    const character = script[index] ?? ''
    if (character === '\\' && quote !== "'") { index += 1; continue }
    if (character === "'" || character === '"') {
      quote = toggleQuote(quote, character)
      continue
    }
    if (quote === "'") continue
    if (character === '`') return true
    const pair = script.slice(index, index + 2)
    if (['$(', '<(', '>('].includes(pair)) return true
  }
  return quote !== undefined
}

/** A separator that is not inside quotes, used only to decide whether to walk. */
export const UNQUOTED_SEPARATOR = /^(&&|\|\||;|\|)$|[;|&]/

/**
 * Split a shell script into commands, respecting quotes and escapes.
 *
 * Deliberately not a shell parser: it does not expand, substitute, or
 * understand control flow. It answers one question — which words belong to
 * which command — and leaves the rest to the classifier, which treats anything
 * it cannot read as something to ask about.
 */
export function tokenizeScript(script: string): readonly (readonly string[])[] {
  const state: TokenState = { commands: [], command: [], word: '', quote: undefined, index: 0 }
  while (state.index < script.length) {
    const character = script[state.index] ?? ''
    if (state.quote !== undefined) advanceQuoted(state, script, character)
    else advanceUnquoted(state, script, character)
  }
  endCommand(state)
  return state.commands
}

/** The final path segment, so `/usr/bin/systemctl` decides like `systemctl`. */
export function basename(value: string): string {
  const cleaned = value.replaceAll('\\', '/')
  return cleaned.slice(cleaned.lastIndexOf('/') + 1)
}

type ShellQuote = '"' | "'" | undefined

function toggleQuote(quote: ShellQuote, character: '"' | "'"): ShellQuote {
  if (quote === undefined) return character
  return quote === character ? undefined : quote
}

function stripLeadingWords(current: string[]): void {
  // Keywords and assignments are stripped in this order on each wrapper pass.
  while (current.length > 0 && SHELL_KEYWORDS.has(current[0] ?? '')) current.shift()
  while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0] ?? '')) current.shift()
}

function stripWrapperFlags(current: string[], program: string): void {
  while (current.length > 0 && (current[0] ?? '').startsWith('-')) current.shift()
  if (program === 'timeout' && current.length > 0 && /^[0-9]/.test(current[0] ?? '')) current.shift()
}

interface TokenState {
  commands: string[][]
  command: string[]
  word: string
  quote: ShellQuote
  index: number
}

function endWord(state: TokenState): void {
  if (state.word !== '') { state.command.push(state.word); state.word = '' }
}

function endCommand(state: TokenState): void {
  endWord(state)
  if (state.command.length > 0) state.commands.push(state.command)
  state.command = []
}

function advanceQuoted(state: TokenState, script: string, character: string): void {
  if (character === '\\' && state.quote === '"' && state.index + 1 < script.length) {
    state.word += script[state.index + 1] ?? ''
    state.index += 2
    return
  }
  if (character === state.quote) state.quote = undefined
  else state.word += character
  state.index += 1
}

function advanceUnquoted(state: TokenState, script: string, character: string): void {
  if (character === '"' || character === "'") {
    state.quote = character; state.index += 1; return
  }
  if (character === '\\' && state.index + 1 < script.length) {
    state.word += script[state.index + 1] ?? ''
    state.index += 2
    return
  }
  if (character === ' ' || character === '\t') { endWord(state); state.index += 1; return }
  if (character === '\n') { endCommand(state); state.index += 1; return }
  advanceSymbol(state, script, character)
}

function advanceSymbol(state: TokenState, script: string, character: string): void {
  // Keep redirection as a word so the classifier observes the write effect.
  const pair = script.slice(state.index, state.index + 2)
  if (pair === '&&' || pair === '||') { endCommand(state); state.index += 2; return }
  if (pair === '>>') { endWord(state); state.command.push('>>'); state.index += 2; return }
  if (character === ';' || character === '|' || character === '&') {
    endCommand(state); state.index += 1; return
  }
  if (character === '>') { endWord(state); state.command.push('>'); state.index += 1; return }
  if (['(', ')', '{', '}'].includes(character)) {
    endWord(state); state.index += 1; return
  }
  state.word += character
  state.index += 1
}
