/**
 * When a tool row shows its work.
 *
 * Kept out of the component because the bug this answers was never in the DOM:
 * the row rendered correctly and simply decided, wrongly, that there was
 * nothing to show. The two decisions below are the whole of it, so they are
 * separated to be checkable on their own — this repo has no DOM test setup,
 * and a rule nobody can test is a rule that quietly regresses.
 */

/**
 * Shortest run of settled tool calls worth folding into one row.
 *
 * Two rows are not a wall; they are two rows, and hiding them behind a summary
 * costs a click to learn less than the rows already said.
 */
export const TOOL_GROUP_MIN = 3

/**
 * The one line a folded run of tool calls shows.
 *
 * Names the tools rather than counting anonymous "steps": "Fetch, Run · 9
 * steps" tells the reader whether the run is worth opening, which is the only
 * question a folded row has to answer.
 * @param titles - Display titles of the calls, in order.
 * @returns The summary line.
 */
export function toolGroupSummary(titles: readonly string[]): string {
  const distinct = [...new Set(titles)]
  const shown = distinct.slice(0, 3).join(', ')
  const rest = distinct.length - 3
  const names = rest > 0 ? `${shown} +${String(rest)} more` : shown
  return `${names} · ${String(titles.length)} steps`
}

/** Just enough of a tool node to decide how it is displayed. */
export interface ToolDisplayState {
  readonly name: string
  readonly state: 'running' | 'ok' | 'error' | 'declined'
  readonly liveOutput?: string
}

/**
 * Whether a row starts expanded before anyone touches it.
 *
 * A shell call does. Its output IS its result — a build log, a test run, a
 * stack trace — and a collapsed row reduces that to a chevron: the user is
 * asked to click to discover whether their build passed. Every other tool has
 * a one-line summary that already says what happened, so those stay collapsed
 * and the transcript stays readable.
 * @param name - The tool's name.
 * @returns True when the row opens itself.
 */
export function opensByDefault(name: string): boolean {
  return name === 'run_command'
}

/**
 * Whether to draw the live terminal view rather than the settled result.
 *
 * A running command qualifies from its first MOMENT, not its first byte. This
 * used to require output to already exist, which broke at both ends: `npm
 * install` prints nothing for half a minute, so the row sat blank through
 * exactly the wait the live view exists for; and a command that finished in a
 * single burst went from no output to a settled result without ever passing
 * through a state that rendered live.
 * @param node - The tool row's state.
 * @returns True while the live view should be drawn.
 */
export function showsLiveOutput(node: ToolDisplayState): boolean {
  if (node.state !== 'running') return false
  return node.name === 'run_command' || (node.liveOutput ?? '') !== ''
}

/** Tools whose calls are visits to the open web. */
export const WEB_TOOLS: ReadonlySet<string> = new Set(['fetch_url'])

/** One site a run of web calls reached, or tried to. */
export interface WebVisit {
  /** Hostname as the site spells it, `www.` included. */
  readonly host: string
  /** First URL seen for this host, for the title attribute. */
  readonly url: string
  /** Every call to this host failed. */
  readonly failed: boolean
  /** How many calls went to it. */
  readonly count: number
}

/** Just enough of a tool node to place it on the source rail. */
export interface WebCallState {
  readonly name: string
  readonly state: 'running' | 'ok' | 'error' | 'declined'
  readonly args: string
  readonly card?: { readonly kind: string; readonly url?: string }
}

/**
 * The URL one web call was aimed at.
 *
 * The settled card carries the URL AFTER redirects, which is the one worth
 * showing. A call that failed has no card, so its target is read back out of
 * the arguments — the row would otherwise vanish from the rail, and a research
 * run whose failures are invisible reads as one that found everything.
 * @param node - The call.
 * @returns The URL, or undefined when neither source has one.
 */
function webUrlOf(node: WebCallState): string | undefined {
  if (node.card?.kind === 'web' && typeof node.card.url === 'string') return node.card.url
  try {
    const parsed = JSON.parse(node.args) as { url?: unknown }
    return typeof parsed.url === 'string' ? parsed.url : undefined
  } catch {
    return undefined
  }
}

/**
 * Fold a run of web calls into one entry per site.
 *
 * Eight rows of full URLs and their error strings is what the transcript used
 * to draw for one research step. A reader does not need the query string of a
 * 404; they need to know which sources were consulted, which is a short list of
 * hostnames however many times each was hit.
 * @param nodes - The run's calls, in order.
 * @returns One visit per host, in the order each host was first reached.
 */
export function webVisitsOf(nodes: readonly WebCallState[]): readonly WebVisit[] {
  const byHost = new Map<string, { url: string; failures: number; count: number }>()
  for (const node of nodes) {
    const url = webUrlOf(node)
    if (url === undefined) continue
    let host: string
    try { host = new URL(url).hostname } catch { continue }
    if (host === '') continue
    const current = byHost.get(host) ?? { url, failures: 0, count: 0 }
    current.count += 1
    if (node.state === 'error') current.failures += 1
    byHost.set(host, current)
  }
  return [...byHost].map(([host, entry]) => ({
    host,
    url: entry.url,
    failed: entry.failures === entry.count,
    count: entry.count,
  }))
}

/**
 * The one line a folded run of web calls shows.
 * @param pages - How many calls the run made.
 * @param sites - How many distinct hosts they reached.
 * @returns The summary line.
 */
export function webGroupSummary(pages: number, sites: number): string {
  const noun = sites === 1 ? 'site' : 'sites'
  return pages === sites
    ? `Read ${String(pages)} ${sites === 1 ? 'page' : 'pages'}`
    : `Read ${String(pages)} pages from ${String(sites)} ${noun}`
}

/**
 * The one line a tool call is recognised by: what it acted on.
 *
 * The tool's NAME says what kind of thing happened; this says which thing —
 * the file that was read, the query that was searched, the command that ran.
 * Both the transcript's tool rows and the trace's tool steps ask that same
 * question, so the answer lives here rather than in either component.
 *
 * Takes the arguments either as the raw JSON the model produced or already
 * parsed, because the transcript keeps the string and a trace span keeps the
 * value. Anything unparseable is cut to a length that fits a row.
 * @param name - The tool's name.
 * @param args - The call's arguments, raw or parsed.
 * @returns The summary, or an empty string when the call took no arguments.
 */
export function toolSummary(name: string, args: unknown): string {
  const parsed = typeof args === 'string' ? parseArgs(args) : args
  if (typeof parsed !== 'object' || parsed === null) {
    return typeof parsed === 'string' ? parsed.slice(0, 120) : ''
  }
  const fields = parsed as Record<string, unknown>
  // A control tool's arguments are a whole payload; summarise the part a
  // reader recognises rather than the raw JSON.
  if (name === 'request_user_input') {
    const questions = fields.questions
    const first = Array.isArray(questions) ? questions[0] as { question?: unknown } | undefined : undefined
    if (typeof first?.question === 'string') return first.question
  }
  if (name === 'submit_result' && typeof fields.summary === 'string') return fields.summary
  // The command line IS the summary of a shell call; its path arguments are not.
  if (name === 'run_command' && typeof fields.command === 'string') return fields.command
  if (name === 'move_path' && typeof fields.from === 'string' && typeof fields.to === 'string') {
    return `${fields.from} → ${fields.to}`
  }
  // A spawned worker is named by WHO it is, not by the paragraph it was given.
  if (typeof fields.name === 'string' && (name === 'spawn_agent' || name === 'send_message')) {
    return fields.name
  }

  // A search is its QUERY. Ranked above the path because a search of the
  // workspace root carries '.' as its path, and reporting that told the reader
  // where the search ran instead of what it looked for.
  if (typeof fields.query === 'string' && fields.query !== '') return fields.query

  // The workspace root reads better than the literal "." the model sends.
  if (typeof fields.path === 'string' && (fields.path === '.' || fields.path === './')) {
    return 'workspace root'
  }

  const first = fields.path ?? fields.url ?? fields.items
  if (typeof first === 'string') return first
  if (Array.isArray(first)) return `${String(first.length)} items`
  return Object.keys(fields).length === 0 ? '' : JSON.stringify(fields).slice(0, 120)
}

/** Parse arguments, keeping the raw text when the model sent something else. */
function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args) as unknown
  } catch {
    return args
  }
}
