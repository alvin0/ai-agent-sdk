import { expect, it, vi } from 'vitest'
import { FetchObservationExporter } from '@alvin0/ai-agent-sdk-observability-fetch'
import { batch, injectedFetch } from './observability-fetch-fixtures.ts'

it('cancels the acknowledgment body when its reader is aborted', async () => {
  const cancel = vi.fn()
  const controller = new AbortController()
  const exporter = new FetchObservationExporter({
    endpoint: 'https://telemetry.example.test', maxAttempts: 1,
    fetch: injectedFetch(async () => new Response(new ReadableStream({ cancel }))),
  })
  const rejected = expect(exporter.export(batch(), controller.signal)).rejects.toThrow('host stopped')
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort(new Error('host stopped'))
  await rejected
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('cancels a response that arrives after its export was aborted', async () => {
  let respond!: (response: Response) => void
  const cancel = vi.fn()
  const controller = new AbortController()
  const exporter = new FetchObservationExporter({
    endpoint: 'https://telemetry.example.test', maxAttempts: 1,
    fetch: injectedFetch(() => new Promise(resolve => { respond = resolve })),
  })
  const rejected = expect(exporter.export(batch(), controller.signal)).rejects.toThrow('host stopped')
  controller.abort(new Error('host stopped'))
  await rejected
  respond(new Response(new ReadableStream({ cancel })))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(cancel).toHaveBeenCalledTimes(1)
})
