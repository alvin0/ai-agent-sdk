import type { SignalDeskVerificationReport } from './contracts.ts'

export function formatSignalDeskVerificationSummary(report: SignalDeskVerificationReport): string {
  const passedChecks = report.checks.filter(check => check.passed).length
  const failed = report.checks.filter(check => check.required && !check.passed)
  const lines = [
    `Signal Desk verification: ${report.passed ? 'PASS' : 'FAIL'}`,
    `Checks: ${passedChecks}/${report.checks.length}`,
    `Changes: ${report.changes.modified.length} modified, ${report.changes.added.length} added, ${report.changes.deleted.length} deleted`,
    `Commands: ${report.commands.map(command => `${command.name}=${command.exitCode ?? 'spawn-error'}`).join(', ') || 'none'}`,
  ]
  if (failed.length > 0) {
    lines.push('Failures:')
    for (const item of failed) lines.push(`- ${item.id}: ${item.detail ?? item.name}`)
  }
  return lines.join('\n')
}
