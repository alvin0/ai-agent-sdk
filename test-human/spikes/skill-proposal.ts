/** SP-05 proposal/revision research sample; draft capability never publishes. */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { defineTool } from '@alvin0/ai-agent-sdk-core'
import { invoke } from './fixture-runtime.ts'
const root=resolve('artifacts/spikes',`proposal-${new Date().toISOString().replace(/[:.]/g,'-')}`)
await mkdir(root,{recursive:true})
const db=new DatabaseSync(resolve(root,'proposals.sqlite'))
db.exec('CREATE TABLE skills(id TEXT PRIMARY KEY, owner TEXT, protected INTEGER, revision INTEGER, body TEXT); CREATE TABLE evidence(id TEXT PRIMARY KEY, allowed INTEGER, revision INTEGER, withdrawn INTEGER); CREATE TABLE proposals(id TEXT PRIMARY KEY, actor TEXT, target TEXT, baseRevision INTEGER, body TEXT, refs TEXT, valid INTEGER, state TEXT); CREATE TABLE history(target TEXT, revision INTEGER, body TEXT, PRIMARY KEY(target,revision));')
for(const [id,owner,protect] of [['editable','fixture-host',0],['pinned','fixture-host',1],['external','external',0],['user-owned','user',0],['unknown',null,0]] as const)db.prepare('INSERT INTO skills VALUES (?,?,?,1,?)').run(id,owner,protect,JSON.stringify({operation:'sum',revisionNote:'original'}))
for(const [id,allowed,withdrawn] of [['good',1,0],['dependency',0,0],['withdrawn',1,1]] as const)db.prepare('INSERT INTO evidence VALUES (?,?,1,?)').run(id,allowed,withdrawn)
const observations: {status:string;id?:string;reason?:string}[]=[]
let publishedBodies=0, beforeCommit: (()=>void)|undefined, writerGranted=true
function targetAllowed(id:string){const r=db.prepare('SELECT * FROM skills WHERE id=?').get(id);return r&&r.owner==='fixture-host'&&r.protected===0?r:undefined}
function refsAllowed(refs:{id:string;revision:number}[]){return refs.length>0&&refs.length<=8&&refs.every(ref=>{const r=db.prepare('SELECT * FROM evidence WHERE id=?').get(ref.id);return r?.allowed===1&&r.withdrawn===0&&r.revision===ref.revision})}
function push(value:{status:string;id?:string;reason?:string}){observations.push(value);return value}
const parse=(raw:unknown)=>{if(!raw||typeof raw!=='object')throw new Error('Invalid object');const id=Reflect.get(raw,'id');if(typeof id!=='string'||id.length>64)throw new Error('Invalid ID');return{id}}
const propose=defineTool({name:'propose_skill',description:'Learner can create a bounded draft only.',parameters:{type:'object'},parse(raw){
  if(!raw||typeof raw!=='object')throw new Error('Invalid draft');const target=Reflect.get(raw,'target'),refs=Reflect.get(raw,'refs'),body=Reflect.get(raw,'body')
  if(typeof target!=='string'||target.length>64||!Array.isArray(refs)||refs.length>8||typeof body!=='string'||body.length>4096)throw new Error('Bounded draft required')
  const parsed=refs.map(ref=>{if(!ref||typeof ref!=='object'||typeof ref.id!=='string'||!Number.isSafeInteger(ref.revision))throw new Error('Invalid reference');return{id:ref.id as string,revision:ref.revision as number}})
  return{target,refs:parsed,body}
},execute(args){const target=targetAllowed(args.target);if(!target)return push({status:'denied',reason:'target-authority'});if(!refsAllowed(args.refs))return push({status:'denied',reason:'evidence-authority'})
 const id=randomUUID();db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,0,?)').run(id,'host-learner',args.target,Number(target.revision),args.body,JSON.stringify(args.refs),'draft');return push({status:'draft',id})}})
const validate=defineTool({name:'validate_skill',description:'Evaluate candidate on fixed development checks; never change active skill.',parameters:{type:'object'},parse,execute(args){const p=db.prepare('SELECT * FROM proposals WHERE id=?').get(args.id);if(!p||p.state!=='draft')return push({status:'unavailable'})
 let valid=false;try{const body=JSON.parse(String(p.body));const executeCandidate=(input:number[])=>body.operation==='sum'?input.reduce((a,b)=>a+b,0):undefined;const tasks=[{input:[1,2],expected:3},{input:[-5,2],expected:-3},{input:[],expected:0}];valid=Object.keys(body).every(k=>['operation','revisionNote'].includes(k))&&tasks.every(t=>executeCandidate(t.input)===t.expected)}catch{}
 db.prepare('UPDATE proposals SET valid=? WHERE id=?').run(valid?1:0,args.id);return push({status:valid?'validated':'invalid',id:args.id})}})
const publish=defineTool({name:'publish_skill',description:'Host writer commits validated proposal with revision and evidence checks.',parameters:{type:'object'},parse,async execute(args){publishedBodies++;const p=db.prepare('SELECT * FROM proposals WHERE id=?').get(args.id);if(!writerGranted||!p||p.state!=='draft'||p.valid!==1)return push({status:'denied',reason:'writer-or-validation'})
 const refs=JSON.parse(String(p.refs)) as {id:string;revision:number}[]
 // This await represents host approval/validation; authority is rechecked at commit.
 await Promise.resolve();beforeCommit?.();beforeCommit=undefined
 if(!writerGranted||!targetAllowed(String(p.target))||!refsAllowed(refs))return push({status:'denied',reason:'commit-authority'})
 db.exec('BEGIN IMMEDIATE');try{const old=targetAllowed(String(p.target));if(!old||old.revision!==p.baseRevision)throw new Error('revision-conflict')
 db.prepare('INSERT INTO history VALUES (?,?,?)').run(String(p.target),Number(old.revision),String(old.body))
 const n=db.prepare('UPDATE skills SET body=?,revision=revision+1 WHERE id=? AND revision=? AND owner=? AND protected=0').run(String(p.body),String(p.target),Number(p.baseRevision),'fixture-host').changes
 if(n!==1)throw new Error('revision-conflict');db.prepare("UPDATE proposals SET state='published' WHERE id=? AND state='draft'").run(args.id);db.exec('COMMIT');return push({status:'published',id:args.id})
 }catch{db.exec('ROLLBACK');return push({status:'conflict'})}}})
const rollback=defineTool({name:'rollback_skill',description:'Host CAS rollback creates a new revision; cannot overwrite later edit.',parameters:{type:'object'},parse(raw){const p=parse(raw);const expected=Reflect.get(raw as object,'expected');if(!Number.isSafeInteger(expected))throw new Error('Expected revision required');return{...p,expected:expected as number}},execute(args){if(!writerGranted)return push({status:'denied'});const current=targetAllowed(args.id);const old=db.prepare('SELECT * FROM history WHERE target=? ORDER BY revision DESC LIMIT 1').get(args.id);if(!current||!old||current.revision!==args.expected)return push({status:'conflict'});const n=db.prepare('UPDATE skills SET body=?,revision=revision+1 WHERE id=? AND revision=?').run(String(old.body),args.id,args.expected).changes;return push({status:n===1?'rolled-back':'conflict'})}})
const cases:{id:string;passed:boolean;evidence:unknown}[]=[]
const record=(id:string,passed:boolean,evidence:unknown)=>cases.push({id,passed,evidence})
const last=()=>observations.at(-1)!
const body=(id='editable')=>String(db.prepare('SELECT body FROM skills WHERE id=?').get(id)!.body)
async function call(tool:typeof propose|typeof validate|typeof publish|typeof rollback,args:unknown){const before=observations.length;await invoke([tool],[{tool:tool.name,args}]);if(observations.length!==before+1)throw new Error('Fixture body did not publish an observation');return last()}
async function draft(target='editable',refs=[{id:'good',revision:1}],candidate=JSON.stringify({operation:'sum',revisionNote:'candidate'})){return await call(propose,{target,refs,body:candidate})}
try{
 const original=body(),first=await draft();record('DRAFT-DOES-NOT-MUTATE',first.status==='draft'&&body()===original,first)
 const attempted=await invoke([propose],[{tool:'publish_skill',args:{id:first.id}}]);record('LEARNER-NO-PUBLISH-CAPABILITY',publishedBodies===0&&body()===original,attempted.status)
 for(const target of ['pinned','external','user-owned','unknown'])record(`TARGET-${target}`, (await draft(target)).status==='denied',last())
 for(const id of ['dependency','withdrawn','missing'])record(`EVIDENCE-${id}`, (await draft('editable',[{id,revision:1}])).status==='denied',last())
 record('VALIDATE-NO-MUTATION',(await call(validate,{id:first.id})).status==='validated'&&body()===original,last())
 record('PUBLISH-VALIDATED',(await call(publish,{id:first.id})).status==='published'&&body()!==original,last())
 record('PUBLISH-NO-DUPLICATE',(await call(publish,{id:first.id})).status==='denied',last())
 const revision=Number(db.prepare("SELECT revision FROM skills WHERE id='editable'").get()!.revision)
 record('ROLLBACK-STALE-CAS',(await call(rollback,{id:'editable',expected:revision-1})).status==='conflict',last())
 record('ROLLBACK-NEW-REVISION',(await call(rollback,{id:'editable',expected:revision})).status==='rolled-back'&&body()===original&&Number(db.prepare("SELECT revision FROM skills WHERE id='editable'").get()!.revision)===revision+1,last())
 const conflict=await draft();await call(validate,{id:conflict.id});beforeCommit=()=>{db.prepare("UPDATE skills SET revision=revision+1 WHERE id='editable'").run()};record('EDIT-AFTER-APPROVAL-CAS',(await call(publish,{id:conflict.id})).status==='conflict',last())
 const revoke=await draft();await call(validate,{id:revoke.id});beforeCommit=()=>{db.prepare("UPDATE evidence SET allowed=0 WHERE id='good'").run()};record('SOURCE-REVOKED-AFTER-APPROVAL',(await call(publish,{id:revoke.id})).status==='denied',last())
 db.prepare("UPDATE evidence SET allowed=1 WHERE id='good'").run()
 const invalid=await draft('editable',[{id:'good',revision:1}],'{"operation":"network","grants":"publish"}');record('PROMPT-CANNOT-GRANT-AUTHORITY',(await call(validate,{id:invalid.id})).status==='invalid'&&(await call(publish,{id:invalid.id})).status==='denied',last())
 const unvalidated=await draft();record('VALIDATION-REQUIRED',(await call(publish,{id:unvalidated.id})).status==='denied',last())
 const writer=await draft();await call(validate,{id:writer.id});beforeCommit=()=>{writerGranted=false};record('WRITER-REVOKED-AFTER-AWAIT',(await call(publish,{id:writer.id})).status==='denied',last())
 const summary={spike:'SP-05',status:'completed',decision:'go-for-proposal-only',cases,passed:cases.every(c=>c.passed),limitations:['Fixed development validator is illustrative; no blinded skill efficacy or general prompt quality conclusion','Host capabilities, SQLite revision/CAS and source lifecycle demonstrated locally only','No auto-learning/consolidation/archive/publish','No public SDK package or user-owned skill changes'],nextAction:'Consumer must provide independent held-out skill evaluation before adopting publish workflow'}
 await writeFile(resolve(root,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});const source=await readFile('test-human/spikes/skill-proposal.ts');await writeFile(resolve(root,'skill-proposal.ts'),source,{flag:'wx'});await writeFile(resolve(root,'source.sha256'),createHash('sha256').update(source).digest('hex'),{flag:'wx'})
 console.log(JSON.stringify({root,passed:summary.passed,cases:cases.length}));if(!summary.passed)process.exitCode=1
}finally{db.close()}
