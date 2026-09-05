import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CheckpointContext } from '@ai-agent-sdk/core/agent'
import type { FileSystemSkillIoEvent } from '@ai-agent-sdk/skill-filesystem'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import type { AgentCodeSkillReport, AgentCodeSkillReportOptions, AgentCodeSkillReportSummary, MutableSkillEvidence, PendingCall, PendingExposure, PendingRequestResult, RunObservation, TraceCounters } from './types.ts'
import { freezeEvidence, isApplied, isApplicationTool, isSuccessfulApplicationResult, isSuccessfulNativeStatus, parseObject, positiveInteger, redact, sanitizeSkillId, skillIdFromMeta, inspectModelMessages, nonNegative, addRecent, stripUndefined } from './helpers.ts'
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
