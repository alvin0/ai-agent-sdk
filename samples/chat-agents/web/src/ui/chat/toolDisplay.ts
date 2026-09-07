/**
 * When a tool row shows its work.
 *
 * Kept out of the component because the bug this answers was never in the DOM:
 * the row rendered correctly and simply decided, wrongly, that there was
 * nothing to show. The two decisions below are the whole of it, so they are
 * separated to be checkable on their own — this repo has no DOM test setup,
 * and a rule nobody can test is a rule that quietly regresses.
 */

/** Just enough of a tool node to decide how it is displayed. */
export interface ToolDisplayState {
  readonly name: string
  readonly state: 'running' | 'ok' | 'error'
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
