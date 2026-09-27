import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Run in a child process: an orphaned host callback rejection must fail the
// regression without killing the application or the rest of the test runner.
describe('fusion synchronous callback contract in JavaScript consumers', () => {
  it.each(['arguments-reject', 'arguments-resolve', 'accept-reject', 'accept-resolve'])('fails safely for %s', async mode => {
    const source = `
      import assert from 'node:assert/strict';
      import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core';
      import { defineActionFusion, defineTool } from '@alvin0/ai-agent-sdk-core/tools';
      import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider';
      const mode = ${JSON.stringify(mode)}, bodies = { edit: 0, check: 0 }, observations = [];
      class Model extends ModelAdapter {
        rounds = 0;
        async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 32000 } } }
        async *stream() {
          const first = ++this.rounds === 1;
          yield { type: 'block-end', index: 0, block: first
            ? { type: 'tool-call', id: ToolCallId('fusion'), name: 'fuse', arguments: '{}' }
            : { type: 'text', text: 'done' } };
          yield { type: 'finish', reason: { kind: first ? 'tool-calls' : 'stop' } };
        }
      }
      const runtime = await createAgentRuntime({ providers: [defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'Fixture', setup(registrar) { registrar.registerAdapter(new Model()) } })] });
      const unexpectedAsync = () => mode.endsWith('reject') ? Promise.reject(new Error('invalid async host callback')) : Promise.resolve(true);
      const edit = defineTool({ name: 'edit', description: 'Edit', parameters: {}, execute: () => { bodies.edit++; return { edited: true } } });
      const check = defineTool({ name: 'check', description: 'Check', parameters: {}, execute: () => { bodies.check++; return { tested: true } } });
      const fusion = defineActionFusion({ name: 'fuse', description: 'Fuse', parameters: {}, steps: [
        { tool: 'edit', arguments: () => ({}) },
        { tool: 'check', arguments: () => mode.startsWith('arguments') ? unexpectedAsync() : ({}), accept: () => mode.startsWith('accept') ? unexpectedAsync() : true },
      ] });
      try {
        const session = runtime.agent({ id: 'a', model: { provider: 'fixture', id: 'm' }, instructions: 'Fuse', compaction: false, tools: [edit, check, fusion.tool] })
          .createSession({ experimentalPrograms: [fusion.grant] });
        await session.run('Fuse', { onEvent: event => { if (event.type === 'tool-result') observations.push(event) } });
        assert.deepEqual(bodies, { edit: 1, check: mode.startsWith('arguments') ? 0 : 1 });
        const receipt = JSON.stringify(observations);
        assert.ok(receipt.includes('edited'));
        assert.ok(receipt.includes(mode.startsWith('arguments') ? 'FUSION_ARGUMENTS_FAILED' : 'FUSION_STEP_REJECTED'));
      } finally { await runtime.close() }
      await new Promise(resolve => setTimeout(resolve, 10));
      console.log('fusion-async-contract:passed');
    `
    const result = await promisify(execFile)(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', source], { cwd: process.cwd(), timeout: 10000 })
    expect(result.stdout).toContain('fusion-async-contract:passed')
  }, 15000)
})
