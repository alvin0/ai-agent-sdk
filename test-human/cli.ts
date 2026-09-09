#!/usr/bin/env node
/** Thin REPL/controller entry point for the human acceptance harness. */

import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createUserInputBroker } from '@alvin0/ai-agent-sdk-core/agent'
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
  const session = createHumanAgent(config, model).createSession({
    registry, tools, userInput: broker,
    ...(config.scenario === 'deep-research' ? { runtimeLimits: { maxTotalTokens: 180_000 } } : {}),
  })
  const terminal = createInterface({ input: stdin, output: stdout })
  let active: AbortController | undefined
  let attachedImage = false
  const oneShot = config.prompt !== undefined
  let queuedPrompt = config.prompt
  let turns = 0
  let failedTurns = 0
  let aborted = false
  let deepResearchSearches = 0
  let deepResearchReportChars = 0
  let deepResearchCompleted = false
  const deepResearchCitations = new Set<string>()

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
        const rendered = await renderHumanRun(stream, config, broker, terminal)
        const [result, report] = await Promise.all([stream.result, stream.report])
        turns++
        artifact.record('turn-end', { turn: turns, outcome: result.outcome, report })
        if (config.scenario === 'deep-research') {
          deepResearchSearches += rendered.nativeToolCalls['web-search'] ?? 0
          for (const url of rendered.citationUrls) deepResearchCitations.add(url)
          for (const url of markdownUrls(result.text)) deepResearchCitations.add(url)
          deepResearchReportChars = result.text.length
          deepResearchCompleted = result.outcome.completed
          await mkdir(artifact.directory, { recursive: true, mode: 0o700 })
          await writeFile(join(artifact.directory, 'report.md'), result.text, { encoding: 'utf8', mode: 0o600 })
          artifact.record('deep-research-evidence', {
            nativeWebSearchCalls: deepResearchSearches,
            uniqueCitationUrls: deepResearchCitations.size,
            citationDomains: citationDomains(deepResearchCitations),
            reportChars: deepResearchReportChars,
            completed: deepResearchCompleted,
          })
        }
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
    const researchInvariants = config.scenario === 'deep-research'
      ? [
          { name: 'Deep research uses at least three web-search calls', passed: deepResearchSearches >= 3, detail: `${deepResearchSearches} calls` },
          { name: 'Deep research cites at least six unique pages', passed: deepResearchCitations.size >= 6, detail: `${deepResearchCitations.size} pages` },
          { name: 'Deep research crosses at least three source domains', passed: citationDomains(deepResearchCitations).length >= 3, detail: `${citationDomains(deepResearchCitations).length} domains` },
          { name: 'Deep research produces a substantial Markdown report', passed: deepResearchReportChars >= 4_000, detail: `${deepResearchReportChars} chars` },
          { name: 'Deep-mode self-check accepts the completed research', passed: deepResearchCompleted },
        ]
      : []
    const passed = failedTurns === 0 && researchInvariants.every(invariant => invariant.passed)
    const status = aborted ? 'aborted' : passed ? 'passed' : 'failed'
    const summary = await artifact.finish({
      status, config: artifactConfig,
      invariants: [
        { name: 'all submitted turns completed without an unhandled error', passed: failedTurns === 0 },
        ...researchInvariants,
      ],
      metrics: {
        turns, failedTurns, historyEvents: session.history.entries().length, memoryItems: session.memory.items().length,
        ...(config.scenario === 'deep-research' ? {
          nativeWebSearchCalls: deepResearchSearches,
          uniqueCitationUrls: deepResearchCitations.size,
          citationDomains: citationDomains(deepResearchCitations).length,
          reportChars: deepResearchReportChars,
        } : {}),
      },
    })
    console.log(label('artifact'), summary.artifact.directory)
    if (status === 'failed') process.exitCode = 1
  }
}

function citationDomains(urls: ReadonlySet<string>): string[] {
  const domains = new Set<string>()
  for (const value of urls) {
    try { domains.add(new URL(value).hostname.toLocaleLowerCase()) }
    catch { /* malformed provider annotations do not count as source domains */ }
  }
  return [...domains].sort()
}

function markdownUrls(markdown: string): string[] {
  const urls = new Set<string>()
  for (const match of markdown.matchAll(/https:\/\/[^\s)\]}>'"]+/gu)) {
    try { urls.add(new URL(match[0]).toString()) }
    catch { /* malformed report links do not count as citations */ }
  }
  return [...urls]
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
