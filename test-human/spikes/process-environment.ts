/** SP-04 real local/container protocol probe; commands are host-owned fixtures. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { defineTool, createApprovalBroker } from '@alvin0/ai-agent-sdk-core'
import { createToolExecutionInterceptor, ToolError } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolExecutionBackend, ToolExecutionResult, ToolExecutionStore, ToolOperation } from '@alvin0/ai-agent-sdk-core/agent'
import { invoke } from './fixture-runtime.ts'
const image = 'node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
const root = resolve('artifacts/spikes', `process-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await mkdir(root, { recursive: true })
const cleanEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
const commands: Record<string, string> = {
  normal: "console.log('fixture-ok')",
  nonzero: "console.log('partial-out'); console.error('partial-err'); process.exit(7)",
  timeout: "console.log('ready'); setInterval(()=>{},100)",
  oversized: "console.log('x'.repeat(100000))",
  unicode: "console.log('界'.repeat(10000))",
  environment: "console.log(JSON.stringify({secret:process.env.SPIKE_SECRET??null, allowed:process.env.FIXTURE_ALLOWED??null}))",
  filesystem: "try{require('fs').writeFileSync('/etc/spike-fixture','x');console.log('UNEXPECTED_WRITE')}catch(e){console.log(e.code)}",
  network: "const n=require('net');const s=n.createServer();s.listen(0,'0.0.0.0',()=>{const c=n.connect({host:'1.1.1.1',port:443});c.on('connect',()=>{console.log('REACHED');process.exit()});c.on('error',()=>{console.log('BLOCKED');process.exit()});setTimeout(()=>{console.log('BLOCKED');process.exit()},150)})",
  disconnect: "console.log('ready');setInterval(()=>{},100)",
  tree: "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});console.log('ready childpid='+c.pid);setInterval(()=>{},100)",
}
interface Observation { mode: string; backend: string; stdout: string; stderr: string; code: number | null; timedOut: boolean; removed: boolean; capped: boolean; elapsedMs: number; childTreeStopped?: boolean }
const observations: Observation[] = []
const owned = new Set<string>()
const envCanary = 'PROCESS_ENV_PRIVATE_SENTINEL'
process.env.SPIKE_SECRET = envCanary
let retired = false, fallbackBodies = 0, revokeAfterExecution = false
let containerImage = image
function backend(kind: 'local' | 'container'): ToolExecutionBackend {
  return { id: `spike-${kind}`, capabilities: { cancellation: 'forced', filesystem: kind === 'container' ? 'restricted' : 'host', network: kind === 'container' ? 'none' : 'host', cleanup: 'best-effort' },
    async execute(request) {
      const mode = (request.args as { mode: string }).mode
      if (retired || request.signal.aborted) throw ToolError.fatal('Retired host capability', 'CAPABILITY_RETIRED')
      if (!Object.hasOwn(commands, mode) || request.toolName !== 'run_fixture') throw new Error('Unsupported host command')
      const name = `sdk-spike-${randomUUID()}`
      const argv = kind === 'container' ? ['run','--pull','never','--name',name,'--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','64m','--pids-limit','64','--user','65534:65534','--tmpfs','/tmp:rw,noexec,nosuid,size=65536','--env','FIXTURE_ALLOWED=visible',containerImage,'node','-e',commands[mode]!] : ['-e',commands[mode]!]
      if (kind === 'container') owned.add(name)
      const started = performance.now()
      let stdout = '', stderr = '', timedOut = false, capped = false, removed = kind === 'local'
      let terminating: Promise<void> | undefined
      const child = spawn(kind === 'container' ? 'docker' : process.execPath, argv, { stdio: ['ignore','pipe','pipe'], env: { ...cleanEnv, ...(kind === 'local' ? { FIXTURE_ALLOWED: 'visible' } : {}) }, detached: kind === 'local' })
      const terminate = () => terminating ??= (async () => {
        if (kind === 'container') {
          try { execFileSync('docker',['rm','-f',name],{env:cleanEnv,stdio:'pipe',timeout:5000}); removed = true; owned.delete(name) } catch { /* verified below, never claim cleanup on failure */ }
          child.kill('SIGKILL')
        } else { if (child.pid) { try { process.kill(-child.pid,'SIGKILL') } catch { /* already exited */ } } }
      })()
      let timer = setTimeout(() => { timedOut = true; void terminate() }, 8000)
      let sawReady = false
      const abort = () => { timedOut = true; void terminate() }
      request.signal.addEventListener('abort', abort, { once: true })
      const capture = (chunk: Buffer, target: 'stdout' | 'stderr') => {
        const value = chunk.toString()
        const bounded = (text: string) => { let kept=text.slice(0,8192); while(Buffer.byteLength(kept)>8192)kept=kept.slice(0,-1); return kept }
        if (target === 'stdout') stdout = bounded(stdout + value); else stderr = bounded(stderr + value)
        if (Buffer.byteLength(value) > 8192 || Buffer.byteLength(stdout) >= 8192 || Buffer.byteLength(stderr) >= 8192) { capped = true; void terminate() }
        if (!sawReady && stdout.includes('ready')) { sawReady = true; clearTimeout(timer); timer = setTimeout(() => { timedOut = true; void terminate() }, 150) }
      }
      child.stdout.on('data', chunk => capture(chunk, 'stdout')); child.stderr.on('data', chunk => capture(chunk, 'stderr'))
      let code: number | null
      try { code = await new Promise<number | null>((done, fail) => { child.on('error',fail); child.on('close',done) }) }
      finally { clearTimeout(timer); request.signal.removeEventListener('abort',abort); if (kind === 'container') await terminate(); if (terminating) await terminating }
      if (kind === 'container') { try { execFileSync('docker',['inspect',name],{env:cleanEnv,stdio:'pipe',timeout:5000}); removed = false } catch (error) { const detail = error instanceof Error ? String(Reflect.get(error,'stderr') ?? '') : ''; removed = /No such (object|container)/i.test(detail); if (removed) owned.delete(name) } }
      let childTreeStopped: boolean | undefined
      if (kind === 'local' && mode === 'tree') {
        const pid = Number(/childpid=(\d+)/.exec(stdout)?.[1])
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Missing independent child PID')
        for (let attempt = 0; attempt < 40; attempt++) {
          try { const state = execFileSync('ps',['-o','stat=','-p',String(pid)],{env:cleanEnv,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); childTreeStopped = !state || state.startsWith('Z') }
          catch { childTreeStopped = true }
          if (childTreeStopped) break
          await new Promise(r=>setTimeout(r,25))
        }
      }
      const observation = { ...(childTreeStopped === undefined ? {} : {childTreeStopped}), mode, backend: kind, stdout, stderr, code, timedOut, removed, capped, elapsedMs: performance.now() - started }; observations.push(observation)
      if (revokeAfterExecution) retired = true
      if (retired) throw ToolError.fatal('Capability retired before publication', 'CAPABILITY_RETIRED')
      if (mode === 'disconnect') throw ToolError.fatal('Transport ended after possible mutation; reconcile', 'OPERATION_OUTCOME_UNKNOWN')
      const content = [{ type: 'text' as const, text: JSON.stringify(observation) }]
      const result: ToolExecutionResult = code === 0 && !timedOut && !capped ? { isError: false, value: JSON.parse(JSON.stringify(observation)), content } : { isError: true, error: { message: timedOut ? 'Command timed out' : capped ? 'Output resource cap' : 'Command exited nonzero', code: 'PROCESS_FAILED' }, content }
      return result
    } }
}
const tool = defineTool({ name: 'run_fixture', description: 'Host command protocol fixture.', parameters: { type: 'object' }, parse(raw) {
  const mode = raw && typeof raw === 'object' ? Reflect.get(raw,'mode') : undefined
  if (typeof mode !== 'string' || !Object.hasOwn(commands,mode)) throw new Error('Invalid mode')
  return { mode }
}, execute() { fallbackBodies++; throw new Error('Host fallback forbidden') } })
const cases: { id: string; passed: boolean; evidence: unknown }[] = []
const record = (id: string, passed: boolean, evidence: unknown) => cases.push({ id, passed, evidence })
try {
  for (const kind of ['local','container'] as const) {
    for (const mode of ['normal','nonzero','timeout','oversized','unicode','environment','tree']) {
      const result = await invoke([tool],[{tool:'run_fixture',args:{mode}}],{interceptors:[createToolExecutionInterceptor({backend:backend(kind),identity:{fixture:true},operationId:()=>randomUUID()})]})
      const o = observations.at(-1)!
      const success = mode === 'normal' ? o.code === 0 && o.stdout.includes('fixture-ok') : mode === 'nonzero' ? o.code === 7 && o.stdout.includes('partial-out') && o.stderr.includes('partial-err') : mode === 'environment' ? o.stdout.includes('"secret":null') && o.stdout.includes('visible') : ['oversized','unicode'].includes(mode) ? o.capped && Buffer.byteLength(o.stdout) <= 8192 : o.timedOut && o.stdout.includes('ready')
      record(`${kind}-${mode}`, success && o.backend === kind && o.mode === mode && o.removed && (kind !== 'local' || mode !== 'tree' || o.childTreeStopped === true) && !JSON.stringify(result.events).includes(envCanary), o)
    }
  }
  for (const mode of ['filesystem','network']) {
    await invoke([tool],[{tool:'run_fixture',args:{mode}}],{interceptors:[createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=>randomUUID()})]})
    const o = observations.at(-1)!
    record(`container-${mode}`, o.removed && o.code === 0 && (mode === 'filesystem' ? !o.stdout.includes('UNEXPECTED_WRITE') && /EROFS|EACCES/.test(o.stdout) : o.stdout.includes('BLOCKED') && !o.stdout.includes('REACHED')), o)
  }
  containerImage = 'node@sha256:' + '0'.repeat(64)
  await invoke([tool],[{tool:'run_fixture',args:{mode:'normal'}}],{interceptors:[createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=>randomUUID()})]})
  record('missing-required-container-fails-closed', observations.at(-1)?.code === 125 && fallbackBodies === 0, observations.at(-1))
  containerImage = image
  let countBefore = observations.length
  const controller = new AbortController()
  await invoke([tool],[{tool:'run_fixture',args:{mode:'normal'}}],{hooks:{async checkpoint(context){if(context.kind==='before-tool-dispatch')controller.abort()}},interceptors:[createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=>randomUUID()})]}, {signal:controller.signal})
  record('abort-before-acquire-no-process',observations.length===countBefore,'No process acquired after checkpoint abort')
  countBefore=observations.length
  const broker=createApprovalBroker();const abortApproval=new AbortController();let oldApproval=''
  broker.onRequest(request=>{oldApproval=request.approvalRequestId;abortApproval.abort()})
  await invoke([tool],[{tool:'run_fixture',args:{mode:'normal'}}],{approvals:broker,interceptors:[{name:'ask',async before(){return{kind:'ask',reason:'Current host approval required'}}},createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=>randomUUID()})]},{signal:abortApproval.signal})
  record('abort-approval-wait-no-process',observations.length===countBefore&&broker.pending().length===0&&!broker.resolve(oldApproval,'allow'),'No stale waiter dispatch')
  const stale=createApprovalBroker();stale.onRequest(request=>{retired=true;stale.resolve(request.approvalRequestId,'allow')})
  await invoke([tool],[{tool:'run_fixture',args:{mode:'normal'}}],{approvals:stale,interceptors:[{name:'ask',async before(){return{kind:'ask',reason:'Current host approval required'}}},createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=>randomUUID()})]})
  record('retired-during-approval-no-dispatch',observations.length===countBefore,'Host capability rechecked by backend after approval')
  retired=false;revokeAfterExecution=true
  const unpublished=await invoke([tool],[{tool:'run_fixture',args:{mode:'normal'}}],{interceptors:[createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=>randomUUID()})]})
  record('retired-after-await-no-publication',unpublished.codes.includes('CAPABILITY_RETIRED')&&!JSON.stringify(unpublished.events).includes('fixture-ok'),unpublished.codes)
  revokeAfterExecution=false
  retired = true
  const count = observations.length
  const denied = await invoke([tool],[{tool:'run_fixture',args:{mode:'normal'}}],{interceptors:[createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=>randomUUID()})]})
  record('retired-capability-no-dispatch', observations.length === count && denied.codes.includes('CAPABILITY_RETIRED'), denied.codes)
  retired = false
  let operation: ToolOperation | undefined, completed: ToolExecutionResult | undefined
  const store: ToolExecutionStore = { async claim(op) { if (operation) return completed ? {status:'completed',operation,result:completed} : {status:'unknown',operation}; operation=op; return {status:'claimed'} }, async complete(_op,result) { completed=result } }
  const interceptor = createToolExecutionInterceptor({backend:backend('container'),identity:{fixture:true},operationId:()=> 'fixture-disconnect',store})
  await invoke([tool],[{tool:'run_fixture',args:{mode:'disconnect'}}],{interceptors:[interceptor]})
  const before = observations.length
  const resumed = await invoke([tool],[{tool:'run_fixture',args:{mode:'disconnect'}}],{interceptors:[interceptor]})
  record('disconnect-keeps-unknown-no-replay', observations.length === before && !completed && resumed.codes.includes('OPERATION_OUTCOME_UNKNOWN'), resumed.codes)
  record('no-host-fallback', fallbackBodies === 0, fallbackBodies)
  record('all-owned-containers-released', owned.size === 0, [...owned])
  const summary = { spike:'SP-04',status:'completed',decision:'go-for-host-protocol-sample',image,cases,passed:cases.every(c=>c.passed),limitations:['Host-owned command modes only; no arbitrary closure serialization','Local execution has host filesystem/network access','Container removal checked against Docker daemon; local child PID state checked independently; cleanup remains best-effort on daemon failure','No remote daemon disconnect simulation or distributed cleanup guarantee','No PTY, persistent shell, mounts or production artifact service'] }
  await writeFile(resolve(root,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'})
  const source=await readFile('test-human/spikes/process-environment.ts');await writeFile(resolve(root,'process-environment.ts'),source,{flag:'wx'});await writeFile(resolve(root,'source.sha256'),createHash('sha256').update(source).digest('hex'),{flag:'wx'})
  console.log(JSON.stringify({root,passed:summary.passed,cases:cases.length}));if(!summary.passed)process.exitCode=1
} finally { delete process.env.SPIKE_SECRET; for(const name of owned) { try {execFileSync('docker',['rm','-f',name],{env:cleanEnv,stdio:'pipe',timeout:5000})}catch{} } }
