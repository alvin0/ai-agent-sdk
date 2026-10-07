import type { ToolCallRequest } from '../../tool/pipeline.ts'

export function repeatKey(call: ToolCallRequest): string {
  // This is a heuristic guard, not a semantic JSON comparator. Keeping the
  // provider's bounded raw arguments avoids recursively normalizing a deeply
  // nested payload and turning repeat detection into a stack-exhaustion vector.
  return `${call.toolName}:${jsonTextFingerprint(call.rawArguments.trim())}`
}
export function toolActionPattern(calls: readonly ToolCallRequest[]): string {
  return calls.map(call => repeatKey(call)).join('|')
}
export function repeatedSuffixCycle(
  steps: readonly string[],
  maxPeriod: number,
): { readonly period: number; readonly repetitions: number } | undefined {
  const maximum = Math.min(maxPeriod, Math.floor(steps.length / 2))
  let best: { readonly period: number; readonly repetitions: number } | undefined
  for (let period = 1; period <= maximum; period++) {
    const repetitions = suffixRepetitions(steps, period)
    if (repetitions >= 2 && (best === undefined || repetitions > best.repetitions)) {
      best = { period, repetitions }
    }
  }
  return best
}

function suffixRepetitions(steps: readonly string[], period: number): number {
  let repetitions = 1
  while ((repetitions + 1) * period <= steps.length) {
    const rightStart = steps.length - period
    const leftStart = rightStart - repetitions * period
    if (!sameSlice(steps, leftStart, rightStart, period)) break
    repetitions++
  }
  return repetitions
}

function sameSlice(steps: readonly string[], left: number, right: number, length: number): boolean {
  for (let offset = 0; offset < length; offset++) {
    if (steps[left + offset] !== steps[right + offset]) return false
  }
  return true
}
export function jsonTextFingerprint(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  let length = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (!quoted && (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)) continue
    length++
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ (code + length), 0x85ebca6b)
    const state = quoteState(code, quoted, escaped)
    quoted = state.quoted
    escaped = state.escaped
  }
  return `${length.toString(36)}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`
}

function quoteState(code: number, quoted: boolean, escaped: boolean): { quoted: boolean; escaped: boolean } {
  if (!quoted) return { quoted: code === 0x22, escaped: false }
  if (escaped) return { quoted: true, escaped: false }
  if (code === 0x5c) return { quoted: true, escaped: true }
  return { quoted: code !== 0x22, escaped: false }
}
