/**
 * How much of a tool's output the model is allowed to read.
 *
 * A tool result enters the model's context unchanged, so one `cat` of a
 * generated bundle can spend a context window that the turn then has no way to
 * recover — the provider rejects the next request, and everything already paid
 * for is lost. Both reference harnesses stop this at the RESULT boundary rather
 * than waiting for the request to be assembled, and they differ only in where
 * the removed text goes:
 *
 * - **Codex** truncates the middle to a token budget and tells the model how
 *   much was dropped (`truncate_middle_with_token_budget`). Cheap and needs no
 *   storage; the model recovers by re-running a narrower command.
 * - **The DeepSeek harness** spills the full text to a store, and hands the
 *   model a bounded preview plus a locator to read or search (`dsh-spill`).
 *   Nothing is lost, but it needs somewhere to put the text.
 *
 * Both are offered here. `auto` — the default — takes the second when a store
 * is mounted and the first when none is, so the cheap path works everywhere and
 * the lossless one turns itself on the moment it can.
 *
 * @module ai-agent-sdk/agent/tool/output-budget
 */

export type {
  ToolOutputOverflowPolicy, SpillRecord, SpillSlice, SpillStore, MemorySpillStoreLimits
} from './output-budget/types.ts'
export { createMemorySpillStore } from './output-budget/memory-store.ts'
export type { TruncatedText } from './output-budget/token-budget.ts'
export {
  estimateTextTokens, estimateTextBlockTokens, truncateMiddleToTokens, previewForSpill
} from './output-budget/token-budget.ts'
export { SPILL_TOOL_NAME, readSpillTool } from './output-budget/read-tool.ts'
