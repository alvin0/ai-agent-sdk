/** Shared terminal styling for the human harness. */

import { stdout } from 'node:process'

const colors = process.env.NO_COLOR === undefined && stdout.isTTY

export function paint(code: number, text: string): string {
  return colors ? `\u001b[${code}m${text}\u001b[0m` : text
}

export function label(text: string): string {
  return paint(36, `[${text}]`)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
