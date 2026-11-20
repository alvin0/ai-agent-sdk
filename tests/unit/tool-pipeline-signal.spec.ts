import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

function unhandledRejections(source: string): unknown {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(String(error)));
    ${source}
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify(unhandled));
  `], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', windowsHide: true })
  return JSON.parse(output) as unknown
}

it('observes a tool promise rejected after cancellation has already won', () => {
  expect(unhandledRejections(`
    import { raceWithSignal } from './packages/core/dist/agent/tool/pipeline-support.js';
    const controller = new AbortController();
    controller.abort();
    await raceWithSignal(Promise.reject(new Error('tool failure')), controller.signal).catch(() => {});
  `)).toEqual([])
})

it('observes an approval rejection while its request event is backpressured', () => {
  expect(unhandledRejections(`
    import { approveToolCall } from './packages/core/dist/agent/tool/pipeline-authorization.js';
    const controller = new AbortController();
    const prepared = {
      options: {
        position: { turn: 1, step: 1 },
        approvals: { request: () => Promise.reject(new Error('approval broker failed')) },
        onApprovalRequest: () => new Promise(resolve => setImmediate(resolve)),
      },
      context: { callId: 'call_1', toolName: 't', args: {}, turn: 1, step: 1, signal: controller.signal },
    };
    await approveToolCall(prepared, { kind: 'ask' }).catch(() => {});
  `)).toEqual([])
})
