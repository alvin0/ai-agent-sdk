import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { History } from '../../src/agent/history/history.ts'
import type { AgentRunEvent } from '../../src/agent/mode/run-agent.ts'
import type { ToolExecutionResult } from '../../src/agent/tool/definition.ts'
import { createSpanId, createTraceId, type TraceRef } from '../../src/agent/trace/trace.ts'
import type { GenerateOptions } from '../../src/core/contract/generate-options.ts'
import { createToolResultMessage } from '../../src/core/message/message.ts'
import { MessageId, ToolCallId } from '../../src/core/primitives/brand.ts'
import {
  AgentCodeSkillReportRecorder,
  isAgentCodeSkillEvidenceComplete,
  withAgentCodeSkillReportHooks,
} from '../../test-human/agentcode/skill-report.ts'

const trace: TraceRef = { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null }

describe('agentcode skill report', () => {
  it('requires model exposure and successful downstream work before proving multi-skill use', () => {
    const recorder = report(['systematic-debugging', 'react-best-practices'])

    recorder.recordEvent(call('load-a', 'load_skill', { skillId: 'systematic-debugging' }))
    recorder.recordEvent(result('load-a', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'systematic-debugging', resourcePath: null,
    })))
    recorder.recordCheckpoint(checkpoint([
      toolMessage('load-a', '<skill_content id="systematic-debugging">\n<skill_instructions>debug</skill_instructions>\n</skill_content>'),
    ]))
    recorder.recordEvent(call('resource-a', 'read_skill_resource', {
      skillId: 'systematic-debugging', path: 'references/checklist.md?token=token-super-secret',
    }))
    recorder.recordEvent(result('resource-a', 'read_skill_resource', ok('resource text', {
      kind: 'skill', skillId: 'systematic-debugging', resourcePath: 'references/checklist.md',
    })))
    recorder.recordCheckpoint(checkpoint([toolMessage('resource-a', '# Checklist\nReproduce first.')]))
    recorder.recordEvent(call('work-a', 'write_file', {
      path: 'src/fix.ts', content: 'API_KEY=sk-super-secret-value',
    }))
    recorder.recordEvent(result('work-a', 'write_file', ok({ path: 'src/fix.ts' })))

    recorder.recordEvent(call('load-b', 'load_skill', { skillId: 'react-best-practices' }))
    recorder.recordEvent(result('load-b', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'react-best-practices', resourcePath: null,
    })))
    recorder.recordCheckpoint(checkpoint([
      toolMessage('load-b', '<skill_content id="react-best-practices">\n<skill_instructions>measure renders</skill_instructions>\n</skill_content>'),
    ]))
    recorder.recordEvent(call('work-b', 'run_command', { command: 'npm test' }))
    recorder.recordEvent(result('work-b', 'run_command', ok({ exitCode: 0, stdout: 'secret output' })))

    const snapshot = recorder.snapshot()
    expect(snapshot.summary).toMatchObject({
      skillsLoaded: 2,
      skillsInstructionExposed: 2,
      skillsBehaviorallyApplied: 2,
      skillsResourceInformed: 1,
      allExpectedSkillsBehaviorallyApplied: true,
      multipleSkillsBehaviorallyApplied: true,
      successfulApplicationActions: 2,
    })
    expect(snapshot.skills).toEqual([
      expect.objectContaining({
        skillId: 'systematic-debugging', status: 'resource-informed',
        resourceExposureRequests: 1, resourceInformedActions: 1,
        applicationTools: ['write_file'],
      }),
      expect.objectContaining({
        skillId: 'react-best-practices', status: 'behaviorally-applied',
        applicationTools: ['run_command'],
      }),
    ])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('sk-super-secret-value')
    expect(serialized).not.toContain('secret output')
    expect(serialized).not.toContain('token-super-secret')
    expect(serialized).toContain('token=<redacted>')
  })

  it('does not treat same-response calls, failures, or load-only behavior as application', () => {
    const recorder = report(['incident-triage'])
    recorder.recordEvent(call('load', 'load_skill', { skillId: 'incident-triage' }))
    // The action was chosen in the same provider response, before the model could
    // possibly see the load result. It must not be attributed to the skill.
    recorder.recordEvent(call('premature-work', 'write_file', { path: 'triage.md', content: 'draft' }))
    recorder.recordEvent(result('load', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'incident-triage', resourcePath: null,
    })))
    recorder.recordEvent(result('premature-work', 'write_file', ok({ path: 'triage.md' })))
    recorder.recordEvent(call('premature-resource', 'read_skill_resource', {
      skillId: 'incident-triage', path: 'references/severity.md',
    }))
    recorder.recordEvent(result('premature-resource', 'read_skill_resource', ok('severity table')))
    recorder.recordCheckpoint(checkpoint([
      toolMessage('load', '<skill_content id="incident-triage">instructions</skill_content>'),
      toolMessage('premature-resource', 'severity table'),
    ]))
    recorder.recordEvent(call('failed-work', 'write_file', { path: 'triage.md', content: 'retry' }))
    recorder.recordEvent(result('failed-work', 'write_file', failure('disk full')))

    const snapshot = recorder.snapshot()
    expect(snapshot.summary).toMatchObject({
      skillsBehaviorallyApplied: 0,
      multipleSkillsBehaviorallyApplied: false,
      successfulApplicationActions: 0,
    })
    expect(snapshot.skills[0]).toMatchObject({
      status: 'instructions-in-context',
      successfulApplicationActions: 0,
      failedApplicationAttempts: 1,
      resourceExposureRequests: 1,
    })
    expect(snapshot.problems.join('\n')).toContain('before its instructions reached a model request')
  })

  it('ignores inspection and unknown app tools without consuming pending attribution', () => {
    const recorder = report(['systematic-debugging'])
    recorder.recordEvent(call('load', 'load_skill', { skillId: 'systematic-debugging' }))
    recorder.recordEvent(result('load', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'systematic-debugging', resourcePath: null,
    })))
    recorder.recordCheckpoint(checkpoint([
      toolMessage('load', '<skill_content id="systematic-debugging">instructions</skill_content>'),
    ]))
    recorder.recordEvent(call('resource', 'read_skill_resource', {
      skillId: 'systematic-debugging', path: 'references/checklist.md',
    }))
    recorder.recordEvent(result('resource', 'read_skill_resource', ok('check hypotheses')))
    recorder.recordCheckpoint(checkpoint([toolMessage('resource', 'check hypotheses')]))

    for (const [callId, toolName] of [
      ['inspect-list', 'list_files'],
      ['inspect-read', 'read_file'],
      ['inspect-grep', 'grep_files'],
      ['unknown-app', 'deploy_preview'],
    ] as const) {
      recorder.recordEvent(call(callId, toolName, {}))
      recorder.recordEvent(result(callId, toolName, ok({ observed: true })))
    }

    expect(recorder.snapshot()).toMatchObject({
      summary: {
        successfulApplicationActions: 0,
        skillsBehaviorallyApplied: 0,
        skillsResourceInformed: 0,
      },
      skills: [{
        skillId: 'systematic-debugging',
        status: 'instructions-in-context',
        successfulApplicationActions: 0,
        resourceInformedActions: 0,
        applicationTools: [],
      }],
    })

    // Inspection and unknown tools left both pending evidence sets intact, so
    // the next allowlisted material action receives instruction and resource attribution.
    recorder.recordEvent(call('material-work', 'replace_in_file', {
      path: 'src/store.ts', oldText: 'broken', newText: 'fixed',
    }))
    recorder.recordEvent(result('material-work', 'replace_in_file', ok({ replacements: 1 })))

    expect(recorder.snapshot()).toMatchObject({
      summary: {
        successfulApplicationActions: 1,
        skillsBehaviorallyApplied: 1,
        skillsResourceInformed: 1,
      },
      skills: [{
        skillId: 'systematic-debugging',
        status: 'resource-informed',
        successfulApplicationActions: 1,
        resourceInformedActions: 1,
        applicationTools: ['replace_in_file'],
      }],
    })
  })

  it('requires an explicit successful status before a native action proves application', () => {
    const recorder = report(['web-research'])
    recorder.recordEvent(call('load', 'load_skill', { skillId: 'web-research' }))
    recorder.recordEvent(result('load', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'web-research', resourcePath: null,
    })))
    recorder.recordCheckpoint(checkpoint([
      toolMessage('load', '<skill_content id="web-research">instructions</skill_content>'),
    ]))

    for (const [id, status] of [
      ['native-unknown', undefined],
      ['native-running', 'in_progress'],
      ['native-failed', 'failed'],
    ] as const) {
      recorder.recordEvent(native(id, 'web-search', status))
    }
    expect(recorder.snapshot().skills[0]).toMatchObject({
      status: 'instructions-in-context',
      successfulApplicationActions: 0,
      applicationTools: [],
    })

    recorder.recordEvent(native('native-complete', 'web-search', 'completed'))
    const snapshot = recorder.snapshot()
    expect(snapshot.skills[0]).toMatchObject({
      status: 'behaviorally-applied',
      successfulApplicationActions: 1,
      applicationTools: ['native:web-search'],
    })
    expect(snapshot.proofLimits).toEqual(expect.arrayContaining([
      expect.stringContaining('successful material action'),
      expect.stringContaining('unknown app tools are conservatively ignored'),
    ]))
  })

  it('reconciles a checkpoint that races ahead of tool-result event consumption', () => {
    const recorder = report(['race-safe-skill'])
    recorder.recordEvent(call('race-load', 'load_skill', { skillId: 'race-safe-skill' }))
    // The producer can invoke this hook after queue.take() but before the outer
    // observer resumes and records the already-emitted tool-result event.
    recorder.recordCheckpoint(checkpoint([
      toolMessage('race-load', '<skill_content id="race-safe-skill">instructions</skill_content>'),
    ]))
    recorder.recordEvent(result('race-load', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'race-safe-skill', resourcePath: null,
    })))
    recorder.recordEvent(call('race-work', 'run_command', { command: 'npm test' }))
    recorder.recordEvent(result('race-work', 'run_command', ok({ exitCode: 0 })))

    expect(recorder.snapshot().skills[0]).toMatchObject({
      status: 'behaviorally-applied',
      instructionExposureRequests: 1,
      successfulApplicationActions: 1,
    })
  })

  it('requires run_command to exit zero without timing out before proving application', () => {
    const recorder = report(['command-discipline'])
    recorder.recordEvent(call('load', 'load_skill', { skillId: 'command-discipline' }))
    recorder.recordEvent(result('load', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'command-discipline', resourcePath: null,
    })))
    recorder.recordCheckpoint(checkpoint([
      toolMessage('load', '<skill_content id="command-discipline">instructions</skill_content>'),
    ]))

    for (const [callId, value] of [
      ['nonzero', { exitCode: 1, timedOut: false }],
      ['timeout', { exitCode: 0, timedOut: true }],
      ['malformed-exit', { exitCode: '0', timedOut: false }],
      ['malformed-timeout', { exitCode: 0, timedOut: 'false' }],
    ] as const) {
      recorder.recordEvent(call(callId, 'run_command', { command: 'npm test' }))
      recorder.recordEvent(result(callId, 'run_command', ok(value)))
    }

    expect(recorder.snapshot()).toMatchObject({
      summary: {
        successfulApplicationActions: 0,
        skillsBehaviorallyApplied: 0,
      },
      skills: [{
        skillId: 'command-discipline',
        status: 'instructions-in-context',
        successfulApplicationActions: 0,
        failedApplicationAttempts: 4,
        applicationTools: [],
      }],
    })
    expect(recorder.snapshot().timeline.filter(entry =>
      entry.type === 'tool-result' && entry.toolName === 'run_command')).toEqual([
      expect.objectContaining({ callId: 'nonzero', succeeded: true, applicationSucceeded: false }),
      expect.objectContaining({ callId: 'timeout', succeeded: true, applicationSucceeded: false }),
      expect.objectContaining({ callId: 'malformed-exit', succeeded: true, applicationSucceeded: false }),
      expect.objectContaining({ callId: 'malformed-timeout', succeeded: true, applicationSucceeded: false }),
    ])

    // A failed command must not consume pending attribution: the corrected retry
    // is the first action that may prove the skill was behaviorally applied.
    recorder.recordEvent(call('fixed', 'run_command', { command: 'npm test' }))
    recorder.recordEvent(result('fixed', 'run_command', ok({ exitCode: 0, timedOut: false })))

    expect(recorder.snapshot()).toMatchObject({
      summary: {
        successfulApplicationActions: 1,
        skillsBehaviorallyApplied: 1,
      },
      skills: [{
        skillId: 'command-discipline',
        status: 'behaviorally-applied',
        successfulApplicationActions: 1,
        failedApplicationAttempts: 4,
        applicationTools: ['run_command'],
      }],
    })
  })

  it('preserves structurally valid skill ids that resemble secret prefixes', () => {
    const recorder = report(['token-management', 'key-rotation'])

    for (const [callId, skillId] of [
      ['load-a', 'token-management'],
      ['load-b', 'key-rotation'],
    ] as const) {
      recorder.recordEvent(call(callId, 'load_skill', { skillId }))
      recorder.recordEvent(result(callId, 'load_skill', ok('loaded', {
        kind: 'skill', skillId, resourcePath: null,
      })))
      recorder.recordCheckpoint(checkpoint([
        toolMessage(callId, `<skill_content id="${skillId}">instructions</skill_content>`),
      ]))
    }

    recorder.recordEvent(call('work', 'write_file', { path: 'result.md', content: 'done' }))
    recorder.recordEvent(result('work', 'write_file', ok({ path: 'result.md' })))

    const snapshot = recorder.snapshot()
    expect(snapshot.summary).toMatchObject({
      expectedSkills: 2,
      expectedSkillsBehaviorallyApplied: 2,
      allExpectedSkillsBehaviorallyApplied: true,
    })
    expect(snapshot.skills).toEqual([
      expect.objectContaining({
        skillId: 'token-management', expected: true, status: 'behaviorally-applied',
      }),
      expect.objectContaining({
        skillId: 'key-rotation', expected: true, status: 'behaviorally-applied',
      }),
    ])
    expect(JSON.stringify(snapshot)).not.toContain('<redacted-token>')
  })

  it('correlates raw secret-like call ids while redacting only serialized evidence', () => {
    const recorder = report(['first-skill', 'second-skill'])
    const loads = [
      { callId: 'token-super-secret', skillId: 'first-skill' },
      { callId: 'token-other-secret', skillId: 'second-skill' },
    ] as const

    // Both ids redact to the same display value. Internal correlation must not
    // treat them as duplicates or let the second call overwrite the first.
    for (const { callId, skillId } of loads) {
      recorder.recordEvent(call(callId, 'load_skill', { skillId }))
    }
    for (const { callId, skillId } of loads) {
      recorder.recordEvent(result(callId, 'load_skill', ok('loaded', {
        kind: 'skill', skillId, resourcePath: null,
      })))
    }
    recorder.recordCheckpoint(checkpoint(loads.map(({ callId, skillId }) =>
      toolMessage(callId, `<skill_content id="${skillId}">instructions</skill_content>`))))
    recorder.recordEvent(call('work', 'write_file', { path: 'result.md', content: 'done' }))
    recorder.recordEvent(result('work', 'write_file', ok({ path: 'result.md' })))

    const snapshot = recorder.snapshot()
    expect(snapshot.summary).toMatchObject({
      skillsInstructionExposed: 2,
      expectedSkillsBehaviorallyApplied: 2,
      allExpectedSkillsBehaviorallyApplied: true,
    })
    expect(snapshot.problems).toEqual([])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).toContain('<redacted-token>')
    expect(serialized).not.toContain('token-super-secret')
    expect(serialized).not.toContain('token-other-secret')
  })

  it('rejects incomplete or omitted evidence from release acceptance', () => {
    const recorder = report(['release-skill'])
    recorder.recordEvent(call('load', 'load_skill', { skillId: 'release-skill' }))
    recorder.recordEvent(result('load', 'load_skill', ok('loaded', {
      kind: 'skill', skillId: 'release-skill', resourcePath: null,
    })))
    recorder.recordCheckpoint(checkpoint([
      toolMessage('load', '<skill_content id="release-skill">instructions</skill_content>'),
    ]))
    recorder.recordEvent(call('work', 'write_file', { path: 'result.md', content: 'done' }))
    recorder.recordEvent(result('work', 'write_file', ok({ path: 'result.md' })))

    const complete = recorder.snapshot()
    expect(isAgentCodeSkillEvidenceComplete(complete)).toBe(true)
    expect(isAgentCodeSkillEvidenceComplete({
      ...complete,
      summary: { ...complete.summary, allExpectedSkillsBehaviorallyApplied: false },
    })).toBe(false)
    expect(isAgentCodeSkillEvidenceComplete({
      ...complete,
      summary: { ...complete.summary, orderProblems: 1 },
    })).toBe(false)
    expect(isAgentCodeSkillEvidenceComplete({
      ...complete,
      problems: ['correlation failed'],
    })).toBe(false)

    for (const key of ['timelineEntries', 'problems', 'skills', 'pendingRecords'] as const) {
      expect(isAgentCodeSkillEvidenceComplete({
        ...complete,
        omitted: { ...complete.omitted, [key]: 1 },
      }), key).toBe(false)
    }
  })

  it('passes streams through, composes hooks, bounds output, and reports trace integrity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentcode-skill-report-'))
    const path = join(directory, 'nested', 'report.json')
    try {
      const recorder = new AgentCodeSkillReportRecorder({
        reportPath: path,
        expectedSkillIds: ['expected-skill'],
        maxTimelineEntries: 4,
        maxProblems: 2,
        now: () => '2026-08-31T00:00:00.000Z',
      })
      recorder.recordSkillIo({
        phase: 'discovery', operation: 'scan', path: 'C:/private/secret/skills',
        bytesRead: 0, entriesScanned: 12,
      })
      recorder.recordSkillIo({
        phase: 'activation', operation: 'read', path: 'C:/private/secret/SKILL.md',
        skillId: 'expected-skill', bytesRead: 1_024,
      })
      recorder.recordSkillIo({
        phase: 'resource', operation: 'read', path: 'C:/private/secret/reference.md',
        skillId: 'expected-skill', bytesRead: 512,
      })
      const root: TraceRef = { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null }
      const child: TraceRef = { traceId: root.traceId, spanId: createSpanId(), parentSpanId: root.spanId }
      const events: AgentRunEvent[] = [
        { type: 'span-start', trace: root, at: '2026-08-31T00:00:00.000Z', name: 'root', kind: 'invoke_agent' },
        { type: 'span-start', trace: child, at: '2026-08-31T00:00:00.001Z', name: 'chat', kind: 'chat' },
        { type: 'span-end', trace: child, at: '2026-08-31T00:00:00.002Z', status: 'success' },
        { type: 'span-end', trace: root, at: '2026-08-31T00:00:00.003Z', status: 'success' },
      ]
      const passed: AgentRunEvent[] = []
      for await (const event of recorder.observe(iterate(events), 'long-run')) passed.push(event)
      expect(passed).toEqual(events)

      const baseCheckpoint = vi.fn()
      const hooks = withAgentCodeSkillReportHooks(recorder, { checkpoint: baseCheckpoint })
      await hooks.checkpoint?.(checkpoint([]))
      expect(baseCheckpoint).toHaveBeenCalledOnce()

      const snapshot = await recorder.flush()
      expect(snapshot.generatedAt).toBe('2026-08-31T00:00:00.000Z')
      expect(snapshot.summary.trace).toEqual({
        spansStarted: 2, spansEnded: 2, openSpans: 0,
        duplicateStarts: 0, duplicateEnds: 0, endsWithoutStart: 0,
        orphanStarts: 0, auditComplete: true,
      })
      expect(snapshot.summary).toMatchObject({
        skillIoEvents: 3, skillIoBytesRead: 1_536,
        discoveryIoEvents: 1, activationIoEvents: 1, resourceIoEvents: 1,
      })
      expect(snapshot.skills[0]).toMatchObject({
        activationIoEvents: 1, activationBytesRead: 1_024,
        resourceIoEvents: 1, resourceBytesRead: 512,
      })
      expect(snapshot.timeline).toHaveLength(4)
      expect(snapshot.omitted.timelineEntries).toBeGreaterThan(0)
      const serialized = await readFile(path, 'utf8')
      expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 2 })
      expect(serialized).not.toContain('C:/private/secret')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function report(expectedSkillIds: readonly string[]): AgentCodeSkillReportRecorder {
  return new AgentCodeSkillReportRecorder({
    reportPath: 'unused/report.json', expectedSkillIds,
    now: () => '2026-08-31T00:00:00.000Z',
  })
}

function call(callId: string, toolName: string, args: unknown): AgentRunEvent {
  return {
    type: 'tool-call', trace,
    call: { callId: ToolCallId(callId), toolName, rawArguments: JSON.stringify(args) },
  }
}

function result(
  callId: string,
  toolName: string,
  toolResult: ToolExecutionResult,
): AgentRunEvent {
  return {
    type: 'tool-result', trace,
    call: { callId: ToolCallId(callId), toolName, rawArguments: '{}' },
    result: toolResult,
  }
}

function native(
  id: string,
  name: string,
  status: string | undefined,
): AgentRunEvent {
  return {
    type: 'assistant-native-tool', trace,
    messageId: MessageId(`message-${id}`),
    call: {
      type: 'native-tool-call', id, name, content: [],
      ...(status === undefined ? {} : { status }),
    },
  }
}

function ok(
  value: string | Record<string, unknown>,
  meta?: Record<string, string | null>,
): ToolExecutionResult {
  return {
    isError: false,
    value: value as never,
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(meta === undefined ? {} : { meta }),
  }
}

function failure(message: string): ToolExecutionResult {
  return {
    isError: true,
    error: { message, code: 'FAILED' },
    content: [{ type: 'text', text: message }],
  }
}

function checkpoint(messages: GenerateOptions['messages']): Extract<
  Parameters<AgentCodeSkillReportRecorder['recordCheckpoint']>[0],
  { kind: 'before-model-request' }
> {
  return {
    kind: 'before-model-request',
    request: {
      provider: 'codex', model: 'gpt-5.6-luna', system: '<available_skills>metadata only</available_skills>',
      messages,
    },
    snapshot: new History().snapshot(),
  }
}

function toolMessage(callId: string, text: string) {
  return createToolResultMessage({
    callId: ToolCallId(callId), content: [{ type: 'text', text }], isError: false,
  })
}

async function * iterate(events: readonly AgentRunEvent[]): AsyncIterable<AgentRunEvent> {
  for (const event of events) yield event
}
