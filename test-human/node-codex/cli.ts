#!/usr/bin/env node
import { nodeCodexHelp, parseNodeCodexArgs } from './config.ts'
import { runNodeCodexAcceptance } from './runtime.ts'

async function main(): Promise<void> {
  const config = parseNodeCodexArgs(process.argv.slice(2))
  if (config.help) { process.stdout.write(`${nodeCodexHelp()}\n`); return }
  if (config.dryRun) {
    process.stdout.write(`Node Codex harness plan\n  cases: ${config.repeat}\n  parallel: ${config.parallel}\n  results: ${config.resultsRoot}\n`)
    return
  }
  const queue = Array.from({ length: config.repeat }, (_, index) => index + 1)
  const results: Awaited<ReturnType<typeof runNodeCodexAcceptance>>[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(config.parallel, queue.length) }, async () => {
    while (true) {
      const caseNumber = queue[cursor++]
      if (caseNumber === undefined) return
      const runId = config.repeat === 1 ? config.runId : `${config.runId}-r${caseNumber}`
      process.stdout.write(`\n╭─ Node Codex · ${runId}\n`)
      const result = await runNodeCodexAcceptance({
        runId,
        resultsRoot: config.resultsRoot,
        onEvent(event) {
          if (event.type === 'commentary-delta') process.stdout.write(event.text)
          else if (event.type === 'tool-call') process.stdout.write(`\n  → ${event.name}\n`)
          else if (event.type === 'tool-result') process.stdout.write(`  ← ${event.name} ${event.status}\n`)
          else if (event.type === 'assistant-native-tool') process.stdout.write(`  ◇ ${event.name} ${event.status}\n`)
        },
      })
      results.push(result)
      process.stdout.write(`\n${result.text}\n`)
      process.stdout.write(`╰─ ${result.status} · ${result.metrics.reportedTokens} tokens · ${result.artifact}\n`)
    }
  }))
  const failed = results.filter(result => result.status !== 'passed')
  process.stdout.write(`\nNode Codex summary: ${results.length - failed.length}/${results.length} passed\n`)
  if (failed.length > 0) process.exitCode = 1
}

void main().catch(error => {
  process.stderr.write(`Node Codex harness failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
