import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { WorkerRuntime } from './managed-types.ts'
import {
  assertDependencyOffset,
} from './managed-validation.ts'
import {
  prefixWithinBytes,
} from './managed-report-text.ts'

export function managedDependencyReadTool(
  dependencies: readonly WorkerRuntime[], maxReportBytes: number,
): ToolDefinition {
  const scope = new Map(dependencies.map(runtime => [runtime.request.name, runtime.evidence]))
  return defineTool({
    name: 'read_dependency_result',
    description: 'Read a bounded page from an original dependency result, including after closure. '
      + 'Full handoffs already contain the same result. Use nextOffset until null; '
      + 'partial/failed results are not completed work.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, offset: { type: 'integer',
      minimum: 0 } }, required: ['name'], additionalProperties: false },
    parse(raw: unknown) {
      if (typeof raw !== 'object' || raw === null) throw new TypeError('dependency name and offset required')
      const name = Reflect.get(raw, 'name'), offset = Reflect.get(raw, 'offset') ?? 0
      if (typeof name !== 'string' || !Number.isSafeInteger(offset)
        || offset < 0) throw new TypeError('invalid dependency name or offset')
      return { name, offset: offset as number }
    },
    execute: ({ name, offset }) => {
      const producer = scope.get(name)
      if (producer === undefined) throw new Error('this worker was not commissioned against that dependency')
      const text = producer.result?.text ?? ''
      assertDependencyOffset(text, offset)
      // Offsets count UTF-16 code units, returned pages stay within the byte cap.
      const page = prefixWithinBytes(text.slice(offset), maxReportBytes)
      const next = offset + page.length
      return { name, status: producer.status, succeeded: producer.result?.succeeded ?? false,
        ...(producer.error === undefined ? {} : { error: producer.error }), text: page,
        nextOffset: next < text.length ? next : null }
    },
    isConcurrencySafe: () => true,
  })
}
