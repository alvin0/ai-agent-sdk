import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  ModelAdapter,
  ReasoningEffortId,
  ToolCallId,
  createAgentRuntime,
  defineObservationExporter,
  defineTool,
  type AgentRuntime,
  type GenerateOptions,
  type RuntimeAgentRunEvent,
  type StreamChunk,
  type ToolDefinition,
} from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { connectMcpStdio } from '@alvin0/ai-agent-sdk-mcp-node'
import { jsonlObservationExporter, recoverRuntimeObservationJournal } from '@alvin0/ai-agent-sdk-observability-node'
import { fileSystemSkillProviderPlugin } from '@alvin0/ai-agent-sdk-skill-filesystem'
import { HumanArtifactRecorder, type HumanArtifactInvariant } from '../artifacts.ts'

export interface NodeCodexAcceptanceOptions {
  readonly runId: string
  readonly resultsRoot: string
  readonly workspaceRoot?: string
  readonly mcpServerPath?: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: RuntimeAgentRunEvent) => void
}

export interface NodeCodexAcceptanceResult {
  readonly status: 'passed' | 'failed'
  readonly artifact: string
  readonly workspace: string
  readonly text: string
  readonly invariants: readonly HumanArtifactInvariant[]
  readonly metrics: Readonly<Record<string, number>>
}

type NodeMcpConnection = Awaited<ReturnType<typeof connectMcpStdio>>

class NodeCodexAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  private round = 0

  override resolveModel(provider: string, model: string) {
    const effort = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: 'Deterministic Node Codex Harness',
      context: { contextWindow: 64_000 },
      reasoning: { efforts: [{ id: effort, name: 'medium' }], defaultEffort: effort },
    })
  }

  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    request.signal?.throwIfAborted()
    this.requests.push(request)
    const round = ++this.round
    if (round === 1) return yield* toolRound(round, [{ name: 'load_skill', arguments: { skillId: 'codex-workflow' } }])
    if (round === 2) return yield* toolRound(round, [{
      name: 'read_skill_resource', arguments: { skillId: 'codex-workflow', path: 'references/contract.md' },
    }])
    if (round === 3) return yield* toolRound(round, [{ name: 'list_files', arguments: { path: '.' } }])
    if (round === 4) return yield* toolRound(round, [
      { name: 'write_file', arguments: { path: 'generated/answer.js', content: 'export const answer = 19 * 23\n' } },
      { name: 'mcp__node-codex-local__multiply', arguments: { left: 19, right: 23 } },
    ])
    if (round === 5) return yield* toolRound(round, [
      { name: 'read_file', arguments: { path: 'generated/answer.js' } },
      { name: 'run_node_check', arguments: { path: 'generated/answer.js' } },
    ])
    if (round === 6) return yield* toolRound(round, [{
      name: 'submit_result',
      arguments: {
        summary: 'Completed and verified the isolated Node coding task.',
        evidence: ['filesystem skill loaded', 'node --check passed', 'MCP returned product 437', 'usage and journal recorded'],
      },
    }])
    const text = round === 7
      ? 'Node harness hoàn tất: đã nạp skill, đọc resource, ghi và kiểm tra JavaScript, gọi MCP stdio (19 × 23 = 437), đồng thời ghi usage và trace bền vững.'
      : round === 8
        ? undefined
        : 'Phiên Node harness đã được khôi phục và sẵn sàng cho lượt tiếp theo.'
    if (text === undefined) return yield* toolRound(round, [{
      name: 'submit_result',
      arguments: { summary: 'Restored session is healthy.', evidence: ['snapshot loaded', 'history continued'] },
    }])
    yield* finalRound(round, text)
  }
}

class MissingUsageAdapter extends ModelAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'not accepted without usage' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'not accepted without usage' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class AbortProbeAdapter extends ModelAdapter {
  readonly entered: Promise<void>
  private markEntered!: () => void
  constructor() {
    super()
    this.entered = new Promise(resolveEntered => { this.markEntered = resolveEntered })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.markEntered()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
    })
  }
}

export async function runNodeCodexAcceptance(options: NodeCodexAcceptanceOptions): Promise<NodeCodexAcceptanceResult> {
  const workspace = resolve(options.workspaceRoot ?? join('test-human', 'workspaces', 'node-codex', options.runId))
  const artifact = new HumanArtifactRecorder({ harness: 'node-codex', runId: options.runId, resultsRoot: options.resultsRoot })
  let runtime: AgentRuntime | undefined
  let mcp: NodeMcpConnection | undefined
  try {
    await prepareWorkspace(workspace)
    artifact.record('workspace-ready', { workspace })
    const journalRoot = join(workspace, '.observability')
    const adapter = new NodeCodexAdapter()
    const provider = defineModelProviderPlugin({
      id: 'node-harness-provider', displayName: 'Deterministic Node harness', family: 'fixture',
      routes: ['node-harness'], defaultModel: { provider: 'node-harness', id: 'node-codex-v1' },
      setup(registrar) { registrar.registerAdapter(adapter) },
    })
    runtime = await createAgentRuntime({
      providers: [provider],
      resource: { serviceName: 'node-codex-human-test', environment: 'human-test' },
      observability: {
        mode: 'reliable', content: 'metadata',
        exporters: [{
          exporter: jsonlObservationExporter({ rootDir: journalRoot, mode: 'reliable' }),
          ownership: 'owned', requirement: 'required', boundary: 'local-durable',
        }],
      },
    })
    const mcpServerPath = resolve(options.mcpServerPath ?? join('dist-cli', 'node-codex-mcp-server.mjs'))
    mcp = await connectMcpStdio({
      serverName: 'node-codex-local', command: process.execPath, args: [mcpServerPath],
      reconnect: false, operationTimeoutMs: 15_000, toolCallTimeoutMs: 15_000,
      logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
      onStateChange: state => safeRecord(artifact, 'mcp-state', { status: state.status, attempt: state.attempt, protocol: state.protocol }),
    })
    const agent = runtime.agent({
      id: 'node-codex-harness', model: { provider: 'node-harness', id: 'node-codex-v1' }, effort: 'medium',
      mode: 'deep', commentary: 'concise', maxTurns: 10, maxToolCalls: 16,
      instructions: 'Act like a coding harness. Load matching skills, inspect before writing, use MCP when requested, then verify.',
      compaction: { auto: false, retainTokens: 256 },
      tools: createWorkspaceTools(workspace),
      toolSources: [mcp],
      skills: [fileSystemSkillProviderPlugin({ roots: [join(workspace, '.agents', 'skills')] })],
    })
    const session = agent.createSession({
      skillCwd: workspace,
      conversationId: `node-codex-${options.runId}`,
      usagePolicy: { onMissing: 'fail' },
      runtimeLimits: {
        maxSteps: 10, maxToolCalls: 16, maxTotalTokens: 20_000, observerTimeoutMs: 15_000,
      },
    })
    const counts = new Map<string, number>()
    const privatePrompt = 'Build a checked Node artifact and prove 19 × 23 through MCP. PRIVATE_NODE_PROMPT_SENTINEL'
    const response = await session.run(privatePrompt, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEvent: event => {
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
        artifact.record('agent-event', projectEvent(event))
        options.onEvent?.(event)
      },
    })
    const firstModelCalls = adapter.requests.length
    const snapshot = structuredClone(session.snapshot())
    const resumed = agent.resumeSession(snapshot, { skillCwd: workspace })
    const resumedResponse = await resumed.run('Confirm that this restored conversation can continue.', {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const mcpToolAvailable = mcp.tools.has('mcp__node-codex-local__multiply')
    const close = await runtime.close()
    runtime = undefined
    const mcpClose = await mcp.closeWithReport()
    mcp = undefined
    const recovery = await recoverRuntimeObservationJournal(journalRoot)
    const generated = await readFile(join(workspace, 'generated', 'answer.js'), 'utf8')
    const eventNames = new Set<string>(recovery.records.flatMap(record => (
      record.kind === 'event' && 'name' in record.item ? [record.item.name] : []
    )))
    const integration = inspectIntegrationEvidence(recovery.records.map(record => record.item), response.runId)
    const serializedEvidence = JSON.stringify(recovery.records)
    const failureProbes = await runFailureProbes()
    const invariants: HumanArtifactInvariant[] = [
      { name: 'Explicit Node capabilities drive a complete agent tool loop', passed: response.report.status === 'success' },
      { name: 'Filesystem skill is progressively loaded', passed: (counts.get('tool-call') ?? 0) >= 7 && adapter.requests.some(request => request.system?.includes('codex-workflow')) },
      { name: 'Workspace file is created and syntax checked', passed: generated.includes('19 * 23') && response.text.includes('kiểm tra JavaScript') },
      { name: 'MCP stdio tool executes through the agent pipeline', passed: response.text.includes('437') && mcpToolAvailable },
      { name: 'Every model call reports token usage', passed: response.report.usage.coverage.missing === 0 && response.report.usage.coverage.complete === firstModelCalls },
      { name: 'Durable journal recovers run, model, and tool observations', passed: ['sdk.agent.run', 'sdk.model.call', 'sdk.tool.call'].every(name => eventNames.has(name)) },
      { name: 'Session snapshot round-trips and resumes', passed: resumed.conversationId === session.conversationId && resumedResponse.text.includes('khôi phục') },
      { name: 'Runtime closes before borrowed MCP teardown', passed: close.state === 'closed' && close.unsettledRuns === 0 },
      { name: 'MCP lifecycle and active tool operations have balanced logical/attempt evidence', passed: integration.balanced && integration.operations.every(operation => ['catalog-refresh', 'connect', 'tool-call'].includes(operation)) },
      { name: 'MCP tool evidence uses active run correlation instead of lifecycle correlation', passed: integration.toolRunIds.length > 0 && integration.toolRunIds.every(runId => runId === response.runId) },
      { name: 'MCP teardown has independent bounded evidence after runtime close', passed: mcpClose.state === 'closed' && !mcpClose.deadlineReached && mcpClose.unsettledOperations === 0 },
      { name: 'Journal keeps prompts and generated content out of metadata', passed: !serializedEvidence.includes('PRIVATE_NODE_PROMPT_SENTINEL') && !serializedEvidence.includes('export const answer = 19 * 23') },
      { name: 'Integration logging does not alter authoritative model usage', passed: response.report.operationCounts.integration.total === 0 && response.report.usage.reported.totalTokens === 692 },
      { name: 'Missing usage fails visibly with a terminal accounting code', passed: failureProbes.missingUsage },
      { name: 'Required observation degradation is visible in the terminal report', passed: failureProbes.observationDegraded },
      { name: 'Cancellation aborts the provider and closes without unsettled work', passed: failureProbes.cancelled },
    ]
    const metrics = Object.freeze({
      modelCalls: adapter.requests.length,
      toolCalls: response.report.operationCounts.tool.total,
      reportedTokens: response.report.usage.reported.totalTokens ?? 0,
      journalRecords: recovery.records.length,
      historyEntries: snapshot.history.entries.length,
      integrationRecords: integration.records,
    })
    const passed = invariants.every(invariant => invariant.passed)
    await artifact.finish({ status: passed ? 'passed' : 'failed', invariants, metrics, config: { workspace, mcpServerPath } })
    return { status: passed ? 'passed' : 'failed', artifact: artifact.summaryPath, workspace, text: response.text, invariants, metrics }
  } catch (error: unknown) {
    await artifact.finish({
      status: 'failed', error,
      invariants: [{ name: 'Node Codex acceptance completes without an unhandled error', passed: false }],
      config: { workspace },
    })
    throw error
  } finally {
    try { await runtime?.close() } finally { await mcp?.closeWithReport() }
  }
}

async function runFailureProbes(): Promise<{
  readonly missingUsage: boolean
  readonly observationDegraded: boolean
  readonly cancelled: boolean
}> {
  const missingRuntime = await createAgentRuntime({ providers: [probeProvider('missing-usage', new MissingUsageAdapter())] })
  const missingHandle = missingRuntime.agent({
    id: 'missing-usage-probe', instructions: 'Return text.', compaction: false,
  }).createSession({ usagePolicy: { onMissing: 'fail' } }).stream('probe')
  for await (const _event of missingHandle) { /* drain canonical events */ }
  await missingHandle.result.catch(() => undefined)
  const missingReport = await missingHandle.report
  await missingRuntime.close()

  const degradedRuntime = await createAgentRuntime({
    providers: [probeProvider('degraded-observation', new NodeCodexAdapter())],
    observability: {
      mode: 'reliable', flushTimeoutMs: 25,
      exporters: [{
        exporter: defineObservationExporter({
          id: 'rejecting-exporter', supportedBoundaries: ['local-durable'],
          stage() { throw new Error('PRIVATE_EXPORTER_FAILURE') },
          async export(batch) { return { batchId: batch.id, acceptedEventIds: [], acceptedRunIds: [] } },
        }),
        ownership: 'owned', requirement: 'required', boundary: 'local-durable',
      }],
    },
  })
  const degradedHandle = degradedRuntime.agent({
    id: 'degraded-observation-probe', instructions: 'Return text.', compaction: false,
  }).createSession({ usagePolicy: { onMissing: 'fail' } }).stream('probe')
  for await (const _event of degradedHandle) { /* drain canonical events */ }
  await degradedHandle.result.catch(() => undefined)
  const degradedReport = await degradedHandle.report
  await degradedRuntime.close()

  const blocking = new AbortProbeAdapter()
  const cancelRuntime = await createAgentRuntime({ providers: [probeProvider('cancel', blocking)], closeTimeoutMs: 250 })
  const cancelHandle = cancelRuntime.agent({
    id: 'cancel-probe', instructions: 'Wait.', compaction: false,
  }).stream('probe')
  const drain = (async () => { for await (const _event of cancelHandle) { /* drain */ } })()
  await blocking.entered
  cancelHandle.abort('human cancellation probe')
  await drain
  await cancelHandle.result.catch(() => undefined)
  const cancelReport = await cancelHandle.report
  const cancelClose = await cancelRuntime.close()
  return {
    missingUsage: missingReport.status === 'error'
      && missingReport.errors.some(error => error.code === 'USAGE_REQUIRED'),
    observationDegraded: degradedReport.delivery.complete === false,
    cancelled: cancelReport.status === 'aborted' && cancelClose.unsettledRuns === 0,
  }
}

function probeProvider(id: string, adapter: ModelAdapter) {
  return defineModelProviderPlugin({
    id: `${id}-provider`, displayName: `${id} probe`, family: 'fixture',
    routes: [id], defaultModel: { provider: id, id: 'fixture-model' },
    setup(registrar) { registrar.registerAdapter(adapter) },
  })
}

interface IntegrationSummary {
  readonly balanced: boolean
  readonly operations: readonly string[]
  readonly toolRunIds: readonly string[]
  readonly records: number
}

function inspectIntegrationEvidence(items: readonly unknown[], activeRunId: string): IntegrationSummary {
  const rows = items.flatMap(item => {
    if (item === null || typeof item !== 'object' || Reflect.get(item, 'name') !== 'sdk.log') return []
    const data = Reflect.get(item, 'data')
    const fields = data !== null && typeof data === 'object' ? Reflect.get(data, 'fields') : undefined
    if (fields === null || typeof fields !== 'object'
      || Reflect.get(fields, 'integrationSchemaVersion') !== 1
      || Reflect.get(fields, 'integrationFamily') !== 'mcp-stdio-client'
      || Reflect.get(fields, 'integrationOperation') === 'close') return []
    return [{
      operation: String(Reflect.get(fields, 'integrationOperation')),
      operationId: String(Reflect.get(fields, 'operationId')),
      kind: String(Reflect.get(fields, 'kind')),
      attemptId: Reflect.get(fields, 'attemptId'),
      attemptNumber: Reflect.get(fields, 'attemptNumber'),
      status: Reflect.get(fields, 'status'),
      durationMs: Reflect.get(fields, 'durationMs'),
      runId: String(Reflect.get(item, 'correlation') !== null
        && typeof Reflect.get(item, 'correlation') === 'object'
        ? Reflect.get(Reflect.get(item, 'correlation') as object, 'runId') : ''),
    }]
  })
  const groups = new Map<string, typeof rows>()
  for (const row of rows) groups.set(row.operationId, [...groups.get(row.operationId) ?? [], row])
  const balanced = rows.length > 0 && [...groups.values()].every(group => {
    const logicalStart = group.filter(row => row.kind === 'logical-start')
    const logicalTerminal = group.filter(row => row.kind === 'logical-terminal')
    const attempts = group.filter(row => row.kind === 'attempt-start')
    const terminals = group.filter(row => row.kind === 'attempt-terminal')
    return logicalStart.length === 1 && logicalTerminal.length === 1
      && attempts.length === terminals.length
      && terminals.every(row => typeof row.status === 'string'
        && typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0)
      && attempts.every(row => Number.isSafeInteger(row.attemptNumber) && Number(row.attemptNumber) >= 1
        && terminals.some(end => end.attemptId === row.attemptId))
  })
  return {
    balanced,
    operations: [...new Set(rows.map(row => row.operation))].sort(),
    toolRunIds: rows.filter(row => row.operation === 'tool-call' && row.runId === activeRunId).map(row => row.runId),
    records: rows.length,
  }
}

function createWorkspaceTools(root: string): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  tools.push(defineTool({
    name: 'list_files', description: 'List bounded files inside the isolated Node harness workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    parse: value => ({ path: optionalString(value, 'path', '.') }),
    async execute({ path }) {
      const directory = await confinedExisting(root, path)
      const entries = await readdir(directory, { withFileTypes: true })
      return entries.slice(0, 200).map(entry => `${entry.isDirectory() ? 'dir' : 'file'}\t${entry.name}`)
    },
  }))
  tools.push(defineTool({
    name: 'read_file', description: 'Read a UTF-8 file inside the isolated Node harness workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    parse: value => ({ path: requiredString(value, 'path') }),
    async execute({ path }) {
      const file = await confinedExisting(root, path)
      const info = await stat(file)
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('read_file accepts files up to 256 KiB')
      return await readFile(file, 'utf8')
    },
  }))
  tools.push(defineTool({
    name: 'write_file', description: 'Write a UTF-8 file inside the isolated Node harness workspace.',
    parameters: {
      type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'], additionalProperties: false,
    },
    parse: value => ({ path: requiredString(value, 'path'), content: requiredString(value, 'content') }),
    async execute({ path, content }) {
      if (Buffer.byteLength(content) > 256 * 1024) throw new Error('write_file content exceeds 256 KiB')
      const file = confinedTarget(root, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content, { encoding: 'utf8', mode: 0o600 })
      return { path: relative(root, file).replaceAll('\\', '/'), bytes: Buffer.byteLength(content) }
    },
  }))
  tools.push(defineTool({
    name: 'run_node_check', description: 'Run node --check on one JavaScript file inside the workspace without a shell.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    parse: value => ({ path: requiredString(value, 'path') }),
    async execute({ path }, context) {
      const file = await confinedExisting(root, path)
      return await runCheckedProcess(process.execPath, ['--check', file], root, context.signal)
    },
  }))
  return tools
}

async function prepareWorkspace(root: string): Promise<void> {
  const skill = join(root, '.agents', 'skills', 'codex-workflow')
  await mkdir(join(skill, 'references'), { recursive: true, mode: 0o700 })
  await writeFile(join(skill, 'SKILL.md'), [
    '---', 'name: codex-workflow', 'description: Safe inspect, edit, and verify workflow for Node coding harnesses.', '---',
    'Inspect the workspace before editing. Keep writes scoped. Verify JavaScript with node --check.', '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 })
  await writeFile(join(skill, 'references', 'contract.md'), [
    '# Acceptance contract', '', '- Use MCP for external tool transport.', '- Require authoritative token usage.', '- Persist canonical observations.', '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 })
}

async function* toolRound(round: number, calls: readonly { name: string; arguments: Record<string, unknown> }[]): AsyncIterable<StreamChunk> {
  let index = 0
  const commentary = `Bước ${round}: ${calls.map(call => call.name).join(', ')}. `
  yield { type: 'text-delta', index, text: commentary, phase: 'commentary' }
  yield { type: 'block-end', index: index++, block: { type: 'text', text: commentary, phase: 'commentary' } }
  for (const [callIndex, call] of calls.entries()) {
    yield {
      type: 'block-end', index: index++,
      block: { type: 'tool-call', id: ToolCallId(`node-codex-${round}-${callIndex}`), name: call.name, arguments: JSON.stringify(call.arguments) },
    }
  }
  yield { type: 'usage', usage: { inputTokens: 80 + round, outputTokens: 12, totalTokens: 92 + round } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* finalRound(round: number, text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (const token of text.match(/\S+\s*/gu) ?? [text]) yield { type: 'text-delta', index: 0, text: token, phase: 'final-answer' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text, phase: 'final-answer' } }
  yield { type: 'usage', usage: { inputTokens: 80 + round, outputTokens: 32, totalTokens: 112 + round } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function projectEvent(event: RuntimeAgentRunEvent): Record<string, unknown> {
  if (event.type === 'assistant-delta' || event.type === 'commentary-delta') return { type: event.type, chars: event.text.length }
  if (event.type === 'tool-call') return { type: event.type, toolName: event.name, callId: event.callId }
  if (event.type === 'tool-result') return { type: event.type, toolName: event.name, callId: event.callId, status: event.status }
  if (event.type === 'usage') return { type: event.type, usage: event.usage }
  return { type: event.type }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') throw new TypeError('tool arguments must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, key: string): string {
  const item = record(value)[key]
  if (typeof item !== 'string' || item.length === 0) throw new TypeError(`${key} must be a non-empty string`)
  return item
}

function optionalString(value: unknown, key: string, fallback: string): string {
  const item = record(value)[key]
  if (item === undefined) return fallback
  if (typeof item !== 'string') throw new TypeError(`${key} must be a string`)
  return item
}

function confinedTarget(root: string, path: string): string {
  if (path.includes('\0')) throw new Error('path contains a null byte')
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('path escapes the Node harness workspace')
  return target
}

async function confinedExisting(root: string, path: string): Promise<string> {
  const target = confinedTarget(root, path)
  const canonicalRoot = await realpath(root)
  const canonical = await realpath(target)
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error('symlink escapes the Node harness workspace')
  return canonical
}

async function runCheckedProcess(executable: string, args: readonly string[], cwd: string, signal: AbortSignal) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { if (stdout.length < 32_000) stdout += String(chunk) })
    child.stderr.on('data', chunk => { if (stderr.length < 32_000) stderr += String(chunk) })
    const abort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', reject)
    child.once('exit', code => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { reject(signal.reason); return }
      resolveRun({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

function safeRecord(artifact: HumanArtifactRecorder, kind: string, data: unknown): void {
  try { artifact.record(kind, data) } catch { /* connection close can notify after artifact finalization */ }
}
