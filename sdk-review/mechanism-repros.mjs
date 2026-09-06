/**
 * SDK pre-merge review -- isolated mechanism tests.
 * Source snapshot: 80353b38da2411450a5c4e0c1e6ce7e4c5cdebf7.
 * This is NOT the repository's test suite and does NOT import the SDK.
 * The finalizer and interceptor chain below are simplified adaptations preserving
 * the relevant source branches; error-record details and dependencies are stubbed. The child-process example models the delayed observation
 * of a rejected promise in schedule.ts; it is not an end-to-end scheduler test.
 * No network requests, credentials, or external dependencies are used.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function chain(interceptors, pick, terminal) {
  let next = terminal;
  for (let index = interceptors.length - 1; index >= 0; index--) {
    const interceptor = interceptors[index];
    if (interceptor === undefined) continue;
    const hook = pick(interceptor);
    if (hook === undefined) continue;
    const inner = next;
    next = () => hook(inner);
  }
  return next;
}

// Source: packages/core/src/agent/tool/pipeline.ts, finalizeToolCall.
// The DENIED constant is stubbed; its spelling does not affect these tests.
async function finalizeToolCall(call, executed) {
  const verdict = await chain(
    call.options.interceptors ?? [],
    interceptor => interceptor.after?.bind(interceptor, call.context, executed),
    () => Promise.resolve({ kind: 'accept' }),
  )();
  if (verdict.kind === 'accept') return executed;
  if (verdict.kind === 'replace') return {
    ...executed, content: verdict.content,
    ...verdict.meta === undefined ? {} : { meta: verdict.meta },
  };
  const text = verdict.feedback.map(block => block.type === 'text' ? block.text : '').filter(Boolean).join('\n');
  return {
    isError: true,
    error: { message: text || 'the result was blocked by policy', code: verdict.code ?? 'DENIED' },
    content: verdict.feedback,
    ...executed.additionalContext === undefined ? {} : { additionalContext: executed.additionalContext },
  };
}

const observations = [];
const marker = 'REVIEW_SENTINEL_NOT_A_REAL_SECRET';
const result = {
  isError: false,
  value: { privateData: marker },
  content: [{ type: 'text', text: marker }],
  additionalContext: [{ type: 'text', text: marker }],
};

const blocked = await finalizeToolCall({ context: {}, options: { interceptors: [{
  name: 'deny', after: async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'Blocked' }] }),
}] } }, result);
assert.equal(blocked.isError, true);
assert.equal(blocked.additionalContext[0].text, marker);
observations.push({ id: 'policy-block-context', observed: 'Block retains additionalContext', reproduced: true });

const replaced = await finalizeToolCall({ context: {}, options: { interceptors: [{
  name: 'redact', after: async () => ({ kind: 'replace', content: [{ type: 'text', text: '[REDACTED]' }] }),
}] } }, result);
assert.equal(replaced.content[0].text, '[REDACTED]');
assert.equal(replaced.value.privateData, marker);
assert.equal(replaced.additionalContext[0].text, marker);
observations.push({ id: 'policy-replace-value', observed: 'Replace retains original value and context', reproduced: true });

// Source expression: skill-filesystem/src/provider/filesystem-provider.ts,
// readImplicitPolicy and the allowImplicit !== false activation condition.
function implicitInvocationAllowed(contents) {
  const match = /^\s*allow_implicit_invocation\s*:\s*(true|false)\s*$/mi.exec(contents);
  const allowImplicit = match?.[1] === undefined ? undefined : match[1] === 'true';
  return allowImplicit !== false;
}
assert.equal(implicitInvocationAllowed('policy:\n  allow_implicit_invocation: false\n'), false);
assert.equal(implicitInvocationAllowed('policy:\n  allow_implicit_invocation: false # explicit invocation only\n'), true);
observations.push({ id: 'skill-policy-inline-comment', observed: 'Adding an inline comment changes false to default allow', reproduced: true });

// Separate process: a delayed observer must not crash this test driver itself.
const delayedObservation = `
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const firstSlot = { pending: Promise.reject(new Error('REVIEW_FATAL_TOOL')) };
  // Models waiting for a later sibling's authorization before the commit loop.
  await wait(25);
  await firstSlot.pending.catch(() => undefined);
`;
const bad = spawnSync(process.execPath, ['--unhandled-rejections=throw', '--input-type=module', '-e', delayedObservation], {
  encoding: 'utf8', timeout: 5000,
});
if (bad.error) throw bad.error;
assert.equal(bad.status, 1);
assert.match(bad.stderr, /REVIEW_FATAL_TOOL/);
const immediatelyObserved = delayedObservation.replace(
  '// Models waiting',
  'void firstSlot.pending.catch(() => undefined);\n  // Models waiting',
);
const good = spawnSync(process.execPath, ['--unhandled-rejections=throw', '--input-type=module', '-e', immediatelyObserved], {
  encoding: 'utf8', timeout: 5000,
});
if (good.error) throw good.error;
assert.equal(good.status, 0);
observations.push({ id: 'delayed-promise-observation', observed: 'Delayed handler exits 1; immediate observation control exits 0', reproduced: true });

console.log(JSON.stringify({
  node: process.version,
  snapshot: '80353b38da2411450a5c4e0c1e6ce7e4c5cdebf7',
  scope: 'Isolated source mechanisms only; not SDK build/unit/integration/heap testing',
  observations,
}, null, 2));
