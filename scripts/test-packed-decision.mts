import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
const selected = process.argv[2]
if (selected !== 'decision-adapter' && selected !== 'provider-typesafe') throw new Error('Expected decision-adapter or provider-typesafe')
const temporary = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-decision-pack-'))
function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stdout}\n${result.stderr}`)
}
const fixture = `
import { ModelAdapter } from '@alvin0/ai-agent-sdk-core';
import { createDecisionRuntime, createDecisionTask, choiceQuestion, booleanQuestion, gateChoice, gateBoolean, llmDecisionPlugin } from '@alvin0/ai-agent-sdk-decision-adapter';
import { typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe';
export async function verify() {
  class FixtureLlm extends ModelAdapter {
    async *stream(options) {
      if (options.outputFormat?.type !== 'json_schema') throw Error('missing LLM schema');
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ answers: { route: { choice: 'billing' } } }) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const llm = createDecisionRuntime({ providers: [llmDecisionPlugin({ id: 'llm', routes: ['llm'], adapter: new FixtureLlm() })] });
  try {
    const result = await llm.decisionModel({ provider: 'llm', model: 'fixture' }).evaluate({ state: 'refund', questions: { route: choiceQuestion('Choose', { billing: null, support: null }) } });
    if (result.answers.route.choice !== 'billing' || result.answers.route.confidence !== undefined) throw Error('wrong LLM decision');
  } finally { await llm.close(); }
  let calls = 0;
  const runtime = createDecisionRuntime({ providers: [typesafePlugin({ apiKey: 'fixture-key', fetch: async (url, init) => {
    calls++;
    if (url !== 'https://api.typesafe.ai/v1/systemone') throw Error('wrong endpoint');
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== 'Bearer fixture-key') throw Error('missing auth');
    const request = JSON.parse(init.body);
    if (request.questions.refund.type !== 'noul') throw Error('wrong mapping');
    return Response.json({ model: 'jev-fixture-v1', answers: {
      route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.8 },
      refund: { type: 'noul', noul: 0.9 }
    }, usage: { input_tokens: 12, output_tokens: 4 } });
  } })] });
  try {
    const task = createDecisionTask(runtime.decisionModel({ provider: 'typesafe', model: 'jev-latest' }), {
      questions: { route: choiceQuestion('Choose', { billing: null, support: null }), refund: booleanQuestion('Refund requested?') }
    });
    const result = await task.evaluate('Refund please');
    if (calls !== 1 || result.answers.route.choice !== 'billing' || result.answers.refund.probabilityTrue !== 0.9 || result.usage.inputTokens !== 12) throw Error('wrong decision');
    if (gateChoice(result.answers.route, { minProbability: 0.8 }).status !== 'accepted' || gateBoolean(result.answers.refund, { falseMax: 0.2, trueMin: 0.8 }).status !== 'accepted') throw Error('wrong evidence gate');
    const rows = await task.evaluateBatch(['one', 'two'], { concurrency: 1 });
    if (calls !== 3 || rows.some(row => row.status !== 'fulfilled')) throw Error('wrong batch');
    return { ok: true, model: result.model };
  } finally { await runtime.close(); }
}
`
try {
  const artifacts = join(temporary, 'tarballs'); mkdirSync(artifacts)
  for (const pkg of ['core', 'decision-adapter', 'provider-typesafe']) run('pnpm', ['pack', '--pack-destination', artifacts], join(workspace, 'packages', pkg))
  const tarballs = readdirSync(artifacts).filter(name => name.endsWith('.tgz')).map(name => join(artifacts, name))
  const consumer = join(temporary, 'consumer'); mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', ...tarballs], consumer)
  writeFileSync(join(consumer, 'fixture.mjs'), fixture)
  writeFileSync(join(consumer, 'node.mjs'), `import { verify } from './fixture.mjs'; console.log(await verify());`)
  run(process.execPath, ['node.mjs'], consumer)
  const imports: Record<string, string> = {}
  for (const pkg of ['core', 'decision-adapter', 'provider-typesafe']) {
    const name = `@alvin0/ai-agent-sdk-${pkg}`
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8')) as { exports: Record<string, { import?: string }> }
    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      if (typeof entry.import === 'string') imports[name + (subpath === '.' ? '' : subpath.slice(1))] = `/node_modules/${name}/${entry.import.slice(2)}`
    }
  }
  const importMap = JSON.stringify({ imports })
  writeFileSync(join(consumer, 'index.html'), `<script type="importmap">${importMap}</script><script type="module">import { verify } from './fixture.mjs'; try { window.result = await verify(); } catch(e) { window.result = { error: String(e) }; }</script>`)
  const server = createServer((request, response) => {
    const target = resolve(consumer, '.' + new URL(request.url ?? '/', 'http://localhost').pathname)
    if (!target.startsWith(consumer + sep) || !existsSync(target)) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type', extname(target) === '.html' ? 'text/html' : 'text/javascript')
    response.end(readFileSync(target))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture server address')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${address.port}/index.html`)
      await page.waitForFunction('window.result !== undefined', { timeout: 15_000 })
      const result = await page.evaluate('window.result') as { ok?: boolean; error?: string }
      if (!result.ok) throw new Error(`Packed browser fixture failed: ${result.error}`)
    } finally { await browser.close() }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  console.log(`Packed ${selected}: Node and browser decision fixtures passed`)
} finally {
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing cleanup outside the fixture temp directory')
  rmSync(temporary, { recursive: true, force: true })
}
