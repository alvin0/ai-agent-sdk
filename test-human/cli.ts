#!/usr/bin/env node
/** Thin REPL/controller entry point for the human acceptance harness. */

import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { createUserInputBroker } from '@ai-agent-sdk/agent'
import { HumanArtifactRecorder } from './artifacts.ts'
import { createHumanAgent } from './agent.ts'
import {
  humanCliHelp,
  parseHumanCliArgs,
  resolveHumanModel,
  type HumanCliConfig,
} from './config.ts'
import { errorMessage, label, paint } from './console.ts'
import { createHumanModelRegistry } from './providers.ts'
import { scenarioUserMessage } from './scenarios.ts'
import { renderHumanRun } from './terminal.ts'
import { createHumanToolRegistry } from './tools.ts'

async function main(): Promise<void> {
  const config = parseConfig()
  if (config === undefined) return
  if (config.help) { console.log(humanCliHelp()); return }

  const model = modelFor(config)
  if (model === undefined) return
  const artifact = new HumanArtifactRecorder({
    harness: 'human', resultsRoot: `${config.resultsRoot ?? resolve('test-human/results')}/human`,
    ...(config.runId === undefined ? {} : { runId: config.runId }),
  })
  const artifactConfig = {
    provider: config.provider, model, mode: config.mode, scenario: config.scenario,
    effort: config.effort, maxTurns: config.maxTurns, logs: config.logs,
    forceTool: config.forceTool,
    ...(config.prompt === undefined ? {} : { prompt: config.prompt }),
    ...(config.image === undefined ? {} : { image: config.image }),
  }
  artifact.record('config', artifactConfig)
  printConfig(config, model)
  if (config.dryRun) {
    const summary = await artifact.finish({ status: 'dry-run', config: artifactConfig })
    console.log(label('artifact'), summary.artifact.directory)
    return
  }
  if (!validateScenario(config)) {
    await artifact.finish({
      status: 'failed', config: artifactConfig,
      invariants: [{ name: 'scenario configuration is valid', passed: false }],
    })
    return
  }

  const registry = createHumanModelRegistry(config)
  const tools = createHumanToolRegistry(process.cwd())
  const broker = createUserInputBroker()
  const session = createHumanAgent(config, model).createSession({ registry, tools, userInput: broker })
  const terminal = createInterface({ input: stdin, output: stdout })
  let active: AbortController | undefined
  let attachedImage = false
  const oneShot = config.prompt !== undefined
  let queuedPrompt = config.prompt
  let turns = 0
  let failedTurns = 0
  let aborted = false

  terminal.on('SIGINT', () => {
    if (active === undefined) { terminal.close(); return }
    active.abort(new Error('human interrupted the active turn'))
    aborted = true
    broker.abortAll()
    console.log('\n' + label('abort'), 'turn cancellation requested')
  })

  console.log(label('ready'), oneShot ? 'running one prompt' : 'type a prompt, or /quit')
  try {
    while (true) {
      const prompt = queuedPrompt ?? await terminal.question(paint(32, '\nyou> '))
      queuedPrompt = undefined
      const command = prompt.trim()
      if (command.length === 0) { if (oneShot) break; continue }
      if (command === '/quit' || command === '/exit') break
      if (command === '/new') {
        session.reset()
        attachedImage = false
        console.log(label('history'), 'started a new conversation')
        continue
      }
      if (command === '/history') {
        console.log(label('history'), session.history.entries().map(entry => ({
          seq: entry.seq, kind: entry.event.kind,
        })))
        continue
      }
      if (command === '/memory') {
        console.log(label('memory'), session.memory.items())
        continue
      }
      if (command.startsWith('/remember ')) {
        const match = /^\/remember\s+(objective|constraint|decision|fact|progress|next-step)\s+(.+)$/s.exec(command)
        if (match === null) {
          console.log(label('memory'), 'usage: /remember <kind> <text>')
        } else {
          const [, kind, content] = match
          const item = session.memory.remember({
            kind: kind as 'objective' | 'constraint' | 'decision' | 'fact' | 'progress' | 'next-step',
            content: content ?? '',
          })
          console.log(label('memory'), `saved ${item.id}`)
        }
        continue
      }
      if (command.startsWith('/forget ')) {
        const id = command.slice('/forget '.length).trim()
        console.log(label('memory'), session.memory.forget(id) ? `forgot ${id}` : `unknown id ${id}`)
        continue
      }
      if (command === '/compact') {
        active = new AbortController()
        try {
          const result = await session.compact({ signal: active.signal })
          console.log(label('compact'), result === null
            ? 'no useful compactable range'
            : {
              id: result.compactionId,
              shadowed: result.shadowedSeqs.length,
              before: result.estimatedTokensBefore,
              after: result.estimatedTokensAfter,
            })
        } catch (error: unknown) {
          console.error('\n' + label('error'), paint(31, errorMessage(error)))
        } finally {
          active = undefined
        }
        continue
      }

      const message = await scenarioUserMessage(config, command, !attachedImage)
      attachedImage = attachedImage || config.scenario === 'vision'
      active = new AbortController()
      try {
        const stream = session.stream(message, { signal: active.signal })
        artifact.record('turn-start', { turn: turns + 1, prompt: command, scenario: config.scenario })
        await renderHumanRun(stream, config, broker, terminal)
        const [result, report] = await Promise.all([stream.result, stream.report])
        turns++
        artifact.record('turn-end', { turn: turns, outcome: result.outcome, report })
      } catch (error: unknown) {
        failedTurns++
        artifact.record('turn-error', { turn: turns + 1, error })
        console.error('\n' + label('error'), paint(31, errorMessage(error)))
      } finally {
        active = undefined
      }
      if (oneShot) break
    }
  } finally {
    broker.abortAll()
    terminal.close()
    const status = aborted ? 'aborted' : failedTurns > 0 ? 'failed' : 'passed'
    const summary = await artifact.finish({
      status, config: artifactConfig,
      invariants: [{ name: 'all submitted turns completed without an unhandled error', passed: failedTurns === 0 }],
      metrics: { turns, failedTurns, historyEvents: session.history.entries().length, memoryItems: session.memory.items().length },
    })
    console.log(label('artifact'), summary.artifact.directory)
  }
}

function parseConfig(): HumanCliConfig | undefined {
  try { return parseHumanCliArgs(process.argv.slice(2)) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    console.error('\n' + humanCliHelp())
    process.exitCode = 2
    return undefined
  }
}

function modelFor(config: HumanCliConfig): string | undefined {
  try { return resolveHumanModel(config, process.env) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    process.exitCode = 2
    return undefined
  }
}

function printConfig(config: HumanCliConfig, model: string): void {
  console.log(label('config'), JSON.stringify({
    provider: config.provider, model, mode: config.mode, scenario: config.scenario,
    effort: config.effort, maxTurns: config.maxTurns, logs: config.logs,
    forceTool: config.forceTool, image: config.image,
  }, null, 2))
}

function validateScenario(config: HumanCliConfig): boolean {
  if (config.scenario !== 'vision' || config.image !== undefined) return true
  console.error(paint(31, 'vision scenario requires --image <path|url|file-id:ID>'))
  process.exitCode = 2
  return false
}

await main()
