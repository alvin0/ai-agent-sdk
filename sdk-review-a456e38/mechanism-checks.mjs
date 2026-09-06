/**
 * Controlled JavaScript mechanism checks for a456e38.
 * IMPORTANT: These are reduced models of source control flow, not imports of the
 * SDK. Passing means the described mechanism was reproduced, NOT that the SDK
 * passes its regression tests. No network, credentials, model calls or writes
 * outside the requested JSON result file are needed.
 * Run: node mechanism-checks.mjs [results.json]
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function observe(promise, ms = 80) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ state: 'resolved', value }), error => ({ state: 'rejected', error: String(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'pending' }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
  });
}

const results = [];
async function check(id, name, fn) {
  try { results.push({ id, name, reproduced: true, ...(await fn()) }); }
  catch (error) { results.push({ id, name, reproduced: false, error: String(error) }); }
}

await check('M01', 'Endpoint validator waits before the timeout is created', async () => {
  const validation = deferred();
  let deadlineCreated = false, fetchCalls = 0;
  // Same await/timeout ordering as createGuardedMcpFetch.
  async function reducedGuard() {
    await validation.promise;
    deadlineCreated = true;
    const signal = AbortSignal.timeout(20);
    fetchCalls++;
    return signal.aborted;
  }
  const pending = reducedGuard();
  const actual = await observe(pending);
  assert.equal(actual.state, 'pending');
  assert.equal(deadlineCreated, false);
  assert.equal(fetchCalls, 0);
  const fixed = withAbort(new Promise(() => {}), AbortSignal.timeout(20));
  const control = await observe(fixed);
  assert.equal(control.state, 'rejected');
  // Release the synthetic callback; leave no outstanding work owned by the test.
  validation.resolve();
  await pending;
  return { actual: { ...actual, deadlineCreatedAtObservation: false, fetchCallsAtObservation: 0 }, control };
});

await check('M02', 'Earlier finalization clears the active marker of a newer run', async () => {
  const wrapper = { active: undefined };
  const runAReport = deferred(), runBWork = deferred();
  function reducedStart(task) {
    let resolveActive;
    wrapper.active = new Promise(resolve => { resolveActive = resolve; });
    return Promise.allSettled([task]).then(() => {
      // Mirrors the unconditional assignment in RuntimeAgentSessionValue.stream.
      wrapper.active = undefined;
      resolveActive();
    });
  }
  const finishA = reducedStart(runAReport.promise);
  // Raw A has finished; its outer report remains pending. Raw B may be admitted.
  const finishB = reducedStart(runBWork.promise);
  const markerB = wrapper.active;
  runAReport.resolve();
  await finishA;
  assert.equal(wrapper.active, undefined);
  assert.equal((await observe(runBWork.promise, 15)).state, 'pending');
  const actual = { publicIdleWhileBPending: true, markerBWasOverwritten: wrapper.active !== markerB };
  runBWork.resolve(); await finishB;
  // Control: stale completion cannot clear a later generation's marker.
  const activeB = {}; let current = activeB;
  const activeA = {};
  if (current === activeA) current = undefined;
  assert.equal(current, activeB);
  return { actual, control: { generationGuardPreservesB: true } };
});

await check('M03', 'Checking abort only before/after a store await does not bound the wait', async () => {
  const load = deferred(), ac = new AbortController();
  async function reducedLoad() {
    ac.signal.throwIfAborted();
    const value = await load.promise;
    ac.signal.throwIfAborted();
    return value;
  }
  const pending = reducedLoad();
  ac.abort(new Error('request cancelled'));
  const actual = await observe(pending, 30);
  assert.equal(actual.state, 'pending');
  const control = await observe(withAbort(new Promise(() => {}), ac.signal));
  assert.equal(control.state, 'rejected');
  load.resolve(undefined); await pending.catch(() => undefined);
  return { actual, control };
});

await check('M04', 'Public tool status loses the difference between denial and cancellation', async () => {
  // Exact status expression in projectEvent; fixture codes are illustrative.
  const projectStatus = result => result.isError ? 'failed' : 'completed';
  const values = [
    { isError: true, error: { code: 'DENIED', message: 'not authorized' } },
    { isError: true, error: { code: 'ABORTED', message: 'cancelled' } },
    { isError: true, error: { code: 'FAILED', message: 'execution failed' } },
  ];
  const actual = values.map(projectStatus);
  assert.deepEqual(actual, ['failed', 'failed', 'failed']);
  return { actual, note: 'The nested error still carries its code. This is a top-level event contract issue, not loss of all error evidence.' };
});


await check('M05', 'Cancelled controller causes a teardown timeout to be swallowed', async () => {
  const controller = new AbortController();
  const work = deferred();
  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('teardown timed out')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
  async function reducedCancel() {
    controller.abort(new Error('closing'));
    try { await withTimeout(work.promise, 15); }
    catch (error) { if (controller.signal.aborted !== true) throw error; }
  }
  const outcome = await observe(reducedCancel(), 80);
  assert.equal(outcome.state, 'resolved');
  assert.equal((await observe(work.promise, 10)).state, 'pending');
  work.resolve();
  return { actual: { cancelResolved: true, workStillPendingWhenCancelResolved: true },
    note: 'Reproduces the local cancel catch only; the full outer dispose/runtime deadline race was not executed.' };
});

await check('M06', 'Waiting for the caller session to become idle creates a self-wait cycle', async () => {
  const idle = deferred();
  let running = true;
  async function reducedAgentRun() {
    // wait_agents chooses the same session. It waits for completion of this run.
    await idle.promise;
    running = false;
  }
  const run = reducedAgentRun();
  const outcome = await observe(run, 20);
  assert.equal(outcome.state, 'pending');
  assert.equal(running, true);
  const ownName = 'worker';
  const targets = ['worker'];
  assert.equal(targets.includes(ownName), true);
  // Release synthetic state rather than leave any test-owned waiter behind.
  idle.resolve(); await run;
  return { actual: { selfWaitRequiresExternalBreak: true },
    control: { aSenderAwareGuardCanRejectBeforeWaiting: true },
    note: 'The SDK has timeouts. This is a progress/liveness gap, not a claim of an infinite production hang.' };
});

const report = {
  scope: 'REDUCED_MECHANISM_MODELS_NOT_FULL_SDK_TESTS',
  sha: 'a456e38b3de62d114163ec77ef45433ee7cf20e4',
  node: process.version,
  executedAt: new Date().toISOString(),
  reproducedCount: results.filter(r => r.reproduced).length,
  total: results.length,
  results,
};
const json = JSON.stringify(report, null, 2) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], json, 'utf8');
console.log(json);
if (report.reproducedCount !== report.total) process.exitCode = 1;
