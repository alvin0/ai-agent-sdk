/**
 * Reading a command for what it *does*, not just what it touches.
 *
 * The file seam cannot tell `systemctl status nginx` from `systemctl restart
 * nginx`: both are argv, neither writes a file the policy cares about, and one
 * observes while the other changes the machine. Deciding between them needs the
 * command read semantically, before any of it runs.
 *
 * This is a classifier, and a classifier is a guess. Two rules keep the guess
 * from becoming a hazard: a command it does not recognise is never allowed, and
 * a command that hides other commands — a shell string, a pipeline, a chain —
 * is classified by the riskiest thing inside it rather than by its wrapper.
 */

/** What a command does to the machine, in increasing order of consequence. */
export type ExecCapability =
  | 'observe'
  | 'use'
  | 'modify'
  | 'service-control'
  | 'package-install'
  | 'privilege'
  | 'credential'
  | 'critical'
  | 'unknown'

/** What a harness should do with a command carrying that capability. */
export type ExecOutcome = 'allow' | 'allow-scoped' | 'ask-approval' | 'deny'

/** One classified command, and why it was classified that way. */
export interface ExecClassification {
  readonly capability: ExecCapability
  readonly outcome: ExecOutcome
  /** The program the decision was made about, after unwrapping. */
  readonly program: string
  /** Why, in terms a person approving it can check. */
  readonly reason: string
  /** Every command found inside a shell string or chain, already classified. */
  readonly parts: readonly ExecClassification[]
}

/** The outcome each capability maps to, before a deployment adjusts it. */
export const DEFAULT_EXEC_OUTCOMES: Readonly<Record<ExecCapability, ExecOutcome>> = Object.freeze({
  observe: 'allow',
  use: 'allow-scoped',
  modify: 'ask-approval',
  'service-control': 'ask-approval',
  'package-install': 'ask-approval',
  privilege: 'ask-approval',
  credential: 'deny',
  critical: 'deny',
  // A command nobody recognised is not a safe command; it is an unread one.
  unknown: 'ask-approval',
})

/** Commands that only report state. */
const OBSERVE = new Set([
  'uname', 'uptime', 'hostname', 'date', 'whoami', 'id', 'df', 'du', 'free', 'vmstat',
  'top', 'ps', 'pgrep', 'lsof', 'ss', 'netstat', 'ifconfig', 'ip', 'arch', 'sw_vers',
  'sysctl', 'lscpu', 'lsblk', 'nproc', 'env', 'printenv', 'pwd', 'which', 'whereis',
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'ls', 'find', 'grep',
  'rg', 'awk', 'sed', 'sort', 'uniq', 'cut', 'diff', 'md5sum', 'sha256sum', 'journalctl',
  'dmesg', 'log', 'tree', 'readlink', 'realpath', 'basename', 'dirname', 'echo',
  // Added after running real model output through this classifier: these are
  // what a model reaches for when asked how a machine is doing, and leaving
  // them unrecognised turned "check CPU and RAM" into an approval prompt.
  'vm_stat', 'iostat', 'mpstat', 'sar', 'pmap', 'swapon', 'getconf', 'sysctl',
  'launchctl', 'pgrep', 'pidof', 'w', 'last', 'lsattr', 'mount', 'blkid',
])

/** Project tooling: runs inside a workspace and is scoped by the file policy. */
const USE = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'vitest', 'jest',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'ruby', 'bundle', 'go', 'cargo',
  'rustc', 'java', 'mvn', 'gradle', 'make', 'cmake', 'git', 'docker', 'kubectl',
  'terraform', 'gh', 'curl', 'wget', 'jq',
])

/** Commands that change files. */
const MODIFY = new Set([
  'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp',
  'truncate', 'dd', 'tee', 'install', 'patch', 'tar', 'unzip', 'zip',
])

/** Commands that start, stop or signal running services. */
const SERVICE_CONTROL = new Set([
  'systemctl', 'service', 'launchctl', 'initctl', 'kill', 'killall', 'pkill',
  'supervisorctl', 'brew', 'nginx', 'apachectl', 'pm2',
])

/** Commands that install software. */
const PACKAGE_INSTALL = new Set([
  'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'rpm', 'pacman', 'apk', 'snap', 'port',
])

/** Commands that run as another, more powerful, identity. */
const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'pkexec', 'runas'])

/** Commands whose effect cannot be undone from inside a session. */
const CRITICAL = new Set([
  'reboot', 'shutdown', 'halt', 'poweroff', 'mkfs', 'fdisk', 'parted',
  'iptables', 'nft', 'ufw', 'pfctl', 'usermod', 'useradd', 'userdel', 'passwd',
  'visudo', 'csrutil', 'spctl',
])

/**
 * Programs that read a credential without naming where it lives.
 *
 * Found by running real model output through this classifier: asked to show
 * AWS credentials, a model proposed `aws configure list` and `aws sts
 * get-caller-identity`. Neither names `~/.aws/credentials`, so a rule that
 * matches credential PATHS sees nothing — the secret is read inside the tool.
 * The program is the signal here, not its arguments.
 */
const CREDENTIAL_TOOLS = new Set([
  'aws', 'gcloud', 'az', 'doctl', 'heroku', 'op', 'vault', 'pass', 'keyring',
  'security', 'gpg', 'ssh-add', 'ssh-agent', 'kubelogin', 'aws-vault',
])

/** Subcommands of those tools that only report non-secret state. */
const CREDENTIAL_TOOL_SAFE_VERBS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  // Even "list" prints an account identity, so nothing here is safe by default;
  // the map exists so a deployment can widen it deliberately rather than by
  // the classifier guessing.
})

/** Shell keywords that lead a segment without being the command. */
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case',
  'esac', 'in', '{', '}', '(', ')', '!', 'time', 'exec', 'eval',
])

/** Paths whose contents authorize something, wherever they are read from. */
const CREDENTIAL_PATTERN =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker\/config\.json|\.npmrc|\.netrc|\.git-credentials|credentials|id_[a-z0-9]+|.*\.pem|.*\.key|\.env(\.[a-z]+)?)(\/|$)/i

/** Paths whose modification changes who may do what on the machine. */
const CRITICAL_PATH_PATTERN =
  /(^|\/)(etc\/(sudoers|shadow|passwd|ssh\/sshd_config|pam\.d)|boot|sys\/kernel|proc\/sys)(\/|$)/i

/** Tokens that separate one command from the next, wherever they appear. */
const SEPARATOR_PATTERN = /(^|[^\\])(&&|\|\||;|\|)/

/** Shells whose `-c` argument is another command entirely. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell'])

/** Wrappers that run another command without changing what it does. */
const TRANSPARENT = new Set(['env', 'nice', 'ionice', 'nohup', 'stdbuf', 'time', 'timeout', 'command'])

/**
 * Classify one command.
 * @param argv - the exact argv, program first. A shell string is read through.
 * @param outcomes - the capability-to-outcome mapping a deployment uses.
 */
export function classifyExec(
  argv: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>> = DEFAULT_EXEC_OUTCOMES,
): ExecClassification {
  const parts = splitCommands(argv).map(part => classifySingle(part, outcomes))
  if (parts.length === 0) {
    return decide('unknown', '(empty)', 'no command to classify', [], outcomes)
  }
  if (parts.length === 1) return parts[0] as ExecClassification

  // A chain is as consequential as its worst link; wrapping `rm -rf /etc` after
  // an `echo` must not make the pair look like an `echo`.
  const worst = parts.reduce((left, right) =>
    CAPABILITY_RANK[right.capability] > CAPABILITY_RANK[left.capability] ? right : left)
  return decide(
    worst.capability, worst.program,
    `a chain of ${String(parts.length)} commands, decided by its riskiest: ${worst.reason}`,
    parts, outcomes,
  )
}

/** Consequence order, used to pick the decisive command in a chain. */
const CAPABILITY_RANK: Readonly<Record<ExecCapability, number>> = Object.freeze({
  observe: 0, use: 1, unknown: 2, modify: 3, 'service-control': 4,
  'package-install': 5, privilege: 6, credential: 7, critical: 8,
})

/** Build a classification with its outcome resolved. */
function decide(
  capability: ExecCapability, program: string, reason: string,
  parts: readonly ExecClassification[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  return Object.freeze({
    capability, outcome: outcomes[capability], program, reason, parts: Object.freeze(parts),
  })
}

/** Classify a single command that contains no further commands. */
function classifySingle(
  argv: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  // Redirection is not a command, so splitting on command separators never
  // finds it — yet `echo x > file` writes a file while naming only `echo`.
  const redirect = argv.findIndex(token => token === '>' || token === '>>')
  if (redirect >= 0) {
    const target = argv[redirect + 1] ?? ''
    const inner = classifySingle(argv.slice(0, redirect), outcomes)
    const written = classifySingle(['tee', target], outcomes)
    return CAPABILITY_RANK[written.capability] > CAPABILITY_RANK[inner.capability]
      ? decide(written.capability, inner.program, `redirects output into ${target}`, [], outcomes)
      : decide(inner.capability, inner.program, inner.reason, [], outcomes)
  }
  const stripped = stripWrappers(argv)
  const program = basename(stripped[0] ?? '')
  const args = stripped.slice(1)
  if (program === '') return decide('unknown', '(empty)', 'no program named', [], outcomes)

  // A path decides before the program does: reading a private key is reading a
  // private key whether `cat` or `grep` does it.
  const touched = args.filter(argument => !argument.startsWith('-'))
  const credential = touched.find(argument => CREDENTIAL_PATTERN.test(argument))
  if (credential !== undefined) {
    return decide('credential', program, `names a credential path: ${credential}`, [], outcomes)
  }
  const critical = touched.find(argument => CRITICAL_PATH_PATTERN.test(argument))
  if (critical !== undefined) {
    return decide('critical', program, `names a path that governs access: ${critical}`, [], outcomes)
  }

  // A flag can turn a reading tool into a writing one, and the program name
  // alone then reads as harmless: `sed -i` edits the file it is pointed at.
  const inPlace = IN_PLACE_FLAGS[program]
  if (inPlace !== undefined && args.some(argument => inPlace.some(flag => argument === flag || argument.startsWith(`${flag}`) && flag === '-i'))) {
    return decide('modify', program, 'edits its input in place', [], outcomes)
  }
  if (program === 'rm' && touched.some(argument => ROOTISH.has(argument.replace(/\/+$/, '') || '/'))) {
    return decide('critical', program, `removes a system root: ${touched.join(' ')}`, [], outcomes)
  }

  if (CREDENTIAL_TOOLS.has(program)) {
    const verb = touched[0] ?? ''
    if (!(CREDENTIAL_TOOL_SAFE_VERBS[program]?.has(verb) ?? false)) {
      return decide('credential', program,
        `reads a credential the command never names${verb === '' ? '' : ` (${verb})`}`, [], outcomes)
    }
  }
  if (PRIVILEGE.has(program)) {
    return decide('privilege', program, 'runs as another identity', [], outcomes)
  }
  if (CRITICAL.has(program)) {
    return decide('critical', program, 'changes the machine in a way a session cannot undo', [], outcomes)
  }
  if (PACKAGE_INSTALL.has(program)) {
    return decide('package-install', program, 'installs software', [], outcomes)
  }
  if (SERVICE_CONTROL.has(program)) return classifyServiceCommand(program, args, outcomes)
  if (MODIFY.has(program)) return decide('modify', program, 'changes files', [], outcomes)
  if (USE.has(program)) return classifyToolCommand(program, args, outcomes)
  // `command -v foo` and `[ -f x ]` are tests, not the thing being tested.
  if (program === 'command' || program === '[' || program === 'test' || program === '[[') {
    return decide('observe', program, 'tests for something without running it', [], outcomes)
  }
  if (OBSERVE.has(program)) return decide('observe', program, 'reports state without changing it', [], outcomes)

  return decide('unknown', program, 'not a command this policy recognises', [], outcomes)
}

/**
 * Where a program puts the verb. `systemctl restart nginx` names the action
 * first; `service nginx restart` names the unit first, and reading position 0
 * for both makes every `service` invocation look like a control action.
 */
const VERB_POSITION: Readonly<Record<string, number>> = Object.freeze({
  service: 1, systemctl: 0, launchctl: 0, initctl: 0, supervisorctl: 0, brew: 0, pm2: 0,
})

/** Flags that turn a reading tool into a writing one. */
const IN_PLACE_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sed: ['-i', '--in-place'],
  perl: ['-i'],
  awk: ['-i', '--in-place'],
  ruby: ['-i'],
})

/** Paths whose wholesale removal is not something a session can undo. */
const ROOTISH = new Set(['/', '/*', '/etc', '/usr', '/bin', '/sbin', '/var', '/boot', '/System', '/Library'])

/** Verbs that only report a service's state. */
const SERVICE_READ_VERBS = new Set(['status', 'show', 'list', 'list-units', 'is-active',
  'is-enabled', 'cat', 'get', 'services', 'print', 'info', 'ls', 'config', 'list-unit-files'])

/**
 * Separate observing a service from controlling one — the distinction the file
 * seam cannot make, and the reason this module exists.
 */
function classifyServiceCommand(
  program: string, args: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  const positional = args.filter(argument => !argument.startsWith('-'))
  const verb = positional[VERB_POSITION[program] ?? 0]
  if (verb !== undefined && SERVICE_READ_VERBS.has(verb)) {
    return decide('observe', program, `reports service state (${verb})`, [], outcomes)
  }
  if (program === 'nginx' && args.includes('-t')) {
    return decide('observe', program, 'checks configuration without applying it', [], outcomes)
  }
  return decide('service-control', program,
    `changes a running service${verb === undefined ? '' : ` (${verb})`}`, [], outcomes)
}

/** Tool subcommands that install outside the workspace or raise privilege. */
function classifyToolCommand(
  program: string, args: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  const global = args.includes('-g') || args.includes('--global') || args.includes('--location=global')
  if (global && (program === 'npm' || program === 'pnpm' || program === 'yarn')) {
    return decide('package-install', program, 'installs outside the workspace', [], outcomes)
  }
  if (program === 'docker' && args.some(argument => argument === 'run' || argument === 'exec')) {
    // A container can be given the host; the file seam never sees inside it.
    return decide('service-control', program, 'starts or enters a container', [], outcomes)
  }
  return decide('use', program, 'project tooling, scoped by the file policy', [], outcomes)
}

/** Remove wrappers, shell keywords and leading assignments without losing meaning. */
function stripWrappers(argv: readonly string[]): readonly string[] {
  let current = [...argv]
  for (let guard = 0; guard < 8; guard++) {
    // Real shell output leads with keywords and braces: `then npm test` names
    // `then`, which is not a program and classifies as unrecognised, turning an
    // ordinary test run into an approval prompt.
    while (current.length > 0 && SHELL_KEYWORDS.has(current[0] ?? '')) current.shift()
    while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0] ?? '')) current.shift()
    const program = basename(current[0] ?? '')
    if (!TRANSPARENT.has(program)) break
    // `timeout 30 cmd` and `nice -n 5 cmd`: drop the wrapper and its own flags.
    current = current.slice(1)
    while (current.length > 0 && (current[0] ?? '').startsWith('-')) current.shift()
    if (program === 'timeout' && current.length > 0 && /^[0-9]/.test(current[0] ?? '')) current.shift()
  }
  return current
}

/**
 * Every command an argv actually runs.
 *
 * A shell invocation carries its real command in a string, and that string can
 * hold several. Splitting on the operators that separate commands is coarse —
 * it does not understand quoting — so it errs toward finding MORE commands,
 * which classifies toward more caution rather than less.
 */
export function splitCommands(argv: readonly string[]): readonly (readonly string[])[] {
  const stripped = stripWrappers(argv)
  const program = basename(stripped[0] ?? '')
  const flagIndex = stripped.findIndex(argument => argument === '-c' || argument === '-Command')

  let script: string | undefined
  if (SHELLS.has(program) && flagIndex >= 0) {
    script = stripped[flagIndex + 1]
  } else if (stripped.some(token => SEPARATOR_PATTERN.test(token))) {
    // An argv is not always one command. A model emits a whole command line,
    // and `if [ -f package.json ]; then npm test; fi` names `[` first — read as
    // one argv it looks like a test, while what it runs is the test suite.
    // Under-classifying is the direction that matters, so any argv carrying a
    // command separator is read as the script it is.
    script = stripped.join(' ')
  }
  if (script === undefined) return [stripped]
  return script
    .split(/&&|\|\||[;|]|\n|\bthen\b|\bdo\b|\bfi\b|\bdone\b/)
    .map(piece => piece.trim())
    .filter(piece => piece !== '')
    .map(piece => piece.split(/\s+/)
      // A segment can open with grouping punctuation glued to the program:
      // `(command -v lscpu` names `(command`, which is nothing.
      .map(token => token.replace(/^[({]+/, '').replace(/[)}]+$/, ''))
      .map(token => token.replace(/^["']|["']$/g, ''))
      .filter(token => token !== ''))
    .filter(piece => piece.length > 0)
}

/** The final path segment, so `/usr/bin/systemctl` decides like `systemctl`. */
function basename(value: string): string {
  const cleaned = value.replaceAll('\\', '/')
  return cleaned.slice(cleaned.lastIndexOf('/') + 1)
}
