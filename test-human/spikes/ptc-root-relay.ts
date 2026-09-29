/** Alternative feasibility probe: guest requests lowered into the SAME root run.
 * This is a run-owned relay protocol, not a production nested-admission API. */
import { Worker } from 'node:worker_threads'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAgentRuntime, defineTool, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import type { GenerateOptions, StreamChunk, RuntimeAgentRunEvent } from '@alvin0/ai-agent-sdk-core'
interface GuestEvent { requestId?:number;type:string;tool?:string;args?:unknown;value?:unknown;error?:string }
async function probe(kind:'normal'|'root-budget'|'post-policy'|'exempt-cap'|'invalid-schema'|'host-failure') {
 let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false,bodies=0,policies=0,checkpoints=0,forwarded=0
 const queue:GuestEvent[]=[], events:RuntimeAgentRunEvent[]=[], requests:string[]=[]
 let waiter:((event:GuestEvent)=>void)|undefined, currentCall:string|undefined, currentRequest:number|undefined, publicLeak=false, workerFinished=false
 const enqueue=(event:GuestEvent)=>{if(waiter){const f=waiter;waiter=undefined;f(event)}else queue.push(event)}
 const next=async()=>queue.shift()??await new Promise<GuestEvent>(r=>{waiter=r})
 const stop=async()=>{if(closed)return;closed=true;if(timer)clearTimeout(timer);if(worker)await worker.terminate();enqueue({type:'error',error:'RUN_CLOSED'})}
 const code=kind==='root-budget'||kind==='exempt-cap'||kind==='host-failure'?`for(let page=0;page<10;page++){try{callTool('read_rows',JSON.stringify({page}))}catch{}}; 'done'`:`JSON.parse(callTool('read_rows','{"page":0}'))`
 class Relay extends ModelAdapter {
   round=0
   override async resolveModel(provider:string,model:string){return{provider,id:model,name:model,context:{contextWindow:16000}}}
   override async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{
     if(++this.round===1){yield{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(randomUUID()),name:'start_program',arguments:'{}'}};yield{type:'finish',reason:{kind:'tool-calls'}};return}
     const event=await next()
     if(event.type==='call'){
       currentCall=randomUUID();currentRequest=event.requestId;requests.push(currentCall)
       yield{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(currentCall),name:event.tool!,arguments:JSON.stringify(event.args)}}
       yield{type:'finish',reason:{kind:'tool-calls'}}
     }else{workerFinished=true;yield{type:'block-end',index:0,block:{type:'text',text:JSON.stringify({guest:event.type,value:event.value,error:event.error})}};yield{type:'finish',reason:{kind:'stop'}}}
   }
 }
 const plugin=defineModelProviderPlugin({id:'fixture',routes:['fixture'],displayName:'Same-root guest relay',setup(registrar){registrar.registerAdapter(new Relay())}})
 const runtime=await createAgentRuntime({providers:[plugin]})
 let report:unknown,codes:string[]=[],terminalText=''
 try {
   const start=defineTool({name:'start_program',description:'Start a run-owned guest relay, report phase started only.',parameters:{type:'object'},execute(_args,context){
     worker=new Worker(new URL('./ptc-worker.mjs',import.meta.url),{workerData:{code,cpuMs:1000,hardCap:kind==='exempt-cap'?3:20},env:{},resourceLimits:{maxOldGenerationSizeMb:32}})
     timer=setTimeout(()=>{enqueue({type:'error',error:'PROGRAM_DEADLINE'});void stop()},4000)
     context.signal.addEventListener('abort',()=>{void stop()},{once:true})
     worker.on('message',enqueue);worker.on('error',()=>enqueue({type:'error',error:'EXECUTOR_FAILED'}))
     return{phase:'started'}
   }})
   const read=defineTool({name:'read_rows',description:'Host read-only fixture',parameters:{type:'object'},...(kind==='exempt-cap'?{budgetExempt:true}:{}),parse(raw){const page=raw&&typeof raw==='object'?Reflect.get(raw,'page'):undefined;if(!Number.isSafeInteger(page))throw new Error('Invalid page');return{page:page as number}},execute(args){bodies++;if(kind==='host-failure')throw new Error('Fixture host outcome unavailable');return kind==='invalid-schema'?{unexpected:'shape'}:{id:`row-${args.page}`,private:'ROOT_RELAY_SENTINEL'}}})
   const agent=runtime.agent({id:'relay',instructions:'Run the host-owned guest protocol.',model:{provider:'fixture',id:'scripted'},tools:[start,read],maxToolCalls:kind==='root-budget'?3:24,maxTurns:24,compaction:false})
   const session=agent.createSession({runtimeLimits:{maxToolResultBytes:65536},hooks:{async checkpoint(){checkpoints++}},interceptors:[{name:'policy',async before(){policies++;return{kind:'allow'}},async after(call){if(kind==='post-policy'&&call.toolName==='read_rows')return{kind:'replace',content:[{type:'text',text:'redacted'}]};return{kind:'accept'}}}]})
   const result=await session.run('Start host program.',{includeTraceEvents:true,onEvent(event){
     events.push(event);publicLeak ||= JSON.stringify(event).includes('ROOT_RELAY_SENTINEL')
     if(event.type==='tool-result'&&event.callId===currentCall){
       const output=event.output as {isError?:boolean;value?:unknown}
       if(output.isError||event.status!=='completed'){worker?.postMessage({requestId:currentRequest,error:'ROOT_ADMISSION_DECLINED'});return}
       // Only finalized, post-policy structured value. Never parse rendered text.
       const value=output.value
       if(!value||typeof value!=='object'||typeof Reflect.get(value,'id')!=='string'){worker?.postMessage({requestId:currentRequest,error:'STRUCTURED_OUTPUT_UNAVAILABLE'});return}
       forwarded++;worker?.postMessage({requestId:currentRequest,data:value})
     }
   }})
   report=result.report;codes=result.report.errors.map(e=>e.code);terminalText=result.text
 }catch(error){const r=error instanceof Error?Reflect.get(error,'report'):undefined;if(!r)throw error;report=r;codes=(r as {errors?:{code:string}[]}|undefined)?.errors?.map(e=>e.code)??[]}
 finally{await stop();await runtime.close()}
 const traces=new Set(events.filter(e=>e.type==='tool-call').map(e=>e.traceId))
 let terminal:{guest?:string;error?:string}|undefined
 try{terminal=JSON.parse(terminalText) as {guest?:string;error?:string}}catch{ /* Missing or malformed terminal output fails the oracle. */ }
 const failedWith=(error:string)=>terminal?.guest==='error'&&terminal.error===error&&terminalText===JSON.stringify({guest:'error',error})
 const check=kind==='host-failure'?bodies===1&&forwarded===0&&failedWith('ROOT_ADMISSION_DECLINED'):
   kind==='root-budget'?bodies===2&&forwarded===2&&failedWith('ROOT_ADMISSION_DECLINED'):
   kind==='post-policy'?bodies===1&&forwarded===0&&!publicLeak&&failedWith('STRUCTURED_OUTPUT_UNAVAILABLE'):
   kind==='exempt-cap'?bodies===3&&forwarded===3&&failedWith('PROGRAM_CALL_CAP'):
   kind==='invalid-schema'?bodies===1&&forwarded===0&&failedWith('STRUCTURED_OUTPUT_UNAVAILABLE'):
   bodies===1&&forwarded===1&&terminalText===JSON.stringify({guest:'result',value:{id:'row-0',private:'ROOT_RELAY_SENTINEL'}})
 return{kind,passed:check&&workerFinished&&closed&&traces.size===1&&policies>=bodies&&checkpoints>=bodies,bodies,forwarded,policies,checkpoints,closed,workerFinished,rootLimit:kind==='root-budget'?3:24,rootTraces:traces.size,terminalText,codes,report}
}
const root=resolve('artifacts/spikes',`ptc-root-relay-${new Date().toISOString().replace(/[:.]/g,'-')}`);await mkdir(root,{recursive:true})
const cases=[];for(const kind of ['normal','root-budget','post-policy','exempt-cap','invalid-schema','host-failure'] as const)cases.push(await probe(kind))
const summary={spike:'SP-01',candidate:'Same-root run-owned relay',cases,passed:cases.every(c=>c.passed),decision:'needs-review',architectureGatePassed:false,liveBenchmarkAllowed:false,limitations:['Only six focused root-path feasibility cases; not full PTC-A01…15','start_program returns started; ordinary outer execute_program result lifecycle is not implemented','Child results remain in canonical model history; no provider projection/catalog metadata implementation','No MCP output schema/capture/revision proof or guest handle owner/TTL store','No benchmark/cost conclusion; synthetic model adapter rounds are not remote LLM calls']}
await writeFile(resolve(root,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});for(const file of ['ptc-root-relay.ts','ptc-worker.mjs']){const data=await readFile(resolve('test-human/spikes',file));await writeFile(resolve(root,file),data,{flag:'wx'});await writeFile(resolve(root,file+'.sha256'),createHash('sha256').update(data).digest('hex'),{flag:'wx'})}
console.log(JSON.stringify({root,passed:summary.passed,cases:cases.length}));if(!summary.passed)process.exitCode=1
