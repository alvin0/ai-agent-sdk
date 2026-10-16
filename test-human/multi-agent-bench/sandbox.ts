import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

// No host functions or objects enter the VM. The outer process has no inherited env,
// filesystem permission, child-process permission, addons, or workers. Only JSON crosses stdin/stdout.
const sandboxProgram = `
import vm from 'node:vm';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {files,checks,pages,script}=JSON.parse(input);
const context=vm.createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false}});
if(script !== undefined) {
  const api='const read_file=(()=>{const pages='+JSON.stringify(pages)+';'
    +'return (path,offset=0)=>{const page=pages[path]?.find(p=>p.offset===offset);'
    +'if(!page)throw Error("Unknown file or page offset");return JSON.parse(JSON.stringify(page));}})();'
    +'const list_files=()=>'+JSON.stringify(Object.keys(pages).sort())+';const module={exports:{}};';
  vm.runInContext(api,context,{timeout:500});
  vm.runInContext(script,context,{timeout:500});
  const result=vm.runInContext('JSON.stringify(module.exports.run())',context,{timeout:1000});
  if(typeof result!=='string'||Buffer.byteLength(result)>65536) {
    throw Error('Script output exceeds 64 KiB or is not JSON');
  }
  process.stdout.write(result);
} else {
const source='const sources='+JSON.stringify(files)+'; const modules=Object.create(null);'
  +'function load(name){if(modules[name])return modules[name].exports;'
  +'if(!Object.hasOwn(sources,name))throw Error("Unknown module");'
  +'throw Error("Module not initialized");}';
vm.runInContext(source,context,{timeout:500});
for(const [name,body] of Object.entries(files)) {
  const code='modules['+JSON.stringify(name)+']={exports:{}};'
    +'((module,exports)=>{'+body+'\\n})(modules['+JSON.stringify(name)+'],modules['+JSON.stringify(name)+'].exports)';
  vm.runInContext(code,context,{timeout:500});
}
const results=checks.map(check=>{
  try{return vm.runInContext('Boolean('+check+')',context,{timeout:500})===true;}
  catch{return false;}
});
process.stdout.write(JSON.stringify(results));
}
`

async function sandboxProcess(input: object, signal?: AbortSignal): Promise<unknown> {
  return new Promise<unknown>((accept, reject) => {
    const child = spawn(process.execPath, ['--permission', '--input-type=module', '-e', sandboxProgram], {
      env: {}, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}),
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.stdout.on('data', chunk => { stdout += String(chunk).slice(0, 65536 - stdout.length) })
    child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 16000 - stderr.length) })
    child.once('error', reject)
    child.stdin.on('error', () => { /* exit handler records a failed child */ })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Sandbox test exit ${code}: ${stderr}`))
      else try { accept(JSON.parse(stdout)) } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}


export async function sandboxChecks(files: Record<string, string>, checks: string[], signal?: AbortSignal) {
  return await sandboxProcess({ files, checks }, signal) as boolean[]
}
export async function sandboxScript(script: string, pages: Record<string, unknown[]>, signal?: AbortSignal) {
  return sandboxProcess({ script, pages }, signal)
}
