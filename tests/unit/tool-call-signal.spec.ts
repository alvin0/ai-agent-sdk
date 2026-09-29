import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('observes a pending rejection even when its cancellation signal is already aborted', () => {
  // Isolate process-level rejection handling so the oracle is independent of
  // Vitest's own unhandled-rejection listener.
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { raceWithSignal } from './packages/core/dist/agent/loop/tool-call-support.js';
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(String(error)));
    const controller = new AbortController(); controller.abort();
    await raceWithSignal(Promise.reject(new Error('late host failure')), controller.signal).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify(unhandled));
  `], { encoding: 'utf8', windowsHide: true })
  expect(JSON.parse(output)).toEqual([])
})
