import { CAPABILITY_RANK, type ExecCapability, type ExecOutcome, type ExecClassification } from './exec-types.ts'
import { stripWrappers, basename } from './exec-shell.ts'

/** Commands that only report state. */
export const OBSERVE = new Set([
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
export const USE = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'vitest', 'jest',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'ruby', 'bundle', 'go', 'cargo',
  'rustc', 'java', 'mvn', 'gradle', 'make', 'cmake', 'git', 'docker', 'kubectl',
  'terraform', 'gh', 'curl', 'wget', 'jq',
])

/** Commands that change files. */
export const MODIFY = new Set([
  'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp',
  'truncate', 'dd', 'tee', 'install', 'patch', 'tar', 'unzip', 'zip',
])

/** Commands that start, stop or signal running services. */
export const SERVICE_CONTROL = new Set([
  'systemctl', 'service', 'launchctl', 'initctl', 'kill', 'killall', 'pkill',
  'supervisorctl', 'brew', 'nginx', 'apachectl', 'pm2',
])

/** Commands that install software. */
export const PACKAGE_INSTALL = new Set([
  'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'rpm', 'pacman', 'apk', 'snap', 'port',
])

/** Commands that run as another, more powerful, identity. */
export const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'pkexec', 'runas'])

/** Commands whose effect cannot be undone from inside a session. */
export const CRITICAL = new Set([
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
export const CREDENTIAL_TOOLS = new Set([
  'aws', 'gcloud', 'az', 'doctl', 'heroku', 'op', 'vault', 'pass', 'keyring',
  'security', 'gpg', 'ssh-add', 'ssh-agent', 'kubelogin', 'aws-vault',
])

/** Subcommands of those tools that only report non-secret state. */
export const CREDENTIAL_TOOL_SAFE_VERBS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  // Even "list" prints an account identity, so nothing here is safe by default;
  // the map exists so a deployment can widen it deliberately rather than by
  // the classifier guessing.
})

/** Paths whose contents authorize something, wherever they are read from. */
export const CREDENTIAL_PATTERN =
  new RegExp(
    String.raw`(^|/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker/config\.json|\.npmrc|\.netrc|\.git-credentials|`
    + String.raw`credentials|id_[a-z0-9]+|.*\.pem|.*\.key|\.env(\.[a-z]+)?)(/|$)`,
    'i',
  )

/** Paths whose modification changes who may do what on the machine. */
export const CRITICAL_PATH_PATTERN =
  /(^|\/)(etc\/(sudoers|shadow|passwd|ssh\/sshd_config|pam\.d)|boot|sys\/kernel|proc\/sys)(\/|$)/i

/** Build a classification with its outcome resolved. */
export function decide(
  capability: ExecCapability, program: string, reason: string,
  decision: { parts: readonly ExecClassification[]; outcomes: Readonly<Record<ExecCapability, ExecOutcome>> },
): ExecClassification {
  const { parts, outcomes } = decision
  return Object.freeze({
    capability, outcome: outcomes[capability], program, reason, parts: Object.freeze(parts),
  })
}

/** Classify a single command that contains no further commands. */
export function classifySingle(
  argv: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  const redirect = classifyRedirection(argv, outcomes)
  if (redirect !== undefined) return redirect
  const stripped = stripWrappers(argv)
  const program = basename(stripped[0] ?? '')
  const args = stripped.slice(1)
  if (program === '') return decide('unknown', '(empty)', 'no program named', { parts: [], outcomes: outcomes })

  const touched = args.filter(argument => !argument.startsWith('-'))
  const path = classifyPaths(program, touched, outcomes)
  if (path !== undefined) return path
  const effect = classifyEffects(program, args, touched, outcomes)
  if (effect !== undefined) return effect

  const risk = classifyRisk(program, touched, outcomes)
  if (risk !== undefined) return risk

  return classifyProgram(program, args, outcomes)
}

/**
 * Where a program puts the verb. `systemctl restart nginx` names the action
 * first; `service nginx restart` names the unit first, and reading position 0
 * for both makes every `service` invocation look like a control action.
 */
export const VERB_POSITION: Readonly<Record<string, number>> = Object.freeze({
  service: 1, systemctl: 0, launchctl: 0, initctl: 0, supervisorctl: 0, brew: 0, pm2: 0,
})

/** Flags that turn a reading tool into a writing one. */
export const IN_PLACE_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sed: ['-i', '--in-place'],
  perl: ['-i'],
  awk: ['-i', '--in-place'],
  ruby: ['-i'],
})

/** Paths whose wholesale removal is not something a session can undo. */
export const ROOTISH = new Set(['/', '/*', '/etc', '/usr', '/bin', '/sbin', '/var', '/boot', '/System', '/Library'])

/** Verbs that only report a service's state. */
export const SERVICE_READ_VERBS = new Set(['status', 'show', 'list', 'list-units', 'is-active',
  'is-enabled', 'cat', 'get', 'services', 'print', 'info', 'ls', 'config', 'list-unit-files'])

/**
 * Separate observing a service from controlling one — the distinction the file
 * seam cannot make, and the reason this module exists.
 */
export function classifyServiceCommand(
  program: string, args: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  const positional = args.filter(argument => !argument.startsWith('-'))
  const verb = positional[VERB_POSITION[program] ?? 0]
  if (verb === undefined) {
    // No action named: `systemctl`, `systemctl --failed`, `launchctl` alone all
    // list units. A real model reaches for exactly these when asked what is
    // broken, and reading them as control actions asks for approval to look.
    return decide('observe', program, 'lists services without naming an action', { parts: [], outcomes: outcomes })
  }
  if (SERVICE_READ_VERBS.has(verb)) {
    return decide('observe', program, `reports service state (${verb})`, { parts: [], outcomes: outcomes })
  }
  if (program === 'nginx' && args.includes('-t')) {
    return decide('observe', program, 'checks configuration without applying it', { parts: [], outcomes: outcomes })
  }
  return decide('service-control', program, `changes a running service (${verb})`, { parts: [], outcomes: outcomes })
}

/** Tool subcommands that install outside the workspace or raise privilege. */
export function classifyToolCommand(
  program: string, args: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  const global = args.includes('-g') || args.includes('--global') || args.includes('--location=global')
  if (global && (program === 'npm' || program === 'pnpm' || program === 'yarn')) {
    return decide('package-install', program, 'installs outside the workspace', { parts: [], outcomes: outcomes })
  }
  if (program === 'docker' && args.some(argument => argument === 'run' || argument === 'exec')) {
    // A container can be given the host; the file seam never sees inside it.
    return decide('service-control', program, 'starts or enters a container', { parts: [], outcomes: outcomes })
  }
  return decide('use', program, 'project tooling, scoped by the file policy', { parts: [], outcomes: outcomes })
}

function classifyRedirection(
  argv: readonly string[], outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification | undefined {
  // Redirection is not a command, so splitting on command separators never
  // finds it — yet `echo x > file` writes a file while naming only `echo`.
  const redirect = argv.findIndex(token => token === '>' || token === '>>')
  if (redirect >= 0) {
    const target = argv[redirect + 1] ?? ''
    const inner = classifySingle(argv.slice(0, redirect), outcomes)
    const written = classifySingle(['tee', target], outcomes)
    return CAPABILITY_RANK[written.capability] > CAPABILITY_RANK[inner.capability]
      ? decide(written.capability, inner.program, `redirects output into ${target}`, { parts: [], outcomes: outcomes })
      : decide(inner.capability, inner.program, inner.reason, { parts: [], outcomes: outcomes })
  }
  return undefined
}

function classifyPaths(
  program: string, touched: readonly string[], outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification | undefined {
  // A path decides before the program does: reading a private key is reading a
  // private key whether `cat` or `grep` does it.
  const credential = touched.find(argument => CREDENTIAL_PATTERN.test(argument))
  if (credential !== undefined) {
    return decide('credential', program, `names a credential path: ${credential}`, { parts: [], outcomes: outcomes })
  }
  const critical = touched.find(argument => CRITICAL_PATH_PATTERN.test(argument))
  if (critical !== undefined) {
    return decide('critical', program, `names a path that governs access: ${critical}`,
      { parts: [], outcomes: outcomes })
  }

  return undefined
}

function classifyEffects(
  program: string, args: readonly string[], touched: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification | undefined {
  // A flag can turn a reading tool into a writing one, and the program name
  // alone then reads as harmless: `sed -i` edits the file it is pointed at.
  const inPlace = IN_PLACE_FLAGS[program]
  if (inPlace !== undefined && hasInPlaceFlag(args, inPlace)) {
    return decide('modify', program, 'edits its input in place', { parts: [], outcomes: outcomes })
  }
  if (program === 'find' && args.some(argument =>
    argument === '-delete' || argument === '-exec' || argument === '-execdir'
    || argument === '-ok' || argument === '-okdir')) {
    return decide('modify', program, 'runs an action that may change files', { parts: [], outcomes: outcomes })
  }
  if (program === 'awk' && args.some(argument => /(^|[^A-Za-z_])system\s*\(/.test(argument))) {
    return decide('unknown', program, 'evaluates another command dynamically', { parts: [], outcomes: outcomes })
  }
  if (program === 'rm' && touched.some(argument => ROOTISH.has(argument.replace(/\/+$/, '') || '/'))) {
    return decide('critical', program, `removes a system root: ${touched.join(' ')}`, { parts: [], outcomes: outcomes })
  }

  return undefined
}

function classifyRisk(
  program: string, touched: readonly string[], outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification | undefined {
  if (CREDENTIAL_TOOLS.has(program)) {
    const verb = touched[0] ?? ''
    if (!(CREDENTIAL_TOOL_SAFE_VERBS[program]?.has(verb) ?? false)) {
      return decide('credential', program,
        `reads a credential the command never names${verb === '' ? '' : ` (${verb})`}`,
      { parts: [], outcomes: outcomes })
    }
  }
  if (PRIVILEGE.has(program)) {
    return decide('privilege', program, 'runs as another identity', { parts: [], outcomes: outcomes })
  }
  if (CRITICAL.has(program)) {
    return decide('critical', program, 'changes the machine in a way a session cannot undo',
      { parts: [], outcomes: outcomes })
  }
  if (PACKAGE_INSTALL.has(program)) {
    return decide('package-install', program, 'installs software', { parts: [], outcomes: outcomes })
  }
  return undefined
}

function hasInPlaceFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some(argument => flags.some(flag => argument === flag || argument.startsWith(`${flag}`) && flag === '-i'))
}

function classifyProgram(
  program: string, args: readonly string[], outcomes: Readonly<Record<ExecCapability, ExecOutcome>>,
): ExecClassification {
  if (SERVICE_CONTROL.has(program)) return classifyServiceCommand(program, args, outcomes)
  if (MODIFY.has(program)) return decide('modify', program, 'changes files', { parts: [], outcomes: outcomes })
  if (USE.has(program)) return classifyToolCommand(program, args, outcomes)
  // `command -v foo` and `[ -f x ]` are tests, not the thing being tested.
  if (program === 'command' || program === '[' || program === 'test' || program === '[[') {
    return decide('observe', program, 'tests for something without running it', { parts: [], outcomes: outcomes })
  }
  if (OBSERVE.has(program)) return decide('observe', program, 'reports state without changing it',
      { parts: [], outcomes: outcomes })

  return decide('unknown', program, 'not a command this policy recognises', { parts: [], outcomes: outcomes })
}
