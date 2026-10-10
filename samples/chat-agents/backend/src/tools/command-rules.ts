import type { RuleChoice } from './types'

/**
 * Longest prefix a command grant may name.
 *
 * Past this a "family" is really one command line with its arguments, which
 * would be remembered forever and match nothing again.
 */
export const MAX_PREFIX_TOKENS = 8

/**
 * Shell syntax that makes a command line more than a plain argument list.
 *
 * A prefix grant is only sound when the prefix decides what runs. `git diff`
 * does; `git diff && rm -rf .` and `git $CMD` do not — the chip would read
 * "every `git diff …` command" while the line runs something else. Rather than
 * parse a shell, anything that can redirect, chain, expand, or substitute makes
 * the line opaque: permitted once, never remembered.
 *
 * Quotes are deliberately NOT here. They only group words, and grouping cannot
 * change which program runs once everything above is excluded — so
 * `git commit -m "two words"` still scopes to `git commit`, which is the
 * commonest command in the sample there is. A quote in the program word itself
 * is still refused, below: `"git"` and `git` must not share a key.
 */
export const SHELL_METACHARACTERS = /[$`(){}<>&|;*?~!#\n\r\\]/

/**
 * Executables never offered as a grant.
 *
 * Not a security boundary — the workspace root and the sandbox are that. It
 * keeps the prompt from offering one chip that signs away deletion, privilege
 * escalation, or "run this arbitrary text" for a whole project. An explicit
 * grant added through the permissions API is still honoured.
 */
export const UNGRANTABLE_EXECUTABLES: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'mv', 'dd', 'mkfs', 'chmod', 'chown', 'sudo', 'doas', 'su',
  'shutdown', 'reboot', 'kill', 'killall', 'eval', 'exec', 'source',
  'sh', 'bash', 'zsh', 'fish', 'env', 'xargs',
  'node', 'python', 'python3', 'ruby', 'perl', 'osascript',
  'curl', 'wget', 'ssh', 'scp', 'nc',
])

/**
 * The words of a command line, when it is a plain argument list.
 * @param command - The command line as the model wrote it.
 * @returns Its words, or an empty array when nothing about it can be trusted
 *   to a prefix rule.
 */
export function plainTokens(command: string): readonly string[] {
  const trimmed = command.trim()
  if (trimmed === '' || SHELL_METACHARACTERS.test(trimmed)) return []
  const tokens = trimmed.split(/\s+/)
  const program = tokens[0]
  if (program === undefined) return []
  // `FOO=1 cmd` runs `cmd` with an environment the prefix does not describe,
  // and a quoted or escaped program word is a second spelling of a name that
  // already has a key.
  if (program.includes('=') || /["']/.test(program)) return []
  return tokens
}

/**
 * Whether a command word names a file rather than a program on `PATH`.
 *
 * The distinction decides what a grant may say. `git` is whatever `PATH`
 * resolves, and a rule about it is a rule about git. `./git` is a file in the
 * workspace — a file the agent can WRITE — so a grant that stripped the path
 * would let a newly created `./git` ride the user's trust in git. A path stays
 * in the key verbatim instead, where it names one file and nothing else.
 */
export function isPath(word: string): boolean {
  return word.includes('/') || word.includes('\\')
}

/** The last segment of a command word, for reading a path against the ban list. */
export function basename(word: string): string {
  return word.split(/[/\\]/).pop() ?? word
}

/**
 * Longest word a chip may name.
 *
 * A rule's label has to be readable in a row of chips at a glance. A model can
 * write a 400-character path as its first word, and a chip that wide is a
 * decision the user cannot actually read — so that width is simply not offered,
 * and the call is permitted once.
 */
export const MAX_LABEL_WORD = 48

/** Whether an executable may be offered as a grant at all. */
export function grantable(word: string): boolean {
  if (word.length > MAX_LABEL_WORD) return false
  return !UNGRANTABLE_EXECUTABLES.has(basename(word).toLowerCase())
}

/**
 * Every grant key that covers one command line.
 *
 * A stored `run_command:prefix:<words>` covers a call when its words are a
 * prefix of the call's words, so this enumerates the call's own prefixes and
 * lets the store be checked by equality. `run_command:<executable>` is listed
 * too: it is the key this sample granted before prefixes existed, and rows
 * written then still mean "every `git` command".
 * @param command - The command line about to run.
 * @returns The keys, narrowest first; empty for an opaque command line.
 */
export function commandRuleKeys(command: string): readonly string[] {
  const tokens = plainTokens(command)
  const executable = tokens[0]
  if (executable === undefined) return []
  const keys: string[] = []
  const depth = Math.min(tokens.length, MAX_PREFIX_TOKENS)
  for (let count = depth; count >= 1; count -= 1) {
    keys.push(`run_command:prefix:${tokens.slice(0, count).join(' ')}`)
  }
  // The key this sample wrote before prefixes existed, and only for a program
  // on `PATH`: a bare-name grant must never be what permits `./git`.
  if (!isPath(executable)) keys.push(`run_command:${executable}`)
  return keys
}

/**
 * The breadths a command prompt offers: the subcommand, then the executable.
 *
 * `git diff --stat` offers `git diff *` and `git *` — the first because
 * approving one diff should not have to approve `git push`, the second because
 * a user who trusts a tool should be able to say so once.
 * @param command - The command line about to run.
 * @returns The choices, narrowest first; empty when none may be offered.
 */
export function commandRules(command: string): readonly RuleChoice[] {
  const tokens = plainTokens(command)
  const executable = tokens[0]
  if (executable === undefined) return []
  if (!grantable(executable)) return []
  const rules: RuleChoice[] = []
  const sub = tokens[1]
  // A flag is not a subcommand: `ls -la` would offer "every `ls -la …`", which
  // is one command line wearing a family's clothes.
  if (sub !== undefined && !sub.startsWith('-') && sub.length <= MAX_LABEL_WORD) {
    rules.push({
      key: `run_command:prefix:${executable} ${sub}`,
      label: `every \`${executable} ${sub} …\` command`,
    })
  }
  rules.push({ key: `run_command:prefix:${executable}`, label: `every \`${executable}\` command` })
  return rules
}
