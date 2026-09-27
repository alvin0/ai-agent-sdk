/**
 * The one owner of a step's tool-call budget.
 *
 * Every dispatch in a step — a model-issued call or a call a program makes on
 * the model's behalf — reserves here before authorization and confirms only
 * when its body actually starts. A second counter anywhere else is how a nested
 * caller ends up running ten bodies against a budget of three.
 */
export interface ToolAdmission {
  /**
   * Reserve room for one call about to be authorized.
   * @param exempt - Whether the tool is `budgetExempt`; exempt calls never spend budget.
   * @returns A ticket, or `undefined` when the budget declines the call.
   */
  reserve(exempt: boolean): AdmissionTicket | undefined
  /** Dispatched calls that spent budget; exempt tools are excluded. */
  readonly budgeted: number
}

/** One reservation. Exactly one of `confirm` or `release` takes effect. */
export interface AdmissionTicket {
  /** Whether confirming this ticket spends budget. */
  readonly budgeted: boolean
  /** The body is starting: the reservation becomes spent budget. */
  confirm(): void
  /** The call will not run: return the reservation. */
  release(): void
}

/**
 * @param limit - Budgeted dispatches this step may still make, or `unbounded`
 *   when the budget is a notice rather than a wall.
 * @returns A fresh admission for one step.
 */
export function createToolAdmission(limit: number | 'unbounded'): ToolAdmission {
  const ceiling = limit === 'unbounded' ? Number.POSITIVE_INFINITY : Math.max(0, limit)
  let spent = 0
  let reserved = 0
  return {
    reserve(exempt) {
      if (!exempt && spent + reserved >= ceiling) return undefined
      if (!exempt) reserved++
      let settled = false
      return {
        budgeted: !exempt,
        confirm() {
          if (settled) return
          settled = true
          if (!exempt) { reserved--; spent++ }
        },
        release() {
          if (settled) return
          settled = true
          if (!exempt) reserved--
        },
      }
    },
    get budgeted() { return spent },
  }
}
