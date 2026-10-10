import type { Hazard } from '../hazards'
import type { ToolCard } from '../wire'

/** One breadth a session or workspace grant can be given at. */
export interface RuleChoice {
  /** The stored grant key, e.g. `run_command:prefix:git diff`. */
  readonly key: string
  /** What that key covers, in words. */
  readonly label: string
}

/** A pending mutating call, in the words a permission prompt needs. */
export interface MutationDescription {
  /** Short action title, e.g. "Run command". */
  readonly title: string
  /** One line saying what will happen. */
  readonly summary: string
  /**
   * The breadths offered on the prompt, NARROWEST FIRST — `git diff *` before
   * `git *`, this directory before every file. The first is the default, so a
   * distracted "allow for this project" grants the smallest useful family.
   *
   * Empty means no grant is offered at all and the call can only be permitted
   * once: a command line whose shape cannot be reasoned about, or an
   * executable that must never be signed away wholesale.
   */
  readonly rules: readonly RuleChoice[]
  /**
   * Every key that covers this call — a superset of {@link rules}, because a
   * key can be honoured without ever being suggested: a broader prefix stored
   * earlier, a legacy key, or a grant added through the permissions API for an
   * executable this module refuses to put on a chip.
   */
  readonly matchKeys: readonly string[]
  /**
   * What the call would destroy, when it is recognisably destructive — most
   * severe first, empty when nothing was recognised (which is not a claim that
   * the call is safe). A call with any hazard offers no `rules`: it is answered
   * once, deliberately, or not at all.
   */
  readonly hazards: readonly Hazard[]
  /** Preview of the change, when one can be computed without making it. */
  readonly card?: ToolCard
}
