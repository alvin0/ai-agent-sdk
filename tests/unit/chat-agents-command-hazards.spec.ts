import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { commandHazards } =
  await import('../../samples/chat-agents/backend/src/hazards.ts')
const { describeMutation } =
  await import('../../samples/chat-agents/backend/src/tools.ts')

const root = '/work/project'
const inside = (command: string) => commandHazards(command, { root, cwd: root })

/** The titles of what a line was recognised as, most severe first. */
const titles = (command: string): readonly string[] => inside(command).map(hazard => hazard.title)

/** Whether a line was recognised as destroying something. */
const critical = (command: string): boolean =>
  inside(command).some(hazard => hazard.severity === 'critical')

/**
 * Reading a command line for what it would destroy.
 *
 * The workspace root confines the FILESYSTEM tools: `write_file` resolves its
 * path through it and refuses to leave. `run_command` confines the working
 * directory and hands the rest of the line to the platform shell — so
 * `rm -rf ~` was, until this existed, one grey line of monospace and one
 * reflex click away from the machine the user is sitting at.
 */
describe('deletes that leave the workspace', () => {
  it('recognises the filesystem root, on every platform’s spelling', () => {
    expect(critical('rm -rf /')).toBe(true)
    expect(critical('rm -rf /*')).toBe(true)
    expect(critical('del /s /q C:\\')).toBe(true)
    expect(critical('rd /s /q C:\\')).toBe(true)
    expect(critical('Remove-Item -Recurse -Force C:\\')).toBe(true)
    expect(critical('rm -rf \\\\fileserver\\share')).toBe(true)
  })

  it('recognises the user’s own files', () => {
    // `~` and `$HOME` never reach the workspace and are not recoverable.
    for (const command of [
      'rm -rf ~',
      'rm -rf ~/Documents',
      'rm -rf $HOME',
      'rm -rf "${HOME}/Library"',
      'del /s /q %USERPROFILE%',
      'Remove-Item -Recurse -Force $env:USERPROFILE',
    ]) {
      expect(titles(command)[0]).toBe('Deletes the machine’s own files')
    }
  })

  it('recognises system directories on macOS and Windows', () => {
    for (const command of [
      'rm -rf /System/Library',
      'rm -rf /Applications',
      'rm -rf /usr/local',
      'rm -rf /Volumes/Backup',
      'del /s /q %SystemRoot%',
      'rd /s /q %windir%\\System32',
    ]) {
      expect(critical(command)).toBe(true)
    }
  })

  it('recognises an ordinary path that simply is not in the workspace', () => {
    expect(titles('rm -rf /work/other-project')).toEqual(['Deletes files outside the workspace'])
    // Climbing out with `..` is the same thing written differently.
    expect(titles('rm -rf ../../other')).toEqual(['Deletes files outside the workspace'])
  })

  it('leaves an ordinary workspace delete alone', () => {
    // The point is a card the user still reads. Warning about `rm -rf dist`
    // every time is how a warning stops being read.
    expect(inside('rm -rf dist')).toEqual([])
    expect(inside('rm -rf ./build/cache')).toEqual([])
    expect(inside('git status')).toEqual([])
    expect(inside('pnpm test')).toEqual([])
  })
})

describe('what a first word hides', () => {
  it('reads through sudo, and says the privileges changed', () => {
    // Reading `sudo rm -rf /` as a `sudo` call would miss the only thing worth
    // saying about it.
    const found = inside('sudo rm -rf /')
    expect(found[0]?.title).toBe('Deletes the machine’s own files')
    expect(found.some(hazard => hazard.title === 'Runs as another user')).toBe(true)
  })

  it('reads through an environment prefix', () => {
    expect(critical('FOO=1 rm -rf /etc')).toBe(true)
  })

  it('reads through a path and an extension', () => {
    expect(critical('/bin/rm -rf /')).toBe(true)
    expect(critical('C:\\Windows\\System32\\del.exe /s /q C:\\')).toBe(true)
  })

  it('reads past a cd that left the workspace', () => {
    // `cd /etc && rm -rf .` deletes `/etc`. Deriving the target from the
    // workspace root would call it an ordinary local delete.
    expect(titles('cd /etc && rm -rf .')).toEqual(['Deletes files outside the workspace'])
    expect(titles('cd ~ ; rm -rf Documents')).toContain('Deletes files outside the workspace')
    // A cd that stays inside changes nothing.
    expect(inside('cd packages/core && rm -rf dist')).toEqual([])
  })

  it('reads inside a chain, a pipe, and a substitution', () => {
    expect(critical('pnpm build && rm -rf /')).toBe(true)
    expect(critical('echo x | rm -rf ~')).toBe(true)
    expect(critical('echo $(rm -rf /etc)')).toBe(true)
    // A substitution as the target cannot be evaluated here, so the honest
    // reading is "forced delete, target unknown" — still a hazard, still no
    // grant, still two clicks.
    expect(titles('rm -rf `echo /`')).toEqual(['Forced delete with no readable target'])
  })
})

describe('the extra word that used to hide a deletion', () => {
  it('reads a deleter out of a shell wrapper', () => {
    // Read by their first word these are a harmless `sh`, `xargs`, or
    // `powershell`, which is exactly how a warning gets bypassed.
    expect(critical('sh -c "rm -rf /"')).toBe(true)
    expect(critical('bash -lc \'rm -rf ~\'')).toBe(true)
    expect(critical('ls | xargs rm -rf /etc')).toBe(true)
    expect(critical('env rm -rf ~')).toBe(true)
    expect(critical('nohup rm -rf / &')).toBe(true)
    expect(critical('powershell -Command "Remove-Item -Recurse -Force C:\\"')).toBe(true)
  })

  it('reads a delete that never names a deleting command', () => {
    expect(critical('find / -name "*.log" -delete')).toBe(true)
    expect(critical('find /Users -type f -exec rm -f {} +')).toBe(true)
    // Inside the workspace it is ordinary housekeeping.
    expect(inside('find . -name "*.log" -delete')).toEqual([])
  })

  it('reads a raw device write', () => {
    expect(titles('dd if=/dev/zero of=/dev/disk0 bs=1m'))
      .toEqual(['Writes directly to a device or file, byte for byte'])
    // Reading a device is not writing one.
    expect(inside('dd if=/dev/urandom bs=1 count=16')).toEqual([])
  })

  it('reads a move that leaves the workspace', () => {
    expect(titles('mv secrets.env /dev/null')).toEqual(['Moves files out of the workspace'])
    expect(critical('mv build ../../elsewhere')).toBe(true)
    expect(inside('mv old.ts src/new.ts')).toEqual([])
  })

  it('reads a recursive permission change on the machine', () => {
    expect(critical('chmod -R 000 /')).toBe(true)
    expect(critical('sudo chown -R root /usr')).toBe(true)
    expect(inside('chmod -R 755 scripts')).toEqual([])
  })

  it('reads a redirection that truncates a file outside the workspace', () => {
    // `>` empties its target before the command writes anything, and no
    // deleting command is ever named.
    expect(titles('echo "" > /etc/hosts')).toEqual(['Overwrites a file outside the workspace'])
    expect(critical('cat junk >> ~/.zshrc')).toBe(true)
    expect(inside('pnpm test > test.log')).toEqual([])
    expect(inside('pnpm build 2>&1 > build.log')).toEqual([])
  })
})

describe('commands that destroy more than files', () => {
  it('recognises volume and disk destruction on each platform', () => {
    for (const command of [
      'mkfs.ext4 /dev/disk2',
      'diskutil eraseDisk JHFS+ Empty /dev/disk2',
      'diskutil secureErase 0 /dev/disk2',
      'format D: /q',
      'diskpart /s script.txt',
      'Clear-Disk -Number 1 -RemoveData',
      'vssadmin delete shadows /all',
      'tmutil delete /Volumes/Backup',
    ]) {
      expect(critical(command)).toBe(true)
    }
  })

  it('does not warn about a disk tool that only reports', () => {
    // `diskutil list` is how a shell script finds out what it is looking at.
    expect(inside('diskutil list')).toEqual([])
    expect(inside('vssadmin list shadows')).toEqual([])
  })
})

describe('saying it loudly only where loudness is earned', () => {
  it('reads a scratch directory as a warning, not as destruction', () => {
    // Still outside the workspace, still said out loud. But an agent clearing
    // its own scratch space is routine, and a card that shouts at
    // `rm -rf /tmp/build-cache` teaches the user to click through shouting.
    const found = inside('rm -rf /tmp/build-cache')
    expect(found[0]?.severity).toBe('warning')
    expect(found[0]?.title).toBe('Deletes files in a temporary directory')
    expect(critical('rm -rf /var/folders/zz/T/agent')).toBe(false)
  })

  it('warns about work git cannot bring back', () => {
    // Inside the workspace, so no path check sees it; a local `.env` and an
    // uncommitted scratch file go with it, and no git command undoes that.
    expect(titles('git clean -xdf')).toEqual(['Deletes untracked files git cannot restore'])
    expect(inside('git clean --dry-run')).toEqual([])
    expect(inside('git status')).toEqual([])
  })

  it('reads a mirror that deletes at the destination', () => {
    expect(critical('rsync -a --delete ./ /Volumes/Backup/')).toBe(true)
    // Without `--delete` it only adds files.
    expect(inside('rsync -a ./ /Volumes/Backup/')).toEqual([])
  })

  it('reads a line that runs somewhere else entirely', () => {
    // Another machine, or a container with the host filesystem mounted, is
    // still a filesystem someone loses.
    expect(critical('ssh build-host "rm -rf /"')).toBe(true)
    expect(critical('docker run --rm -v /:/host alpine rm -rf /host')).toBe(true)
    expect(inside('docker run --rm alpine echo hi')).toEqual([])
  })

  it('stays quiet on the ordinary lines a run is made of', () => {
    // The measure of this module is the lines it says NOTHING about.
    for (const command of [
      'pnpm install', 'pnpm test', 'git commit -m "fix: a > b"', 'ls -la /etc',
      'cat /etc/hosts', 'grep -r x /usr/include', 'cp -r /etc ./backup',
      'tar -czf out.tgz .', 'npm run build 2> err.log', 'rm -rf node_modules',
      'del /q report.txt', 'rd /s /q dist', 'chmod +x scripts/build.sh',
    ]) {
      expect(inside(command)).toEqual([])
    }
  })
})

describe('spellings that used to read as harmless', () => {
  it('classifies by where the path ENDS, not where it starts', () => {
    // `/tmp/../etc` starts in scratch space and ends in a system directory.
    // Reading the word as typed called it a temporary file.
    expect(titles('rm -rf /tmp/../etc')).toEqual(['Deletes the machine’s own files'])
    expect(titles('rm -rf $HOME/../../etc')).toEqual(['Deletes the machine’s own files'])
    expect(titles('rm -rf "/work/project/../other"'))
      .toEqual(['Deletes files outside the workspace'])
  })

  it('reads a drive-letter path as absolute on any platform', () => {
    // `resolve('C:\\Windows')` off Windows yields a folder called `C:` inside
    // the workspace, so `del /s /q C:\Windows` read as local housekeeping —
    // on the one platform where that line is real.
    expect(titles('DEL /S /Q C:\\Windows')).toEqual(['Deletes the machine’s own files'])
    expect(titles('rm -rf D:\\backups')).toEqual(['Deletes files outside the workspace'])
  })

  it('tells a glob apart from the parent directory', () => {
    // `*` and `.` are the workspace; `..` is what contains it. Reading them
    // the same way called a delete above the workspace a delete of it.
    expect(titles('rm -rf *')).toEqual(['Deletes the whole workspace'])
    expect(titles('rm -rf ./*')).toEqual(['Deletes the whole workspace'])
    expect(titles('rm -rf .')).toEqual(['Deletes the whole workspace'])
    expect(titles('rm -rf ..')).toEqual(['Deletes files outside the workspace'])
    // A glob under a subdirectory is ordinary housekeeping.
    expect(inside('rm -rf dist/*')).toEqual([])
  })

  it('reads a cd hidden inside a wrapper', () => {
    // `sh -c "cd / && rm -rf *"` is a delete of the filesystem root wearing
    // three disguises: a wrapper, a chain, and a glob.
    expect(critical('sh -c "cd / && rm -rf *"')).toBe(true)
  })

  it('is case-insensitive about the command, as the shells are', () => {
    expect(critical('REMOVE-ITEM -RECURSE -FORCE ~')).toBe(true)
    expect(critical('RD /S /Q C:\\')).toBe(true)
  })
})

describe('targets that cannot be read before they run', () => {
  it('warns when a forced delete names something the shell will expand', () => {
    // The empty-variable disaster: `rm -rf $PREFIX/` with `PREFIX` unset has
    // taken whole home directories. What it removes cannot be shown here.
    const found = inside('rm -rf $BUILD_DIR')
    expect(found[0]?.severity).toBe('warning')
    expect(found[0]?.title).toBe('Deletes a target that cannot be read before it runs')
  })

  it('stays quiet about a glob inside the workspace when nothing is forced', () => {
    expect(inside('rm dist/old.txt')).toEqual([])
  })
})

describe('what a hazard costs a prompt', () => {
  const workspace = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'hazards-'))

  it('refuses to offer a grant for a destructive line', async () => {
    // A line worth warning about is a line worth asking about every time:
    // remembering it turns one deliberate answer into a standing one.
    const description = await describeMutation(await workspace(), 'run_command', {
      command: 'rm -rf ~/Documents',
    })
    expect(description?.rules).toEqual([])
    expect(description?.hazards[0]?.severity).toBe('critical')
  })

  it('still offers the ordinary widths when nothing was recognised', async () => {
    const description = await describeMutation(await workspace(), 'run_command', {
      command: 'git diff --stat',
    })
    expect(description?.hazards).toEqual([])
    expect(description?.rules).toHaveLength(2)
  })

  it('says when a filesystem tool asked to leave the workspace', async () => {
    // These tools refuse to leave, so the call will fail — but the model asked
    // to reach outside the project, and the user should know that.
    const description = await describeMutation(await workspace(), 'delete_path', {
      path: '/etc/hosts',
    })
    expect(description?.hazards[0]?.title).toBe('Points outside the workspace')
  })

  it('says when a recursive delete would take the whole workspace', async () => {
    const description = await describeMutation(await workspace(), 'delete_path', {
      path: '.',
      recursive: true,
    })
    expect(description?.hazards.map(hazard => hazard.title))
      .toContain('Deletes the whole workspace')
  })
})
