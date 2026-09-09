/**
 * What a command line would destroy, read before it runs.
 *
 * The workspace root confines where a tool may *write*: `write_file` and
 * `delete_path` resolve their path through it and refuse to leave. A shell does
 * not work that way. `run_command` confines the working DIRECTORY and hands the
 * rest of the line to the platform shell, so `rm -rf ~`, `del /s /q C:\` and
 * `diskutil eraseDisk` are all one prompt away from the machine the user is
 * sitting at — and a permission card that renders them as one more grey line of
 * monospace is a card that gets approved by reflex.
 *
 * This module reads the line for those cases and says so in words, loudly. It
 * is NOT a sandbox and must not be mistaken for one: it recognises the shapes
 * that are worth stopping a human for, and anything it recognises also loses
 * the right to be remembered as a grant — a destructive line is answered once,
 * deliberately, or not at all.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** How loudly a hazard has to be said. */
export type HazardSeverity = 'critical' | 'warning'

/** One thing about a pending call that the user has to read before allowing it. */
export interface Hazard {
  readonly severity: HazardSeverity
  /** The headline, e.g. "Deletes files outside the workspace". */
  readonly title: string
  /** What was recognised, quoting the operative words of the line. */
  readonly detail: string
}

/**
 * Shell syntax that starts a new command within one line.
 *
 * Hazard reading deliberately looks INSIDE these, unlike rule derivation which
 * gives up on them: `cd / && rm -rf *` is exactly the line that must not slip
 * through because its first word was `cd`.
 */
const SEGMENT_BREAK = /(?:&&|\|\||[;|\n\r]|\$\(|\)|`)/

/** Deleting commands, by platform, keyed on the program's bare name. */
const DELETERS: ReadonlySet<string> = new Set([
  // POSIX / macOS
  'rm', 'rmdir', 'unlink', 'shred', 'srm',
  // Windows `cmd`
  'del', 'erase', 'rd',
  // PowerShell, including its aliases for the same cmdlet
  'remove-item', 'ri', 'clear-content', 'remove-itemproperty',
])

/**
 * Commands that destroy a whole volume or the boot state, where no flag and no
 * target makes them safe enough to pass without a stop.
 */
const DEVICE_DESTROYERS: readonly { readonly program: string; readonly words?: readonly string[]; readonly what: string }[] = [
  { program: 'mkfs', what: 'formats a filesystem' },
  { program: 'mke2fs', what: 'formats a filesystem' },
  { program: 'newfs', what: 'formats a filesystem' },
  { program: 'fdisk', what: 'rewrites a disk partition table' },
  { program: 'parted', what: 'rewrites a disk partition table' },
  { program: 'diskutil', words: ['erasedisk', 'erasevolume', 'zerodisk', 'secureerase', 'reformat', 'partitiondisk'], what: 'erases a disk or volume' },
  { program: 'format', what: 'formats a volume' },
  { program: 'diskpart', what: 'rewrites disks and partitions' },
  { program: 'clear-disk', what: 'erases a disk' },
  { program: 'format-volume', what: 'formats a volume' },
  { program: 'remove-partition', what: 'deletes a partition' },
  { program: 'vssadmin', words: ['delete'], what: 'deletes the shadow copies Windows restores from' },
  { program: 'wmic', words: ['shadowcopy'], what: 'deletes the shadow copies Windows restores from' },
  { program: 'cipher', words: ['/w'], what: 'overwrites free space on a volume' },
  { program: 'tmutil', words: ['delete', 'deletelocalsnapshots'], what: 'deletes Time Machine backups' },
  { program: 'mkswap', what: 'reformats a swap device' },
]

/**
 * Commands whose real subject is a LATER word on the line.
 *
 * `sh -c "rm -rf /"`, `ls | xargs rm -rf`, `powershell -Command "Remove-Item
 * -Recurse -Force C:\"` — read by their first word, every one of them is a
 * harmless-looking `sh`, `xargs` or `powershell`. Reading them that way is how
 * a warning gets bypassed by an extra word, so the deleter is looked for
 * inside them instead.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh',
  'powershell', 'pwsh', 'cmd', 'command',
  'xargs', 'env', 'nice', 'nohup', 'timeout', 'time', 'stdbuf', 'setsid', 'script',
  // The line runs on another machine or inside a container with the host
  // mounted. "Not this filesystem" is not the same as "not a filesystem".
  'ssh', 'docker', 'podman', 'kubectl', 'nerdctl', 'lima',
])

/** Commands that move the working directory every later relative path is read from. */
const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl'])

/** Commands that move files, where a destination outside the workspace matters. */
const MOVERS: ReadonlySet<string> = new Set(['mv', 'move', 'move-item', 'mi', 'rename-item'])

/** Commands that rewrite access to files rather than the files themselves. */
const PERMISSION_CHANGERS: ReadonlySet<string> = new Set([
  'chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'attrib', 'set-acl',
])

/** Commands that run the rest of the line as another user. */
const ELEVATORS: ReadonlySet<string> = new Set(['sudo', 'doas', 'su', 'runas', 'start-process'])

/** Paths that are the machine rather than a file in it. */
const SYSTEM_ROOTS: readonly string[] = [
  '/', '/system', '/library', '/applications', '/users', '/volumes',
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/var', '/opt', '/private', '/dev',
  '/boot', '/proc', '/sys', '/home', '/root',
]

/**
 * Directories the machine hands out for scratch files.
 *
 * Still outside the workspace, and still worth saying — but an agent clearing
 * its own scratch directory is routine, and a card that shouts "destructive"
 * at `rm -rf /tmp/build-cache` teaches the user to click through the shouting.
 */
const TEMP_ROOTS: readonly string[] = [
  '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp',
  '/var/folders', '/private/var/folders', '/dev/shm',
  '%temp%', '%tmp%', '$tmpdir', '${tmpdir}',
]

/** Environment references that stand for the user's own files. */
const HOME_REFERENCES: readonly string[] = [
  '~', '$home', '${home}', '%userprofile%', '%homepath%', '%homedrive%', '$env:userprofile',
]

/** Environment references that stand for the operating system's own files. */
const SYSTEM_REFERENCES: readonly string[] = [
  '%systemroot%', '%windir%', '%programfiles%', '%programdata%', '%systemdrive%',
  '$env:systemroot', '$env:windir',
]

/** One word of a command line, with the shell's quoting taken off. */
function bare(token: string): string {
  const unquoted = token.replace(/^['"]/, '').replace(/['"]$/, '')
  return unquoted
}

/** The program a segment runs, lower-cased and without a path or `.exe`. */
function programName(token: string): string {
  const name = bare(token).split(/[/\\]/).pop() ?? ''
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
}

/** Whether a word is a flag rather than a target. */
function isFlag(token: string): boolean {
  const word = bare(token)
  return word.startsWith('-') || /^\/[a-zA-Z]$/.test(word) || /^\/[a-zA-Z]:/.test(word)
}

/** Whether the flags of a delete ask for a recursive or forced delete. */
function forcesDelete(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    const word = bare(token).toLowerCase()
    if (/^-{1,2}(?:r|recursive|force|f|rf|fr)$/.test(word)) return true
    // A bundle like `-rfv`; `--` long options are covered above.
    if (/^-[a-z]*[rf][a-z]*$/.test(word) && !word.startsWith('--')) return true
    if (word === '/s' || word === '/q' || word === '/f') return true
    return word.startsWith('-recurse') || word.startsWith('-force')
  })
}

/** Whether a word cannot be resolved to a path without running the shell. */
function isUnresolvable(word: string): boolean {
  return /[$%*?~]/.test(word) || word.startsWith('%') || word.includes('${')
}

/** What one target word of a destructive command refers to. */
type Target =
  | { readonly kind: 'inside'; readonly absolute: string }
  | { readonly kind: 'outside'; readonly path: string }
  /** Outside the workspace, in a directory the machine hands out for scratch. */
  | { readonly kind: 'temporary'; readonly path: string }
  | { readonly kind: 'machine'; readonly path: string }
  | { readonly kind: 'unresolvable'; readonly word: string }

/**
 * Place one target word relative to the workspace.
 * @param word - The word as written, quotes already off.
 * @param root - Workspace root.
 * @param cwd - Absolute working directory the command will run in.
 * @returns Where it points, as far as can be told without running a shell.
 */
function placeTarget(word: string, root: string, cwd: string): Target {
  const lower = word.toLowerCase()
  // `rm -rf /*` is `rm -rf /` with one more character, and `rm -rf ~/.` is the
  // home directory. A trailing separator, glob or dot names the same place as
  // what precedes it, so it comes off before the place is read — otherwise the
  // most dangerous spellings are the ones that read as "unresolvable", and
  // `rm -rf dist/*` reads as unknown when it is plainly the workspace's own
  // `dist`. Case is kept for resolution and dropped only for comparisons.
  const trimmed = word.replace(/(?:[/\\]+[*.]*)+$/, '')
  const stripped = trimmed.toLowerCase()

  // The environment references come first: they cannot be resolved here, and
  // "this is your home directory" is the useful thing to say about `~`.
  if (HOME_REFERENCES.includes(stripped)
    || HOME_REFERENCES.some(home => lower.startsWith(`${home}/`) || lower.startsWith(`${home}\\`))) {
    return { kind: 'machine', path: word }
  }
  if (SYSTEM_REFERENCES.includes(stripped) || SYSTEM_REFERENCES.some(name => lower.startsWith(name))) {
    return { kind: 'machine', path: word }
  }
  if (TEMP_ROOTS.some(temp => temp.startsWith('%') || temp.startsWith('$'))
    && TEMP_ROOTS.some(temp => (temp.startsWith('%') || temp.startsWith('$'))
      && (stripped === temp || stripped.startsWith(`${temp}/`) || stripped.startsWith(`${temp}\\`)))) {
    return { kind: 'temporary', path: word }
  }
  // A Windows drive root or a UNC share, written on any platform: `C:\`,
  // `C:\*`, `\\server\share`.
  if (/^[a-z]:(?:[/\\][*.]*)?$/.test(stripped) || /^\\\\[^\\]+/.test(word)) {
    return { kind: 'machine', path: word }
  }
  // A drive-letter path is absolute on Windows and would be read as a RELATIVE
  // path by `resolve` on any other platform — `C:\Windows` became a folder
  // called `C:` inside the workspace, which is how `del /s /q C:\Windows` read
  // as ordinary local housekeeping.
  if (/^[a-z]:[/\\]/.test(stripped)) {
    return /windows|system32|program files|programdata|users/.test(stripped)
      ? { kind: 'machine', path: word }
      : { kind: 'outside', path: word }
  }

  // What is left after the glob came off still has to be a path: `$BUILD/*`
  // and `*.log` name whatever the shell decides they name. A word that is
  // NOTHING but globs and dots names the working directory itself.
  // `*` and `.` name the working directory; `..` names its parent, and reading
  // the two the same way called a delete of the directory ABOVE the workspace
  // a delete of the workspace.
  const globOnly = /[*?]/.test(trimmed) && /^[*?.]+$/.test(trimmed)
  const base = trimmed === '' ? '/' : globOnly ? '.' : trimmed
  if (isUnresolvable(base)) return { kind: 'unresolvable', word }

  // Everything else is classified by the path the shell will ACTUALLY reach.
  // Reading the word as typed put `/tmp/../etc/hosts` in the scratch space it
  // starts with rather than the system directory it ends in.
  const absolute = isAbsolute(base) ? resolve(base) : resolve(cwd, base)
  const rest = relative(root, absolute)
  const within = rest === '' || !(rest.startsWith('..') || rest.split(sep).includes('..') || isAbsolute(rest))
  if (within) return { kind: 'inside', absolute }

  const place = absolute.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const under = (parents: readonly string[]): boolean => parents.some(parent => place === parent
    || (parent !== '/' && place.startsWith(`${parent}/`)))
  // Scratch space before system directories: `/var/tmp` and `/private/tmp` sit
  // under `/var` and `/private`, and the quieter reading is the true one.
  if (under(TEMP_ROOTS.filter(temp => temp.startsWith('/')))) return { kind: 'temporary', path: word }
  if (place === '' || under(SYSTEM_ROOTS)) return { kind: 'machine', path: word }
  return { kind: 'outside', path: word }
}

/** Whether a word names a command this module has something to say about. */
function isSubject(token: string): boolean {
  const name = programName(token)
  if (name === '') return false
  return DELETERS.has(name) || MOVERS.has(name) || PERMISSION_CHANGERS.has(name)
    || DIRECTORY_CHANGERS.has(name) || name === 'dd' || name === 'find'
    || DEVICE_DESTROYERS.some(entry => name === entry.program || name.startsWith(entry.program))
}

/** One command within a line, already split off its neighbours. */
interface Segment {
  readonly program: string
  readonly tokens: readonly string[]
}

/**
 * Split a command line into the commands a shell would run separately.
 * @param command - The whole line.
 * @returns Each command's program name and words, elevation prefixes removed.
 */
function segments(command: string): readonly Segment[] {
  const found: Segment[] = []
  for (const part of command.split(SEGMENT_BREAK)) {
    let tokens = part.trim().split(/\s+/).filter(token => token !== '')
    // `sudo rm -rf /` is an `rm`, and reading it as a `sudo` would miss the
    // only thing worth saying about it. Environment prefixes go the same way.
    while (tokens.length > 1 && (ELEVATORS.has(programName(tokens[0] ?? '')) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(bare(tokens[0] ?? '')))) {
      tokens = tokens.slice(1)
    }
    // A wrapper's own words come first and its subject comes later, so the
    // subject is looked for rather than assumed to be the next word: `sh -lc
    // "rm -rf ~"` and `ls | xargs rm -rf` both anchor on the `rm`.
    if (WRAPPERS.has(programName(tokens[0] ?? ''))) {
      const subject = tokens.findIndex((token, index) => index > 0 && isSubject(token))
      if (subject !== -1) tokens = tokens.slice(subject)
    }
    const program = programName(tokens[0] ?? '')
    if (program === '') continue
    found.push({ program, tokens: tokens.slice(1) })
  }
  return found
}

/** The `cd` targets of a line, in order, so a later relative path can be read. */
function directoryChanges(command: string): readonly string[] {
  const changes: string[] = []
  for (const segment of segments(command)) {
    if (!DIRECTORY_CHANGERS.has(segment.program)) continue
    const target = segment.tokens.map(bare).find(token => !isFlag(token))
    changes.push(target ?? '~')
  }
  return changes
}

/**
 * Read a command line for what it would destroy.
 *
 * @param command - The command line about to run.
 * @param options - Workspace root, and the absolute directory the command runs
 *   in (the shell's `cwd`, already resolved by the caller).
 * @returns The hazards, most severe first; empty when nothing was recognised.
 *   An empty list is NOT a statement that the line is safe — only that nothing
 *   this module knows about was found in it.
 */
export function commandHazards(
  command: string,
  options: { readonly root: string; readonly cwd: string },
): readonly Hazard[] {
  const { root, cwd } = options
  const hazards: Hazard[] = []
  const changes = directoryChanges(command)
  // A `cd` earlier in the same line moves what every later relative path means,
  // and `cd /etc && rm -rf .` is the whole reason to care.
  const movedOutside = changes.some((target) => {
    const placed = placeTarget(target, root, cwd)
    return placed.kind !== 'inside'
  })

  for (const segment of segments(command)) {
    const written = segment.tokens.map(bare)
    const device = DEVICE_DESTROYERS.find(entry => entry.program === segment.program
      && (entry.words === undefined
        || written.some(token => entry.words?.includes(token.toLowerCase()) === true))
      || (segment.program.startsWith(entry.program) && entry.program.startsWith('mkfs')))
    if (device !== undefined) {
      hazards.push({
        severity: 'critical',
        title: 'Destroys a disk, a volume, or the system’s ability to restore',
        detail: `\`${segment.program}\` ${device.what}. This reaches the whole machine, not the workspace, and nothing in the workspace root limits it.`,
      })
      continue
    }

    // `dd of=/dev/disk0` writes a raw device; the `of=` is the whole story.
    if (segment.program === 'dd') {
      const output = written.find(token => token.toLowerCase().startsWith('of='))
      if (output !== undefined) {
        hazards.push({
          severity: 'critical',
          title: 'Writes directly to a device or file, byte for byte',
          detail: `\`dd\` writes to \`${output.slice(3)}\`. Written to a disk device this destroys the partition table and every filesystem on it; written to a file it replaces the file with no recovery.`,
        })
      }
      continue
    }

    // `find / -name x -delete` and `find / -exec rm -rf {} +` delete without
    // ever naming `rm` first.
    if (segment.program === 'find') {
      const deletes = written.some((token, index) => token === '-delete'
        || (token === '-exec' || token === '-execdir' || token === '-ok')
        && written.slice(index + 1).some(word => DELETERS.has(programName(word))))
      if (deletes) {
        const outside = written.filter(token => !isFlag(token))
          .map(token => placeTarget(token, root, cwd))
          .find(target => target.kind === 'machine' || target.kind === 'outside')
        if (outside !== undefined) {
          hazards.push({
            severity: 'critical',
            title: 'Deletes files outside the workspace',
            detail: `\`find\` deletes what it matches under \`${outside.path}\`, which is not inside \`${root}\`. A pattern that matches more than intended deletes more than intended, everywhere it walked.`,
          })
        }
      }
      continue
    }

    if (MOVERS.has(segment.program)) {
      const targets = written.filter(token => !isFlag(token))
        .map(token => placeTarget(token, root, cwd))
      // The DESTINATION is the last path; a destination outside the workspace
      // writes outside it, and `mv file /dev/null` destroys the file outright.
      const destination = targets.at(-1)
      if (destination !== undefined && (destination.kind === 'machine' || destination.kind === 'outside')) {
        hazards.push({
          severity: 'critical',
          title: 'Moves files out of the workspace',
          detail: `\`${segment.program}\` writes to \`${destination.path}\`, outside \`${root}\`. Overwriting a file there replaces it, and moving onto a device such as \`/dev/null\` destroys what was moved.`,
        })
      }
      continue
    }

    if (PERMISSION_CHANGERS.has(segment.program) && forcesDelete(segment.tokens)) {
      const outside = written.filter(token => !isFlag(token))
        .map(token => placeTarget(token, root, cwd))
        .find(target => target.kind === 'machine' || target.kind === 'outside')
      if (outside !== undefined) {
        hazards.push({
          severity: 'critical',
          title: 'Rewrites permissions outside the workspace',
          detail: `\`${segment.program}\` changes ownership or permissions recursively under \`${outside.path}\`. Applied to a system directory this can lock the user out of their own machine, and it is not undone by reversing the command.`,
        })
      }
      continue
    }

    // `git clean -xdf` deletes untracked files: inside the workspace, so no
    // path check catches it, and nothing in git can bring them back.
    if (segment.program === 'git' && written[0] === 'clean'
      && written.some(token => /^-[a-zA-Z]*[xdf]/.test(token))) {
      hazards.push({
        severity: 'warning',
        title: 'Deletes untracked files git cannot restore',
        detail: '`git clean` removes files git is not tracking — a local `.env`, an uncommitted scratch file, a build output someone needs. Committed work is safe; nothing else is, and there is no `git` command that undoes it.',
      })
      continue
    }

    // `rsync --delete` makes the destination match the source by deleting what
    // the source does not have.
    if (segment.program === 'rsync' && written.some(token => token.toLowerCase().startsWith('--delete'))) {
      const destination = written.filter(token => !isFlag(token))
        .map(token => placeTarget(token, root, cwd)).at(-1)
      if (destination !== undefined && destination.kind !== 'inside') {
        hazards.push({
          severity: 'critical',
          title: 'Deletes files outside the workspace',
          detail: `\`rsync --delete\` makes \`${destination.kind === 'unresolvable' ? destination.word : destination.path}\` match the source by REMOVING everything the source does not have. Pointed at a directory outside \`${root}\`, that is a delete of files this run never created.`,
        })
      }
      continue
    }

    if (!DELETERS.has(segment.program)) continue
    const forced = forcesDelete(segment.tokens)
    const targets = written.filter(token => !isFlag(token))
      .map(token => placeTarget(token, root, cwd))

    for (const target of targets) {
      if (target.kind === 'machine') {
        hazards.push({
          severity: 'critical',
          title: 'Deletes the machine’s own files',
          detail: `\`${segment.program}\` targets \`${target.path}\` — the filesystem root, your home directory, or a system directory. Allowing this can make the machine unbootable or destroy every file the user owns. It is not undoable and no backup runs first.`,
        })
      } else if (target.kind === 'temporary') {
        hazards.push({
          severity: 'warning',
          title: 'Deletes files in a temporary directory',
          detail: `\`${segment.program}\` targets \`${target.path}\`, which is outside \`${root}\` — the machine's scratch space, shared with every other program using it.`,
        })
      } else if (target.kind === 'outside') {
        hazards.push({
          severity: 'critical',
          title: 'Deletes files outside the workspace',
          detail: `\`${segment.program}\` targets \`${target.path}\`, which resolves outside \`${root}\`. The workspace root does NOT confine a shell command: this deletes real files elsewhere on the machine.`,
        })
      } else if (target.kind === 'unresolvable' && forced) {
        hazards.push({
          severity: 'warning',
          title: 'Deletes a target that cannot be read before it runs',
          detail: `\`${segment.program}\` deletes \`${target.word}\`, which the shell expands — a variable, a glob, or \`~\`. What it will actually remove cannot be shown here, and a forced recursive delete of an empty or unexpected value has taken whole home directories.`,
        })
      }
    }

    if (movedOutside && targets.some(target => target.kind === 'inside' || target.kind === 'unresolvable')) {
      hazards.push({
        severity: 'critical',
        title: 'Deletes files outside the workspace',
        detail: `An earlier \`cd\` in the same line moves out of the workspace, so \`${segment.program}\`’s relative path is deleted somewhere else — not in \`${root}\`.`,
      })
    }

    // Not when a `cd` moved out first: then `.` is not the workspace, and
    // saying so would name the wrong directory as the one being lost.
    if (forced && !movedOutside
      && targets.some(target => target.kind === 'inside' && target.absolute === resolve(root))) {
      hazards.push({
        severity: 'warning',
        title: 'Deletes the whole workspace',
        detail: `\`${segment.program}\` targets the workspace root itself, so everything in \`${root}\` goes — including files git is not tracking, which nothing can bring back.`,
      })
    }

    if (forced && targets.length === 0) {
      hazards.push({
        severity: 'warning',
        title: 'Forced delete with no readable target',
        detail: `\`${segment.program}\` is being run with force or recursion but no target this card can read. Nothing here can say what it removes.`,
      })
    }
  }

  // `echo x > /etc/hosts` never names a deleting command, and `>` truncates
  // its target before anything is written. Every redirection destination is
  // read as a write, wherever it points.
  for (const match of command.matchAll(/(?:^|\s)\d?>{1,2}&?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
    const written = bare(match[1] ?? '')
    if (written === '' || /^[0-9-]$/.test(written)) continue
    const target = placeTarget(written, root, cwd)
    if (target.kind !== 'machine' && target.kind !== 'outside') continue
    hazards.push({
      severity: 'critical',
      title: 'Overwrites a file outside the workspace',
      detail: `The line redirects output to \`${target.path}\`, outside \`${root}\`. A redirection truncates its target first, so whatever is there now is gone before the command writes a byte.`,
    })
  }

  const elevated = command.split(SEGMENT_BREAK).some((part) => {
    const first = part.trim().split(/\s+/)[0] ?? ''
    return ELEVATORS.has(programName(first))
  })
  if (elevated) {
    hazards.push({
      severity: 'warning',
      title: 'Runs as another user',
      detail: 'The line escalates privileges, so the workspace root, file permissions, and anything else protecting the rest of the machine stop applying.',
    })
  }

  // Most severe first: the card shows them in order, and a warning must never
  // be the first thing read on a line that also destroys a disk.
  return [...hazards.filter(hazard => hazard.severity === 'critical'),
    ...hazards.filter(hazard => hazard.severity === 'warning')]
}
