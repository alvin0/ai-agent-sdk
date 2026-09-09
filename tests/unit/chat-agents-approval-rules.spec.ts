import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { commandRuleKeys, commandRules, describeMutation, plainTokens } =
  await import('../../samples/chat-agents/backend/src/tools.ts')

/**
 * How wide a permission grant reaches.
 *
 * The prompt used to offer one width per call — `run_command:<executable>` —
 * so permitting `git diff` for a project also permitted `git push`, and the
 * only alternative was answering every diff by hand. The rule list is the
 * second axis: `git diff *` alongside `git *`, this directory alongside every
 * file, with the narrowest offered first so the default answer is the
 * small one.
 */
describe('the widths a command prompt offers', () => {
  it('offers the subcommand before the executable', () => {
    expect(commandRules('git diff --stat')).toEqual([
      { key: 'run_command:prefix:git diff', label: 'every `git diff …` command' },
      { key: 'run_command:prefix:git', label: 'every `git` command' },
    ])
  })

  it('offers only the executable when the next word is a flag', () => {
    // `ls -la *` is one command line wearing a family's clothes: the flag says
    // nothing about which calls come next.
    expect(commandRules('ls -la')).toEqual([
      { key: 'run_command:prefix:ls', label: 'every `ls` command' },
    ])
  })

  it('offers nothing for an executable that must not be signed away', () => {
    // Not a sandbox — the workspace root is that. It is refusing to put "every
    // `rm` command, forever" on a chip the user clicks while reading a diff.
    for (const command of ['rm -rf build', 'sudo apt install jq', 'bash script.sh']) {
      expect(commandRules(command)).toEqual([])
    }
  })

  it('scopes a command whose ARGUMENTS are quoted', () => {
    // Quotes group words; they cannot change which program runs once chaining,
    // expansion, substitution, and redirection are already excluded. Refusing
    // them would have left the sample's commonest command — a commit with a
    // message — permanently unscopable.
    expect(commandRules('git commit -m "two words"')).toEqual([
      { key: 'run_command:prefix:git commit', label: 'every `git commit …` command' },
      { key: 'run_command:prefix:git', label: 'every `git` command' },
    ])
  })

  it('refuses a quoted or escaped program word', () => {
    // `"git"` and `git` must not share a key: one spelling would silently
    // widen a grant made against the other.
    expect(commandRules('"git" diff')).toEqual([])
    expect(commandRuleKeys('"git" diff')).toEqual([])
  })

  it('offers nothing when the line is more than an argument list', () => {
    // The chip would read "every `git diff …` command" while the line also
    // deletes the workspace. Shell syntax means: permit once, remember nothing.
    for (const command of [
      'git diff && rm -rf .',
      'git diff | tee out.txt',
      'git diff; echo done',
      'git $CMD',
      'git diff `whoami`',
      'git diff > out.txt',
      'git diff --stat\\; rm -rf .',
      'FOO=1 git diff',
    ]) {
      expect(commandRules(command)).toEqual([])
      expect(commandRuleKeys(command)).toEqual([])
      expect(plainTokens(command)).toEqual([])
    }
  })
})

describe('a width has to be readable to be offered', () => {
  it('does not offer a chip naming a word too long to read', () => {
    // A model can write a 400-character first word. The chip row is where the
    // user weighs one width against another, and a chip that wide is not a
    // decision anyone can make — so it is not offered, and `once` still is.
    const long = `sub${'x'.repeat(60)}`
    expect(commandRules(`tool ${long}`)).toEqual([
      { key: 'run_command:prefix:tool', label: 'every `tool` command' },
    ])
    expect(commandRules(`${'/deep'.repeat(20)}/tool run`)).toEqual([])
    // Matching is unaffected: a grant added by hand still covers the call.
    expect(commandRuleKeys(`tool ${long}`)).toContain(`run_command:prefix:tool ${long}`)
  })

  it('does not offer a directory chip too long to read', async () => {
    const directory = Array.from({ length: 12 }, (_, index) => `segment-${String(index)}`).join('/')
    const description = await describeMutation(
      await mkdtemp(join(tmpdir(), 'approval-rules-')),
      'write_file',
      { path: `${directory}/file.ts`, content: 'x' },
    )
    expect(description?.rules).toEqual([{ key: 'write_file', label: 'writing whole files' }])
    // Still matched if it was granted deliberately.
    expect(description?.matchKeys).toContain(`write_file:dir:${directory}`)
  })
})

describe('which stored grants cover a command', () => {
  it('recognises every prefix of the call, narrowest first', () => {
    expect(commandRuleKeys('git diff --stat')).toEqual([
      'run_command:prefix:git diff --stat',
      'run_command:prefix:git diff',
      'run_command:prefix:git',
      'run_command:git',
    ])
  })

  it('keeps honouring the executable key written before prefixes existed', () => {
    // Rows already in SQLite say `run_command:git` and still mean every `git`
    // command; a migration that silently stopped matching would re-prompt for
    // work the user already permitted.
    expect(commandRuleKeys('git status')).toContain('run_command:git')
  })

  it('does not let a narrow grant cover a wider call', () => {
    // The whole point: `git diff` approved, `git push` still asked about.
    expect(commandRuleKeys('git push --force')).not.toContain('run_command:prefix:git diff')
  })

  it('matches on whole words, not on characters', () => {
    // `run_command:prefix:git d` must not cover `git diff`, or a stored rule
    // could reach commands its label never named.
    expect(commandRuleKeys('git diff')).not.toContain('run_command:prefix:git d')
  })

  it('keeps a path-invoked binary in its own key, apart from the bare name', () => {
    // The agent can WRITE files in the workspace, so a `./git` it just created
    // must not be permitted by the user's trust in `git`. Reported by asking
    // what `run_command:git` would cover if the path were stripped: anything
    // named git, anywhere, including a file the model authored a moment ago.
    const keys = commandRuleKeys('./git diff')
    expect(keys).toContain('run_command:prefix:./git diff')
    expect(keys).not.toContain('run_command:prefix:git diff')
    // Nor may it ride the pre-prefix executable key.
    expect(keys).not.toContain('run_command:git')
    // And an absolute path is a different file again.
    expect(commandRuleKeys('/usr/bin/git diff')).toEqual([
      'run_command:prefix:/usr/bin/git diff',
      'run_command:prefix:/usr/bin/git',
    ])
  })

  it('reads the ban list through the path, and ignores case', () => {
    // `./scripts/rm` is still `rm`, and a case-insensitive filesystem runs
    // `RM -rf build` perfectly well.
    expect(commandRules('./scripts/rm -rf build')).toEqual([])
    expect(commandRules('RM -rf build')).toEqual([])
    expect(commandRules('/usr/bin/sudo apt install jq')).toEqual([])
  })

  it('caps how long a prefix may get', () => {
    // Past a handful of words a "family" is one command line with arguments:
    // remembered forever, matching nothing again.
    const keys = commandRuleKeys('pnpm run one two three four five six seven eight nine')
    expect(keys[0]).toBe('run_command:prefix:pnpm run one two three four five six')
  })

  it('still matches a grant on an ungrantable executable it would never suggest', () => {
    // A user who added `run_command:rm` through the permissions API meant it;
    // refusing to match it would silently ignore a standing decision.
    expect(commandRules('rm -rf build')).toEqual([])
    expect(commandRuleKeys('rm -rf build')).toContain('run_command:rm')
  })
})

describe('the widths a filesystem prompt offers', () => {
  const root = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'approval-rules-'))

  it('offers the file’s directory before the whole tool', async () => {
    const description = await describeMutation(await root(), 'write_file', {
      path: 'src/ui/chat/ApprovalCard.tsx',
      content: 'x',
    })
    expect(description?.rules).toEqual([
      { key: 'write_file:dir:src/ui/chat', label: 'writing whole files under `src/ui/chat/`' },
      { key: 'write_file', label: 'writing whole files' },
    ])
  })

  it('recognises a grant on any directory above the file', async () => {
    const description = await describeMutation(await root(), 'edit_file', {
      path: 'src/ui/chat/types.ts',
      oldText: 'a',
      newText: 'b',
    })
    expect(description?.matchKeys).toEqual([
      'edit_file:dir:src/ui/chat',
      'edit_file:dir:src/ui',
      'edit_file:dir:src',
      'edit_file:dir:.',
      'edit_file',
    ])
  })

  it('offers only the tool for a file at the workspace root', async () => {
    // `write_file:dir:.` and `write_file` cover the same calls, so offering
    // both would be two chips for one decision.
    const description = await describeMutation(await root(), 'write_file', {
      path: 'README.md',
      content: 'x',
    })
    expect(description?.rules).toEqual([{ key: 'write_file', label: 'writing whole files' }])
  })

  it('narrows a move to a directory covering BOTH paths', async () => {
    // A grant that covered only the source would not cover the call: the file
    // lands somewhere the user never permitted.
    const description = await describeMutation(await root(), 'move_path', {
      from: 'src/ui/chat/old.ts',
      to: 'src/lib/new.ts',
    })
    expect(description?.rules[0]?.key).toBe('move_path:dir:src')
    expect(description?.matchKeys).toEqual(['move_path:dir:src', 'move_path:dir:.', 'move_path'])
  })

  it('scopes a new directory to the parent it lands in', async () => {
    const description = await describeMutation(await root(), 'create_directory', {
      path: 'src/ui/panels',
    })
    expect(description?.rules[0]?.key).toBe('create_directory:dir:src/ui')
  })

  it('offers no directory width for a path it cannot place', async () => {
    // An absolute path or one climbing out of the root has no workspace
    // directory to name; the call fails on its own terms, and until it does the
    // prompt must not imply a scope it cannot enforce.
    for (const path of ['/etc/hosts', '../outside.txt']) {
      const description = await describeMutation(await root(), 'delete_path', { path })
      expect(description?.rules).toEqual([
        { key: 'delete_path', label: 'deleting files and directories' },
      ])
      expect(description?.matchKeys).toEqual(['delete_path'])
    }
  })

  it('resolves a path the way the tool will, not the way it was typed', async () => {
    // `src/ui/../lib/x.ts` writes to `src/lib/x.ts`. A rule derived from the
    // typed string would either name a directory nothing is written to, or
    // refuse to scope a perfectly ordinary path.
    const description = await describeMutation(await root(), 'write_file', {
      path: './src/ui/../lib/x.ts',
      content: 'x',
    })
    expect(description?.rules[0]?.key).toBe('write_file:dir:src/lib')
  })

  it('does not read a separator inside a file NAME as a directory', async () => {
    // On POSIX a backslash is an ordinary character in a file name, so
    // `a\\b.txt` is one root-level file. Treating it as `a/b.txt` would let a
    // grant on the real directory `a/` cover writes at the root.
    const description = await describeMutation(await root(), 'write_file', {
      path: 'a\\b.txt',
      content: 'x',
    })
    const scoped = (description?.matchKeys ?? []).filter(key => key.startsWith('write_file:dir:'))
    expect(scoped).toEqual(['write_file:dir:.'])
  })

  it('names the working directory a command runs in', async () => {
    // The rule is about the command line alone, so the directory it runs in has
    // to be visible on the card the decision is made against.
    const description = await describeMutation(await root(), 'run_command', {
      command: 'git clean -fd',
      cwd: 'packages/core',
    })
    expect(description?.summary).toBe('git clean -fd (in packages/core/)')
    const atRoot = await describeMutation(await root(), 'run_command', {
      command: 'git status',
      cwd: '.',
    })
    expect(atRoot?.summary).toBe('git status')
  })

  it('still previews the diff it would write', async () => {
    // The rule list is an addition, not a replacement: the card the decision is
    // made against has to survive it.
    const directory = await root()
    await writeFile(join(directory, 'note.md'), 'before\n', 'utf8')
    const description = await describeMutation(directory, 'write_file', {
      path: 'note.md',
      content: 'after\n',
    })
    expect(description?.card?.kind).toBe('diff')
  })
})
