#!/usr/bin/env node
import { errorMessage, label, paint } from '../console.ts'
import { parseStructuredOutputArgs, structuredOutputHelp } from './config.ts'
import {
  runStructuredOutputAcceptance,
  type FinalPayload,
  type StructuredOutputProgressEvent,
} from './runner.ts'

async function main(): Promise<void> {
  let config
  try { config = parseStructuredOutputArgs(process.argv.slice(2)) }
  catch (error: unknown) {
    process.stderr.write(`${paint(31, errorMessage(error))}\n\n${structuredOutputHelp()}\n`)
    process.exitCode = 2
    return
  }
  if (config.help) {
    process.stdout.write(`${structuredOutputHelp()}\n`)
    return
  }

  process.stdout.write(`\n${paint(36, 'Structured-output provider walkthrough')}\n`)
  process.stdout.write(`Provider: ${config.provider}\n`)
  process.stdout.write(`Model: ${config.model}\n`)
  process.stdout.write('Goal: review release readiness through tools, then return one schema-constrained JSON decision.\n')

  const result = await runStructuredOutputAcceptance(config, { onProgress: renderProgress })
  const passed = result.scenarios.filter(scenario => scenario.status === 'passed').length
  process.stdout.write(`\n${label('result')} ${paint(result.status === 'passed' ? 32 : 31,
    `${passed}/${result.scenarios.length} processes passed`)}\n`)
  process.stdout.write(`${label('evidence')} ${result.artifact}\n`)

  if (config.verbose || result.status === 'failed') renderDiagnostics(result.scenarios)
  if (result.status === 'failed') process.exitCode = 1
}

function renderProgress(event: StructuredOutputProgressEvent): void {
  if (event.type === 'scenario-start') {
    const name = event.id === 'short' ? 'SHORT PROCESS' : 'LONG PROCESS'
    process.stdout.write(`\n╭─ ${paint(36, name)} · ${event.checks} release ${event.checks === 1 ? 'check' : 'checks'}\n`)
    process.stdout.write('│ The model gathers host-owned evidence before it is allowed to produce final JSON.\n│\n')
    return
  }
  if (event.type === 'tool-call') {
    process.stdout.write(`│ Step ${event.step}/${event.total} → inspect_release_check({ step: ${event.step} })\n`)
    return
  }
  if (event.type === 'tool-result') {
    process.stdout.write(`│   Host evidence: ${event.check.label} — ${paint(32, event.check.status.toUpperCase())}\n`)
    return
  }
  if (event.type === 'final-output') {
    const processReasons = event.finishReasons.slice(0, -1).join(' → ')
    process.stdout.write('│\n')
    process.stdout.write(`│ Process phase: ${processReasons}\n`)
    process.stdout.write('│ Final phase: tools disabled → json_schema → stop\n')
    process.stdout.write('│\n│ Final JSON returned to the user:\n')
    renderJson(event.payload)
    return
  }
  const color = event.result.status === 'passed' ? 32 : 31
  process.stdout.write(`╰─ ${paint(color, event.result.status.toUpperCase())}`
    + ` · ${event.result.toolExecutions}/${event.result.expectedChecks} checks`
    + ` · ${event.result.modelCalls} model calls\n`)
}

function renderJson(payload: FinalPayload | undefined): void {
  const text = payload === undefined ? '(invalid or missing JSON)' : JSON.stringify(payload, null, 2)
  for (const line of text.split('\n')) process.stdout.write(`│   ${line}\n`)
}

function renderDiagnostics(scenarios: readonly {
  readonly id: string
  readonly invariants: readonly {
    readonly name: string
    readonly passed: boolean
    readonly detail?: string
  }[]
}[]): void {
  process.stdout.write(`\n${label('diagnostics')}\n`)
  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.id}:\n`)
    for (const invariant of scenario.invariants) {
      process.stdout.write(`    ${invariant.passed ? '✓' : '✗'} ${invariant.name}`
        + `${invariant.detail === undefined ? '' : ` (${invariant.detail})`}\n`)
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${label('structured-output/error')} ${paint(31, errorMessage(error))}\n`)
  process.exitCode = 1
})
