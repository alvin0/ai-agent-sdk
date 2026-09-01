/** Bounded behavioral evidence for skill use in long-running agentcode sessions. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CheckpointContext, TurnHooks } from '@ai-agent-sdk/agent'
import type { FileSystemSkillIoEvent } from '@ai-agent-sdk/skill-filesystem'
import {
  AGENT_CONTROL_TOOLS,
  type AgentRunEvent,
} from '@ai-agent-sdk/agent'
import { MAX_SKILL_ID_CHARS, SKILL_ID_PATTERN } from '@ai-agent-sdk/agent'
import type { ToolExecutionResult } from '@ai-agent-sdk/agent'
import type { ContentBlock } from '@ai-agent-sdk/core'
import type { Message } from '@ai-agent-sdk/core'

const SKILL_TOOLS = new Set([
  'load_skill',
  'search_skill_resources',
  'read_skill_resource',
])
const CONTROL_TOOLS = new Set<string>(Object.values(AGENT_CONTROL_TOOLS))
const MATERIAL_AGENTCODE_TOOLS = new Set([
  'write_file',
  'replace_in_file',
  'run_command',
])
const SUCCESSFUL_NATIVE_STATUSES = new Set([
  'completed',
  'success',
  'succeeded',
])

export type SkillEvidenceStatus =
  | 'not-loaded'
  | 'load-failed'
  | 'loaded'
  | 'instructions-in-context'
  | 'behaviorally-applied'
  | 'resource-informed'

export interface AgentCodeSkillReportOptions {
  /** Destination for {@link AgentCodeSkillReportRecorder.flush}. */
  readonly reportPath: string
  /** Skills the exercise intends to use. Missing skills remain visible in the report. */
  readonly expectedSkillIds?: readonly string[]
  /** Timeline entries retained in memory and JSON. Defaults to 2,000. */
  readonly maxTimelineEntries?: number
  /** Distinct skills retained in memory and JSON. Defaults to 128. */
  readonly maxTrackedSkills?: number
  /** Simultaneous calls, unexposed results, and spans retained. Defaults to 4,096. */
  readonly maxPendingRecords?: number
  /** Problems retained verbatim after redaction. Defaults to 200. */
  readonly maxProblems?: number
  /** Maximum length of any externally supplied string in the report. Defaults to 320. */
  readonly maxStringChars?: number
  /** Injectable clock for deterministic tests. */
  readonly now?: () => string
}

export interface AgentCodeSkillEvidence {
  readonly skillId: string
  readonly expected: boolean
  readonly status: SkillEvidenceStatus
  readonly loadAttempts: number
  readonly successfulLoads: number
  readonly failedLoads: number
  readonly instructionExposureRequests: number
  readonly resourceAttempts: number
  readonly successfulResourceCalls: number
  readonly resourceExposureRequests: number
  readonly successfulApplicationActions: number
  readonly failedApplicationAttempts: number
  readonly resourceInformedActions: number
  readonly activationIoEvents: number
  readonly activationBytesRead: number
  readonly resourceIoEvents: number
  readonly resourceBytesRead: number
  readonly applicationTools: readonly string[]
  readonly firstLoadSequence?: number
  readonly firstInstructionExposureSequence?: number
  readonly firstApplicationSequence?: number
}

export interface AgentCodeSkillReportSummary {
  readonly eventsObserved: number
  readonly modelRequestsObserved: number
  readonly catalogRequestsObserved: number
  readonly runsObserved: number
  readonly turnsObserved: number
  readonly compactionsStarted: number
  readonly compactionsCompleted: number
  readonly successfulApplicationActions: number
  readonly skillIoEvents: number
  readonly skillIoBytesRead: number
  readonly discoveryIoEvents: number
  readonly activationIoEvents: number
  readonly resourceIoEvents: number
  readonly skillsLoaded: number
  readonly skillsInstructionExposed: number
  readonly skillsBehaviorallyApplied: number
  readonly skillsResourceInformed: number
  readonly expectedSkills: number
  readonly expectedSkillsBehaviorallyApplied: number
  readonly allExpectedSkillsBehaviorallyApplied: boolean
  readonly multipleSkillsBehaviorallyApplied: boolean
  readonly orderProblems: number
  readonly trace: {
    readonly spansStarted: number
    readonly spansEnded: number
    readonly openSpans: number
    readonly duplicateStarts: number
    readonly duplicateEnds: number
    readonly endsWithoutStart: number
    readonly orphanStarts: number
    readonly auditComplete: boolean
  }
}

export interface AgentCodeSkillReport {
  /** v2 narrows behavioral application to material actions. */
  readonly schemaVersion: 2
  readonly generatedAt: string
  readonly summary: AgentCodeSkillReportSummary
  readonly skills: readonly AgentCodeSkillEvidence[]
  readonly problems: readonly string[]
  readonly timeline: readonly Readonly<Record<string, unknown>>[]
  readonly omitted: {
    readonly timelineEntries: number
    readonly problems: number
    readonly skills: number
    readonly pendingRecords: number
  }
  readonly proofLimits: readonly string[]
}

/** Whether a report is complete enough to serve as release-acceptance evidence. */
export function isAgentCodeSkillEvidenceComplete(report: AgentCodeSkillReport): boolean {
  return report.summary.allExpectedSkillsBehaviorallyApplied
    && report.summary.orderProblems === 0
    && report.problems.length === 0
    && report.omitted.timelineEntries === 0
    && report.omitted.problems === 0
    && report.omitted.skills === 0
    && report.omitted.pendingRecords === 0
}

interface MutableSkillEvidence {
  skillId: string
  expected: boolean
  loadAttempts: number
  successfulLoads: number
  failedLoads: number
  instructionExposureRequests: number
  resourceAttempts: number
  successfulResourceCalls: number
  resourceExposureRequests: number
  successfulApplicationActions: number
  failedApplicationAttempts: number
  resourceInformedActions: number
  activationIoEvents: number
  activationBytesRead: number
  resourceIoEvents: number
  resourceBytesRead: number
  applicationTools: Set<string>
  firstLoadSequence?: number
  firstInstructionExposureSequence?: number
  firstApplicationSequence?: number
}

interface PendingCall {
  readonly toolName: string
  readonly sequence: number
  readonly skillId?: string
  readonly resourcePath?: string
  readonly applicationSkills?: readonly string[]
  readonly resourceInformedSkills?: readonly string[]
}

interface PendingExposure {
  readonly skillId: string
  readonly sequence: number
}

interface PendingRequestResult {
  readonly requestSequence: number
  readonly textChars: number
  readonly skillMarkers: ReadonlySet<string>
}

interface RunObservation {
  readonly id: string
  readonly ordinal: number
  readonly startedSequence: number
  eventCount: number
}

interface TraceCounters {
  started: number
  ended: number
  duplicateStarts: number
  duplicateEnds: number
  endsWithoutStart: number
  orphanStarts: number
  auditComplete: boolean
}

/**
 * Record a privacy-preserving proof chain for skill use.
 *
 * A successful `load_skill` alone is deliberately insufficient. A skill becomes
 * `instructions-in-context` only after a later model request contains both that
 * call's tool result and its exact `<skill_content id>` marker. It becomes
 * `behaviorally-applied` only when a later material AgentCode action succeeds.
 * Workspace inspection and unknown app tools are deliberately ignored, so they
 * neither prove application nor consume evidence that can be attributed to a
 * later write, replacement, command, or explicitly successful native action.
 * The recorder proves ordering and observable behavior, not semantic compliance
 * with every sentence of a skill.
 */
export class AgentCodeSkillReportRecorder {
  readonly reportPath: string
  private readonly now: () => string
  private readonly maxTimelineEntries: number
  private readonly maxTrackedSkills: number
  private readonly maxPendingRecords: number
  private readonly maxProblems: number
  private readonly maxStringChars: number
  private readonly expected = new Set<string>()
  private readonly skills = new Map<string, MutableSkillEvidence>()
  private readonly calls = new Map<string, PendingCall>()
  private readonly loadResults = new Map<string, PendingExposure>()
  private readonly resourceResults = new Map<string, PendingExposure>()
  // Checkpoint callbacks and the async event consumer can be scheduled in either
  // order. Retain bounded call-id evidence so either side can arrive first.
  private readonly requestResults = new Map<string, PendingRequestResult>()
  private readonly pendingApplication = new Set<string>()
  private readonly pendingResourceApplication = new Set<string>()
  private readonly openSpans = new Map<string, string | null>()
  private readonly recentlyEndedSpans = new Set<string>()
  private readonly timeline: Readonly<Record<string, unknown>>[] = []
  private readonly problems: string[] = []
  private readonly trace: TraceCounters = {
    started: 0, ended: 0, duplicateStarts: 0, duplicateEnds: 0,
    endsWithoutStart: 0, orphanStarts: 0, auditComplete: true,
  }
  private sequence = 0
  private eventsObserved = 0
  private modelRequestsObserved = 0
  private catalogRequestsObserved = 0
  private runsObserved = 0
  private turnsObserved = 0
  private compactionsStarted = 0
  private compactionsCompleted = 0
  private successfulApplicationActions = 0
  private skillIoEvents = 0
  private skillIoBytesRead = 0
  private discoveryIoEvents = 0
  private activationIoEvents = 0
  private resourceIoEvents = 0
  private timelineOmitted = 0
  private problemsOmitted = 0
  private skillsOmitted = 0
  private pendingRecordsOmitted = 0
  private activeRun: RunObservation | undefined
  private currentTurn: number | undefined
  private currentStep: number | undefined

  constructor(options: AgentCodeSkillReportOptions) {
    if (options.reportPath.trim().length === 0) throw new TypeError('reportPath must not be empty')
    this.reportPath = options.reportPath
    this.maxTimelineEntries = positiveInteger(options.maxTimelineEntries ?? 2_000, 'maxTimelineEntries')
    this.maxTrackedSkills = positiveInteger(options.maxTrackedSkills ?? 128, 'maxTrackedSkills')
    this.maxPendingRecords = positiveInteger(options.maxPendingRecords ?? 4_096, 'maxPendingRecords')
    this.maxProblems = positiveInteger(options.maxProblems ?? 200, 'maxProblems')
    this.maxStringChars = positiveInteger(options.maxStringChars ?? 320, 'maxStringChars')
    this.now = options.now ?? (() => new Date().toISOString())
    for (const rawId of options.expectedSkillIds ?? []) {
      const id = sanitizeSkillId(rawId)
      if (id === undefined) {
        this.problem('invalid expected skill id was omitted')
        continue
      }
      if (this.expected.has(id)) continue
      this.expected.add(id)
      this.skill(id, true)
    }
  }

  /** Pass events through unchanged while attaching them to one sequential agent run. */
  observe(
    stream: AsyncIterable<AgentRunEvent>,
    label = `run-${this.runsObserved + 1}`,
  ): AsyncIterable<AgentRunEvent> {
    const recorder = this
    return {
      async * [Symbol.asyncIterator]() {
        if (recorder.activeRun !== undefined) {
          throw new Error('skill report recorder supports one active agentcode run at a time')
        }
        const run: RunObservation = {
          id: recorder.safe(label), ordinal: ++recorder.runsObserved,
          startedSequence: recorder.nextSequence(), eventCount: 0,
        }
        recorder.activeRun = run
        recorder.addTimeline({ sequence: run.startedSequence, type: 'run-start', run: run.id })
        try {
          for await (const event of stream) {
            run.eventCount++
            recorder.recordEvent(event)
            yield event
          }
        } finally {
          const sequence = recorder.nextSequence()
          recorder.addTimeline({
            sequence, type: 'run-end', run: run.id, events: run.eventCount,
            startedSequence: run.startedSequence,
          })
          recorder.activeRun = undefined
          recorder.currentTurn = undefined
          recorder.currentStep = undefined
        }
      },
    }
  }

  /** Record a loop checkpoint without retaining system text, prompts, or tool output. */
  recordCheckpoint(context: CheckpointContext): void {
    if (context.kind !== 'before-model-request') return
    const sequence = this.nextSequence()
    this.modelRequestsObserved++
    const systemHasCatalog = context.request.system?.includes('<available_skills>') === true
    if (systemHasCatalog) this.catalogRequestsObserved++
    const request = inspectModelMessages(context.request.messages)
    this.addTimeline({
      sequence, type: 'model-request', run: this.runId(),
      provider: this.safe(context.request.provider), model: this.safe(context.request.model),
      systemHasCatalog, messages: context.request.messages.length,
      toolResults: request.toolResults.size, skillMarkers: request.skillMarkers.size,
    })
    for (const [callId, result] of request.toolResults) {
      const observed: PendingRequestResult = {
        requestSequence: sequence,
        textChars: result.textChars,
        skillMarkers: result.skillMarkers,
      }
      const load = this.loadResults.get(callId)
      if (load !== undefined) {
        this.loadResults.delete(callId)
        this.exposeLoadResult(callId, load, observed)
        continue
      }
      const resource = this.resourceResults.get(callId)
      if (resource !== undefined) {
        this.resourceResults.delete(callId)
        this.exposeResourceResult(callId, resource, observed)
        continue
      }
      this.setBoundedQuietly(this.requestResults, callId, observed)
    }
  }

  /** Aggregate lazy filesystem discovery/activation/resource I/O without retaining paths. */
  recordSkillIo(event: FileSystemSkillIoEvent): void {
    const sequence = this.nextSequence()
    this.skillIoEvents++
    this.skillIoBytesRead += nonNegative(event.bytesRead)
    if (event.phase === 'discovery') this.discoveryIoEvents++
    else if (event.phase === 'activation') this.activationIoEvents++
    else this.resourceIoEvents++
    const skillId = event.skillId === undefined ? undefined : sanitizeSkillId(event.skillId)
    if (event.skillId !== undefined && skillId === undefined) {
      this.problem('skill I/O event has an invalid skillId')
    }
    const skill = skillId === undefined || event.phase === 'discovery'
      ? undefined
      : this.skill(skillId)
    if (skill !== undefined && event.phase === 'activation') {
      skill.activationIoEvents++
      skill.activationBytesRead += nonNegative(event.bytesRead)
    } else if (skill !== undefined && event.phase === 'resource') {
      skill.resourceIoEvents++
      skill.resourceBytesRead += nonNegative(event.bytesRead)
    }
    // Discovery can touch hundreds of files; aggregate it instead of allowing
    // metadata scans to crowd causal tool/request evidence out of the timeline.
    if (event.phase === 'discovery') return
    this.addTimeline({
      sequence, type: 'skill-io', run: this.runId(), phase: event.phase,
      operation: event.operation, bytesRead: nonNegative(event.bytesRead),
      ...(event.entriesScanned === undefined
        ? {} : { entriesScanned: nonNegative(event.entriesScanned) }),
      ...(skillId === undefined ? {} : { skillId }),
    })
  }

  /** Record one event directly. Prefer {@link observe} for normal CLI integration. */
  recordEvent(event: AgentRunEvent): void {
    const sequence = this.nextSequence()
    this.eventsObserved++
    if (event.type === 'turn-start') {
      this.currentTurn = event.turn
      this.currentStep = undefined
      this.turnsObserved++
      this.addTimeline({ sequence, type: event.type, run: this.runId(), turn: event.turn })
    } else if (event.type === 'step-start') {
      this.currentTurn = event.turn
      this.currentStep = event.step
    } else if (event.type === 'step-end') {
      this.currentStep = undefined
    } else if (event.type === 'tool-call') {
      this.recordToolCall(event, sequence)
    } else if (event.type === 'tool-result') {
      this.recordToolResult(event, sequence)
    } else if (event.type === 'assistant-native-tool') {
      if (isSuccessfulNativeStatus(event.call.status)) {
        this.recordNativeAction(event.call.name, sequence)
      }
    } else if (event.type === 'compaction-start') {
      this.compactionsStarted++
      this.addTimeline({ sequence, type: event.type, run: this.runId(), trigger: event.trigger })
    } else if (event.type === 'compaction-end') {
      if (event.status === 'completed') this.compactionsCompleted++
      this.addTimeline({
        sequence, type: event.type, run: this.runId(), status: event.status,
        trigger: event.trigger, before: event.estimatedTokensBefore,
        after: event.estimatedTokensAfter, shadowed: event.shadowedSeqs.length,
      })
    } else if (event.type === 'span-start' || event.type === 'span-end') {
      this.recordTrace(event, sequence)
    } else if (event.type === 'agent-end') {
      this.addTimeline({
        sequence, type: event.type, run: this.runId(), completed: event.outcome.completed,
        reason: event.outcome.reason.kind, traceId: this.safe(event.outcome.traceId),
      })
    }
  }

  snapshot(): AgentCodeSkillReport {
    const skills = [...this.skills.values()]
      .map(skill => freezeEvidence(skill))
      .sort((left, right) => (left.firstLoadSequence ?? Number.MAX_SAFE_INTEGER)
        - (right.firstLoadSequence ?? Number.MAX_SAFE_INTEGER) || left.skillId.localeCompare(right.skillId))
    const applied = skills.filter(skill => isApplied(skill.status))
    const expected = skills.filter(skill => skill.expected)
    const expectedApplied = expected.filter(skill => isApplied(skill.status))
    const summary: AgentCodeSkillReportSummary = Object.freeze({
      eventsObserved: this.eventsObserved,
      modelRequestsObserved: this.modelRequestsObserved,
      catalogRequestsObserved: this.catalogRequestsObserved,
      runsObserved: this.runsObserved,
      turnsObserved: this.turnsObserved,
      compactionsStarted: this.compactionsStarted,
      compactionsCompleted: this.compactionsCompleted,
      successfulApplicationActions: this.successfulApplicationActions,
      skillIoEvents: this.skillIoEvents,
      skillIoBytesRead: this.skillIoBytesRead,
      discoveryIoEvents: this.discoveryIoEvents,
      activationIoEvents: this.activationIoEvents,
      resourceIoEvents: this.resourceIoEvents,
      skillsLoaded: skills.filter(skill => skill.successfulLoads > 0).length,
      skillsInstructionExposed: skills.filter(skill => skill.instructionExposureRequests > 0).length,
      skillsBehaviorallyApplied: applied.length,
      skillsResourceInformed: skills.filter(skill => skill.resourceInformedActions > 0).length,
      expectedSkills: expected.length,
      expectedSkillsBehaviorallyApplied: expectedApplied.length,
      allExpectedSkillsBehaviorallyApplied: expected.length > 0 && expectedApplied.length === expected.length,
      multipleSkillsBehaviorallyApplied: applied.length >= 2,
      orderProblems: this.problems.length + this.problemsOmitted,
      trace: Object.freeze({
        spansStarted: this.trace.started,
        spansEnded: this.trace.ended,
        openSpans: this.openSpans.size,
        duplicateStarts: this.trace.duplicateStarts,
        duplicateEnds: this.trace.duplicateEnds,
        endsWithoutStart: this.trace.endsWithoutStart,
        orphanStarts: this.trace.orphanStarts,
        auditComplete: this.trace.auditComplete,
      }),
    })
    return Object.freeze({
      schemaVersion: 2 as const,
      generatedAt: this.now(),
      summary,
      skills: Object.freeze(skills),
      problems: Object.freeze([...this.problems]),
      timeline: Object.freeze([...this.timeline]),
      omitted: Object.freeze({
        timelineEntries: this.timelineOmitted,
        problems: this.problemsOmitted,
        skills: this.skillsOmitted,
        pendingRecords: this.pendingRecordsOmitted,
      }),
      proofLimits: Object.freeze([
        'Behaviorally applied means instructions were observed in a later model request before a successful material action: write_file, replace_in_file, run_command with exitCode 0 and no timeout, or an explicitly successful provider-native action.',
        'Workspace inspection (list_files, read_file, and grep_files), protocol/control calls, and unknown app tools are conservatively ignored and do not consume pending skill attribution.',
        'The report proves protocol order and observable actions; it cannot prove semantic compliance with every skill instruction.',
        'Prompts, reasoning text, non-skill tool arguments, tool output, file contents, and provider credentials are intentionally not recorded.',
      ]),
    })
  }

  async flush(): Promise<AgentCodeSkillReport> {
    const report = this.snapshot()
    await mkdir(dirname(this.reportPath), { recursive: true })
    await writeFile(this.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return report
  }

  private recordToolCall(event: Extract<AgentRunEvent, { type: 'tool-call' }>, sequence: number): void {
    const correlationId = String(event.call.callId)
    const callId = this.safe(correlationId)
    const toolName = this.safe(event.call.toolName)
    if (this.calls.has(correlationId)) this.problem(`duplicate tool call id ${callId}`)
    const parsed = parseObject(event.call.rawArguments)
    const rawSkillId = typeof parsed?.skillId === 'string' ? parsed.skillId : undefined
    const skillId = rawSkillId === undefined ? undefined : sanitizeSkillId(rawSkillId)
    const rawPath = typeof parsed?.path === 'string' ? parsed.path : undefined
    const resourcePath = rawPath === undefined ? undefined : this.safe(rawPath)
    let pending: PendingCall

    if (toolName === 'load_skill') {
      if (skillId === undefined) this.problem(`load_skill call ${callId} has no valid skillId`)
      const skill = skillId === undefined ? undefined : this.skill(skillId)
      if (skill !== undefined) {
        skill.loadAttempts++
        skill.firstLoadSequence ??= sequence
      }
      pending = { toolName, sequence, ...(skillId === undefined ? {} : { skillId }) }
    } else if (toolName === 'read_skill_resource' || toolName === 'search_skill_resources') {
      if (skillId === undefined) this.problem(`${toolName} call ${callId} has no valid skillId`)
      const skill = skillId === undefined ? undefined : this.skill(skillId)
      if (skill !== undefined) {
        skill.resourceAttempts++
        if (skill.instructionExposureRequests === 0) {
          this.problem(`${toolName} for '${skillId}' occurred before its instructions reached a model request`)
        }
      }
      pending = {
        toolName, sequence,
        ...(skillId === undefined ? {} : { skillId }),
        ...(resourcePath === undefined ? {} : { resourcePath }),
      }
    } else {
      pending = {
        toolName, sequence,
        ...isApplicationTool(toolName) ? {
          applicationSkills: Object.freeze([...this.pendingApplication]),
          resourceInformedSkills: Object.freeze([...this.pendingResourceApplication]),
        } : {},
      }
    }
    this.setBounded(this.calls, correlationId, pending, 'tool call')
    this.addTimeline({
      sequence, type: 'tool-call', run: this.runId(), turn: this.currentTurn,
      step: this.currentStep, traceId: this.safe(event.trace.traceId),
      spanId: this.safe(event.trace.spanId), callId, toolName,
      argumentChars: event.call.rawArguments.length,
      ...(pending.skillId === undefined ? {} : { skillId: pending.skillId }),
      ...(pending.resourcePath === undefined ? {} : { resourcePath: pending.resourcePath }),
    })
  }

  private recordToolResult(event: Extract<AgentRunEvent, { type: 'tool-result' }>, sequence: number): void {
    const correlationId = String(event.call.callId)
    const callId = this.safe(correlationId)
    const pending = this.calls.get(correlationId)
    this.calls.delete(correlationId)
    if (pending === undefined) this.problem(`tool result ${callId} has no retained matching call`)
    const toolName = pending?.toolName ?? this.safe(event.call.toolName)
    const succeeded = !event.result.isError
    const applicationSucceeded = isApplicationTool(toolName)
      ? isSuccessfulApplicationResult(toolName, event.result)
      : undefined
    if (toolName === 'load_skill' && pending?.skillId !== undefined) {
      const skill = this.skill(pending.skillId)
      if (skill !== undefined) {
        if (succeeded) {
          skill.successfulLoads++
          const exposure = { skillId: pending.skillId, sequence }
          const request = this.requestResults.get(correlationId)
          if (request === undefined) {
            this.setBounded(this.loadResults, correlationId, exposure, 'unexposed load result')
          } else {
            this.requestResults.delete(correlationId)
            this.exposeLoadResult(correlationId, exposure, request)
          }
        } else skill.failedLoads++
      }
      const metaSkill = skillIdFromMeta(event.result.meta)
      const metaSkillId = metaSkill === undefined ? undefined : sanitizeSkillId(metaSkill)
      if (metaSkill !== undefined && metaSkillId === undefined) {
        this.problem(`load_skill call ${callId} returned an invalid metadata skillId`)
      } else if (metaSkillId !== undefined && metaSkillId !== pending.skillId) {
        this.problem(`load_skill call ${callId} requested '${pending.skillId}' but result metadata named '${metaSkillId}'`)
      }
    } else if ((toolName === 'read_skill_resource' || toolName === 'search_skill_resources')
      && pending?.skillId !== undefined) {
      const skill = this.skill(pending.skillId)
      if (skill !== undefined && succeeded) {
        skill.successfulResourceCalls++
        const exposure = { skillId: pending.skillId, sequence }
        const request = this.requestResults.get(correlationId)
        if (request === undefined) {
          this.setBounded(this.resourceResults, correlationId, exposure, 'unexposed resource result')
        } else {
          this.requestResults.delete(correlationId)
          this.exposeResourceResult(correlationId, exposure, request)
        }
      }
    } else if (isApplicationTool(toolName) && pending !== undefined) {
      const candidates = pending.applicationSkills ?? []
      if (applicationSucceeded === true && candidates.length > 0) {
        this.successfulApplicationActions++
        for (const id of candidates) {
          const skill = this.skill(id)
          if (skill === undefined) continue
          skill.successfulApplicationActions++
          skill.applicationTools.add(toolName)
          skill.firstApplicationSequence ??= sequence
          this.pendingApplication.delete(id)
          if (pending.resourceInformedSkills?.includes(id) === true) {
            skill.resourceInformedActions++
            this.pendingResourceApplication.delete(id)
          }
        }
      } else if (applicationSucceeded === false) {
        for (const id of candidates) {
          const skill = this.skill(id)
          if (skill !== undefined) skill.failedApplicationAttempts++
        }
      }
    }
    this.addTimeline({
      sequence, type: 'tool-result', run: this.runId(), turn: this.currentTurn,
      step: this.currentStep, traceId: this.safe(event.trace.traceId),
      spanId: this.safe(event.trace.spanId), callId, toolName, succeeded,
      ...(applicationSucceeded === undefined ? {} : { applicationSucceeded }),
      ...(event.result.isError ? { errorCode: this.safe(event.result.error.code) } : {}),
      ...(pending?.skillId === undefined ? {} : { skillId: pending.skillId }),
      ...(pending?.resourcePath === undefined ? {} : { resourcePath: pending.resourcePath }),
    })
  }

  private recordNativeAction(toolName: string, sequence: number): void {
    const candidates = [...this.pendingApplication]
    if (candidates.length === 0) return
    const safeTool = `native:${this.safe(toolName)}`
    this.successfulApplicationActions++
    for (const id of candidates) {
      const skill = this.skill(id)
      if (skill === undefined) continue
      skill.successfulApplicationActions++
      skill.applicationTools.add(safeTool)
      skill.firstApplicationSequence ??= sequence
      this.pendingApplication.delete(id)
      if (this.pendingResourceApplication.delete(id)) skill.resourceInformedActions++
    }
    this.addTimeline({
      sequence, type: 'native-action', run: this.runId(), toolName: safeTool,
      appliedSkills: candidates,
    })
  }

  private exposeLoadResult(
    callId: string,
    pending: PendingExposure,
    request: PendingRequestResult,
  ): void {
    if (!request.skillMarkers.has(pending.skillId)) {
      this.problem(`load_skill result ${callId} reached a model request without the '${pending.skillId}' content marker`)
      return
    }
    const skill = this.skill(pending.skillId)
    if (skill === undefined) return
    skill.instructionExposureRequests++
    skill.firstInstructionExposureSequence ??= request.requestSequence
    this.pendingApplication.add(pending.skillId)
    this.addTimeline({
      sequence: this.nextSequence(), type: 'skill-instructions-observed', run: this.runId(),
      callId: this.safe(callId), skillId: pending.skillId,
      loadResultSequence: pending.sequence, requestSequence: request.requestSequence,
    })
  }

  private exposeResourceResult(
    callId: string,
    pending: PendingExposure,
    request: PendingRequestResult,
  ): void {
    if (request.textChars < 1) {
      this.problem(`skill resource result ${callId} reached a model request without text content`)
      return
    }
    const skill = this.skill(pending.skillId)
    if (skill === undefined) return
    skill.resourceExposureRequests++
    this.pendingApplication.add(pending.skillId)
    this.pendingResourceApplication.add(pending.skillId)
    this.addTimeline({
      sequence: this.nextSequence(), type: 'skill-resource-observed', run: this.runId(),
      callId: this.safe(callId), skillId: pending.skillId, textChars: request.textChars,
      resourceResultSequence: pending.sequence, requestSequence: request.requestSequence,
    })
  }

  private recordTrace(
    event: Extract<AgentRunEvent, { type: 'span-start' | 'span-end' }>,
    sequence: number,
  ): void {
    const spanId = this.safe(event.trace.spanId)
    if (event.type === 'span-start') {
      this.trace.started++
      if (this.openSpans.has(spanId) || this.recentlyEndedSpans.has(spanId)) {
        this.trace.duplicateStarts++
        this.problem(`duplicate span start ${spanId}`)
      }
      const parent = event.trace.parentSpanId === null ? null : this.safe(event.trace.parentSpanId)
      if (parent !== null && !this.openSpans.has(parent)) {
        this.trace.orphanStarts++
        this.problem(`span ${spanId} started without an open parent ${parent}`)
      }
      if (this.openSpans.size >= this.maxPendingRecords) {
        this.pendingRecordsOmitted++
        this.trace.auditComplete = false
      } else this.openSpans.set(spanId, parent)
    } else {
      this.trace.ended++
      if (this.recentlyEndedSpans.has(spanId)) {
        this.trace.duplicateEnds++
        this.problem(`duplicate span end ${spanId}`)
      } else if (!this.openSpans.delete(spanId)) {
        this.trace.endsWithoutStart++
        this.problem(`span ${spanId} ended without a retained start`)
      }
      addRecent(this.recentlyEndedSpans, spanId, this.maxPendingRecords)
    }
    this.addTimeline({
      sequence, type: event.type, run: this.runId(), traceId: this.safe(event.trace.traceId),
      spanId, ...(event.trace.parentSpanId === null
        ? {} : { parentSpanId: this.safe(event.trace.parentSpanId) }),
      ...(event.type === 'span-start'
        ? { kind: event.kind }
        : { status: event.status }),
    })
  }

  private skill(rawId: string, expected = false): MutableSkillEvidence | undefined {
    const id = sanitizeSkillId(rawId)
    if (id === undefined) {
      this.problem('invalid skill id was omitted')
      return undefined
    }
    const existing = this.skills.get(id)
    if (existing !== undefined) {
      if (expected) existing.expected = true
      return existing
    }
    if (this.skills.size >= this.maxTrackedSkills) {
      this.skillsOmitted++
      return undefined
    }
    const created: MutableSkillEvidence = {
      skillId: id, expected: expected || this.expected.has(id),
      loadAttempts: 0, successfulLoads: 0, failedLoads: 0,
      instructionExposureRequests: 0, resourceAttempts: 0,
      successfulResourceCalls: 0, resourceExposureRequests: 0,
      successfulApplicationActions: 0, failedApplicationAttempts: 0,
      resourceInformedActions: 0, applicationTools: new Set(),
      activationIoEvents: 0, activationBytesRead: 0,
      resourceIoEvents: 0, resourceBytesRead: 0,
    }
    this.skills.set(id, created)
    return created
  }

  private setBounded<T>(map: Map<string, T>, key: string, value: T, label: string): void {
    if (!map.has(key) && map.size >= this.maxPendingRecords) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest !== undefined) map.delete(oldest)
      this.pendingRecordsOmitted++
      this.problem(`${label} tracking exceeded ${this.maxPendingRecords}; oldest record was omitted`)
    }
    map.set(key, value)
  }

  private setBoundedQuietly<T>(map: Map<string, T>, key: string, value: T): void {
    if (!map.has(key) && map.size >= this.maxPendingRecords) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest !== undefined) map.delete(oldest)
      this.pendingRecordsOmitted++
    }
    map.set(key, value)
  }

  private problem(message: string): void {
    if (this.problems.length >= this.maxProblems) {
      this.problemsOmitted++
      return
    }
    this.problems.push(this.safe(message))
  }

  private addTimeline(entry: Readonly<Record<string, unknown>>): void {
    if (this.timeline.length >= this.maxTimelineEntries) {
      this.timelineOmitted++
      return
    }
    this.timeline.push(Object.freeze(stripUndefined(entry)))
  }

  private nextSequence(): number { return ++this.sequence }
  private runId(): string { return this.activeRun?.id ?? 'unscoped' }
  private safe(value: string): string { return redact(value, this.maxStringChars) }
}

/** Merge recorder checkpoints with existing steering/memory hooks. */
export function withAgentCodeSkillReportHooks(
  recorder: AgentCodeSkillReportRecorder,
  hooks: TurnHooks | undefined,
): TurnHooks {
  return {
    ...hooks,
    checkpoint: async context => {
      await hooks?.checkpoint?.(context)
      recorder.recordCheckpoint(context)
    },
  }
}

function freezeEvidence(skill: MutableSkillEvidence): AgentCodeSkillEvidence {
  const status = statusOf(skill)
  return Object.freeze({
    skillId: skill.skillId,
    expected: skill.expected,
    status,
    loadAttempts: skill.loadAttempts,
    successfulLoads: skill.successfulLoads,
    failedLoads: skill.failedLoads,
    instructionExposureRequests: skill.instructionExposureRequests,
    resourceAttempts: skill.resourceAttempts,
    successfulResourceCalls: skill.successfulResourceCalls,
    resourceExposureRequests: skill.resourceExposureRequests,
    successfulApplicationActions: skill.successfulApplicationActions,
    failedApplicationAttempts: skill.failedApplicationAttempts,
    resourceInformedActions: skill.resourceInformedActions,
    activationIoEvents: skill.activationIoEvents,
    activationBytesRead: skill.activationBytesRead,
    resourceIoEvents: skill.resourceIoEvents,
    resourceBytesRead: skill.resourceBytesRead,
    applicationTools: Object.freeze([...skill.applicationTools].sort()),
    ...(skill.firstLoadSequence === undefined ? {} : { firstLoadSequence: skill.firstLoadSequence }),
    ...(skill.firstInstructionExposureSequence === undefined
      ? {} : { firstInstructionExposureSequence: skill.firstInstructionExposureSequence }),
    ...(skill.firstApplicationSequence === undefined
      ? {} : { firstApplicationSequence: skill.firstApplicationSequence }),
  })
}

function statusOf(skill: MutableSkillEvidence): SkillEvidenceStatus {
  if (skill.resourceInformedActions > 0) return 'resource-informed'
  if (skill.successfulApplicationActions > 0) return 'behaviorally-applied'
  if (skill.instructionExposureRequests > 0) return 'instructions-in-context'
  if (skill.successfulLoads > 0) return 'loaded'
  if (skill.failedLoads > 0) return 'load-failed'
  return 'not-loaded'
}

function isApplied(status: SkillEvidenceStatus): boolean {
  return status === 'behaviorally-applied' || status === 'resource-informed'
}

function isApplicationTool(toolName: string): boolean {
  if (SKILL_TOOLS.has(toolName) || CONTROL_TOOLS.has(toolName)) return false
  return MATERIAL_AGENTCODE_TOOLS.has(toolName)
}

function isSuccessfulApplicationResult(
  toolName: string,
  result: ToolExecutionResult,
): boolean {
  if (result.isError) return false
  if (toolName !== 'run_command') return true
  if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return false
  }
  const value = result.value as Readonly<Record<string, unknown>>
  const didNotTimeOut = value.timedOut === undefined || value.timedOut === false
  return value.exitCode === 0 && didNotTimeOut
}

function isSuccessfulNativeStatus(status: string | undefined): boolean {
  return status !== undefined && SUCCESSFUL_NATIVE_STATUSES.has(status.trim().toLocaleLowerCase('en-US'))
}

function skillIdFromMeta(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const skillId = (meta as Record<string, unknown>).skillId
  return typeof skillId === 'string' ? skillId : undefined
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}

interface ToolResultInspection {
  textChars: number
  skillMarkers: Set<string>
}

function inspectModelMessages(messages: readonly Message[]): {
    toolResults: Map<string, ToolResultInspection>
    skillMarkers: Set<string>
  } {
  const toolResults = new Map<string, ToolResultInspection>()
  const skillMarkers = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      let textChars = 0
      const markers = new Set<string>()
      visitText(block.content, text => {
        textChars += text.length
        for (const id of skillMarkersOf(text)) {
          markers.add(id)
          skillMarkers.add(id)
        }
      })
      toolResults.set(String(block.toolCallId), { textChars, skillMarkers: markers })
    }
  }
  return { toolResults, skillMarkers }
}

function visitText(
  blocks: readonly ContentBlock[],
  visit: (text: string) => void,
  depth = 0,
): void {
  if (depth >= 6) return
  for (const block of blocks.slice(0, 1_000)) {
    if (block.type === 'text' || block.type === 'reasoning') visit(block.text)
    else if (block.type === 'tool-result') visitText(block.content, visit, depth + 1)
    else if (block.type === 'native-tool-call') visitText(block.content, visit, depth + 1)
  }
}

function skillMarkersOf(text: string): readonly string[] {
  const ids: string[] = []
  const pattern = /<skill_content\s+id="([^"]+)">/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null && ids.length < 128) {
    const id = match[1] === undefined ? undefined : sanitizeSkillId(match[1])
    if (id !== undefined) ids.push(id)
  }
  return ids
}

function sanitizeSkillId(input: string): string | undefined {
  return input.length <= MAX_SKILL_ID_CHARS && SKILL_ID_PATTERN.test(input)
    ? input
    : undefined
}

function redact(input: string, maxChars: number): string {
  const redacted = input
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu, 'Bearer <redacted>')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}/giu, '<redacted-token>')
    .replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s]+/giu, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, '$1<redacted>')
  return redacted.length <= maxChars
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxChars - 24))}... <${redacted.length} chars>`
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function addRecent(set: Set<string>, value: string, limit: number): void {
  set.delete(value)
  set.add(value)
  if (set.size <= limit) return
  const oldest = set.values().next().value as string | undefined
  if (oldest !== undefined) set.delete(oldest)
}

function stripUndefined(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}
