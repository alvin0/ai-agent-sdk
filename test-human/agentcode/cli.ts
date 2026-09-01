#!/usr/bin/env node
/** Continuous real-provider coding session with safe-step live steering. */

import { mkdir } from 'node:fs/promises'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { AgentSession } from '@ai-agent-sdk/agent'
import { createUserInputBroker } from '@ai-agent-sdk/agent'
import { errorMessage, label, paint } from '../console.ts'
import { createHumanModelRegistry } from '../providers.ts'
import { renderHumanRun } from '../terminal.ts'
import { createAgentCodeAgent } from './agent.ts'
import {
  agentCodeCliHelp,
  parseAgentCodeCliArgs,
  resolveAgentCodeModel,
  type AgentCodeCliConfig,
} from './config.ts'
import { TerminalLineQueue } from './line-queue.ts'
import { AgentCodeSteeringQueue } from './steering.ts'
import { createAgentCodeToolRegistry } from './tools.ts'

async function main(): Promise<void> {
  const config = parseConfig()
  if (config === undefined) return
  if (config.help) { console.log(agentCodeCliHelp()); return }
  const model = modelFor(config)
  if (model === undefined) return

  const tools = createAgentCodeToolRegistry(config.workdir)
  console.log(label('agentcode/config'), JSON.stringify({
    provider: config.provider, model, effort: config.effort, mode: config.mode,
    maxTurns: config.maxTurns, maxToolCalls: config.maxToolCalls, workdir: config.workdir,
    skillRoots: config.skillRoots,
    compaction: { maxInputTokens: config.maxInputTokens, retainTokens: config.retainTokens },
    tools: tools.names(), logs: config.logs, prompt: config.prompt,
    conversation: config.once ? 'single-run' : 'continuous-with-steering',
  }, null, 2))
  if (config.dryRun) return

  await mkdir(config.workdir, { recursive: true })
  const registry = createHumanModelRegistry(config)
  const broker = createUserInputBroker()
  const terminal = createInterface({ input: stdin, output: stdout })
  const inbox = new TerminalLineQueue()
  let active = false
  let activeController: AbortController | undefined
  let exiting = false
  let inputClosed = false
  let session: AgentSession
  const steering = new AgentCodeSteeringQueue({
    onApplied(items, boundary) {
      const at = boundary.kind === 'before-step'
        ? `turn ${boundary.turn}, step ${boundary.step}`
        : 'turn end'
      console.log(label('steering/applied'), items.map(item => item.id), at)
    },
  })

  // Deep mode intentionally omits the blocking user-input tool here so readline
  // remains exclusively available for asynchronous live steering.
  session = createAgentCodeAgent(config, model).createSession({
    registry, tools, skillCwd: config.workdir, hooks: steering.hooks(() => session.history),
  })
  const discoveredSkills = await session.skills?.discover({ cwd: config.workdir }) ?? []
  console.log(label('agentcode/skills'), discoveredSkills.length === 0
    ? 'none discovered'
    : discoveredSkills.map(skill => `${skill.id} (${skill.source})`).join(', '))

  terminal.on('line', line => {
    if (!active) { inbox.push(line); return }
    const command = line.trim()
    if (command === '/quit' || command === '/exit') {
      exiting = true
      activeController?.abort(new Error('human ended the agentcode session'))
      return
    }
    if (command === '/abort') {
      activeController?.abort(new Error('human aborted the active agentcode turn'))
      console.log(label('abort'), 'active turn cancellation requested')
      return
    }
    if (command === '/memory') { printMemory(session); return }
    if (command === '/history' || command === '/stats') { printStats(session, config); return }
    if (command === '/compact' || command === '/new') {
      console.log(label('busy'), `${command} is available after the active turn; type text to steer now`)
      return
    }
    if (command.length === 0) return
    const text = command.startsWith('/steer ') ? command.slice('/steer '.length) : command
    const item = steering.enqueue(text)
    console.log(label('steering/queued'), item.id, 'will apply at the next safe model boundary')
  })
  terminal.on('close', () => {
    inputClosed = true
    inbox.close()
    if (!active) exiting = true
  })
  terminal.on('SIGINT', () => {
    if (active) {
      activeController?.abort(new Error('human interrupted the active agentcode turn'))
      console.log('\n' + label('abort'), 'active turn cancellation requested; session remains open')
    } else {
      exiting = true
      inbox.close()
      terminal.close()
    }
  })

  console.log(label('agentcode/ready'), 'type during a run to steer; after completion, type the next request')
  let nextInput: string | undefined = config.prompt
  try {
    while (!exiting) {
      if (nextInput === undefined) {
        terminal.setPrompt(paint(32, '\nyou> '))
        terminal.prompt()
        nextInput = await inbox.take()
        if (nextInput === undefined) break
      }
      const input = nextInput.trim()
      nextInput = undefined
      if (input.length === 0) continue
      const command = await handleIdleCommand(input, session, config)
      if (command === 'quit') break
      if (command === 'handled') continue

      active = true
      activeController = new AbortController()
      console.log(label('agentcode/turn'), 'running; type a steering message and press Enter at any time')
      try {
        await renderHumanRun(
          session.stream(input, { signal: activeController.signal }), config, broker, terminal,
        )
      } catch (error: unknown) {
        console.error('\n' + label('error'), paint(31, errorMessage(error)))
      } finally {
        active = false
        activeController = undefined
      }
      printStats(session, config)
      if (exiting || inputClosed) break
      const lateSteering = steering.takePendingInput()
      if (lateSteering !== undefined) {
        console.log(label('steering/carried'), 'late steering starts the next turn')
        nextInput = lateSteering
      } else if (config.once) {
        break
      } else {
        console.log(label('agentcode/ready'), 'turn complete; continue typing, or /quit')
      }
    }
  } finally {
    broker.abortAll()
    inbox.close()
    terminal.close()
  }
}

type IdleCommandResult = 'run' | 'handled' | 'quit'

async function handleIdleCommand(
  input: string,
  session: AgentSession,
  config: AgentCodeCliConfig,
): Promise<IdleCommandResult> {
  if (input === '/quit' || input === '/exit') return 'quit'
  if (input === '/memory') { printMemory(session); return 'handled' }
  if (input === '/history' || input === '/stats') { printStats(session, config); return 'handled' }
  if (input === '/new') {
    session.reset()
    console.log(label('history'), 'started a new conversation; workspace files are preserved')
    return 'handled'
  }
  if (input === '/compact') {
    const result = await session.compact()
    console.log(label('compact'), result === null ? 'no useful compactable range' : {
      id: result.compactionId, shadowed: result.shadowedSeqs.length,
      before: result.estimatedTokensBefore, after: result.estimatedTokensAfter,
    })
    return 'handled'
  }
  if (input === '/help') {
    console.log(agentCodeCliHelp())
    return 'handled'
  }
  if (input === '/abort') {
    console.log(label('abort'), 'there is no active turn')
    return 'handled'
  }
  return 'run'
}

function printMemory(session: AgentSession): void {
  console.log(label('agentcode/memory'), JSON.stringify(session.memory.items(), null, 2))
}

function printStats(session: AgentSession, config: AgentCodeCliConfig): void {
  const entries = session.history.entries()
  const kinds = entries.map(entry => entry.event.kind)
  const summaries = entries.flatMap(entry => entry.event.kind === 'compaction-summary'
    ? [entry.event] : [])
  const ends = entries.flatMap(entry => entry.event.kind === 'compaction-end'
    ? [entry.event] : [])
  const savedTokens = summaries.reduce(
    (total, event) => total + event.estimatedTokensBefore - event.estimatedTokensAfter,
    0,
  )
  console.log(label('agentcode/stats'), JSON.stringify({
    historyEvents: kinds.length,
    compactionsStarted: kinds.filter(kind => kind === 'compaction-start').length,
    compactionsCompleted: summaries.length,
    compactionsFailed: ends.filter(event => event.status === 'failed').length,
    compactionBackoffs: {
      lowSavings: ends.filter(event => event.backoffReason === 'low-savings').length,
      unreachableThreshold: ends.filter(event => event.backoffReason === 'unreachable-threshold').length,
    },
    estimatedTokensSaved: savedTokens,
    averageTokensSaved: summaries.length === 0 ? 0 : Math.round(savedTokens / summaries.length),
    userMessages: entries.filter(entry =>
      entry.event.kind === 'user' && entry.event.message.source.kind === 'user').length,
    memoryItems: session.memory.items().length,
    workspace: config.workdir,
  }, null, 2))
}

function parseConfig(): AgentCodeCliConfig | undefined {
  try { return parseAgentCodeCliArgs(process.argv.slice(2)) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    console.error('\n' + agentCodeCliHelp())
    process.exitCode = 2
    return undefined
  }
}

function modelFor(config: AgentCodeCliConfig): string | undefined {
  try { return resolveAgentCodeModel(config, process.env) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    process.exitCode = 2
    return undefined
  }
}

await main()
