import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { defineTool, type ToolDefinition } from '@alvin0/ai-agent-sdk-core'
import { artifactChecks, fixtureRoot, type Task } from './tasks.ts'

// No host functions or objects enter the VM. The outer process has no inherited env,
// filesystem permission, child-process permission, addons, or workers. Only JSON crosses stdin/stdout.
const sandboxProgram = `
import vm from 'node:vm';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {files,checks}=JSON.parse(input);
const context=vm.createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false}});
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
`

export async function sandboxChecks(files: Record<string, string>, checks: string[], signal?: AbortSignal) {
  return new Promise<boolean[]>((accept, reject) => {
    const child = spawn(process.execPath, ['--permission', '--input-type=module', '-e', sandboxProgram], {
      env: {}, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}),
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.stdout.on('data', chunk => { stdout += String(chunk).slice(0, 16000 - stdout.length) })
    child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 16000 - stderr.length) })
    child.once('error', reject)
    child.stdin.on('error', () => { /* exit handler records a failed child */ })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Sandbox test exit ${code}: ${stderr}`))
      else try { accept(JSON.parse(stdout) as boolean[]) } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ files, checks }))
  })
}

export class Workspace {
  readonly root: string
  readonly task: Task
  private constructor(root: string, task: Task) { this.root = root; this.task = task }
  static async create(task: Task, parent = tmpdir()) {
    const root = await mkdtemp(join(parent, 'ma-bench-'))
    await cp(join(fixtureRoot, task.id), root, { recursive: true })
    return new Workspace(root, task)
  }
  async path(name: string) {
    if (!name || isAbsolute(name) || name.includes('\0')) throw new Error('Expected relative workspace path')
    const target = resolve(this.root, name)
    const rel = relative(this.root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path outside workspace')
    let current = this.root
    for (const part of rel.split('/').filter(Boolean)) {
      current = join(current, part)
      const stat = await lstat(current).catch(() => undefined)
      if (stat?.isSymbolicLink()) throw new Error('Symlinks are forbidden')
    }
    return target
  }
  async files(directory = '.'): Promise<string[]> {
    const entries = await readdir(await this.path(directory), { withFileTypes: true })
    const groups = await Promise.all(entries.map(async entry => {
      const name = join(directory, entry.name)
      return entry.isDirectory() ? this.files(name) : [name]
    }))
    return groups.flat().sort()
  }
  async read(name: string) {
    const path = await this.path(name)
    if ((await lstat(path)).size > 65536) throw new Error('Read exceeds 64 KiB')
    return readFile(path, 'utf8')
  }
  async write(name: string, content: string) {
    if (Buffer.byteLength(content) > 65536) throw new Error('Write exceeds 64 KiB')
    const files = await this.files()
    if (files.length >= 64 && !files.includes(name)) throw new Error('Workspace file limit exceeded')
    const path = await this.path(name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return { written: name }
  }
  async grade(signal?: AbortSignal) {
    try {
      const checks = this.task.checks.length ? await this.test(signal) : await artifactChecks(this.task, this.root)
      return { score: checks.filter(Boolean).length / checks.length, pass: checks.every(Boolean), checks }
    } catch (error) { return { score: 0, pass: false, checks: [], error: String(error) } }
  }
  async test(signal?: AbortSignal) {
    const names = (await this.files()).filter(name => name.endsWith('.cjs'))
    const sources = await Promise.all(names.map(async name => [name, await this.read(name)] as const))
    return sandboxChecks(Object.fromEntries(sources), this.task.checks, signal)
  }
  async close() { await rm(await realpath(this.root), { recursive: true, force: true }) }
}

const parameters = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false })
const string = { type: 'string' }

export function workspaceTools(workspace: Workspace): ToolDefinition<any>[] {
  return [
    defineTool<{ path: string }>({ name: 'read_file', description: 'Read a UTF-8 workspace file (64 KiB max).',
      parameters: parameters({ path: string }, ['path']), execute: args => workspace.read(args.path) }),
    defineTool<{ path: string; content: string }>({ name: 'write_file',
      description: 'Write a UTF-8 workspace file (64 KiB max). Parent directories are created.',
      parameters: parameters({ path: string, content: string }, ['path', 'content']),
      execute: args => workspace.write(args.path, args.content) }),
    defineTool({ name: 'list_files', description: 'List workspace files recursively.',
      parameters: parameters({}, []), execute: () => workspace.files() }),
    defineTool<{ query: string }>({ name: 'search_files', 
      description: 'Literal substring search across workspace files.',
      parameters: parameters({ query: string }, ['query']), execute: async args => {
        const matches = await Promise.all((await workspace.files()).map(async path =>
          ({ path, lines: (await workspace.read(path)).split('\n').filter(line => line.includes(args.query)) })))
        return matches.filter(match => match.lines.length).slice(0, 64)
      } }),
    defineTool<{ command: string }>({ name: 'shell',
      description: 'Sandboxed test runner. Only command "test" is allowed; executes fixture CommonJS in isolation.',
      parameters: parameters({ command: string }, ['command']), execute: async (args, context) => {
        if (args.command !== 'test') throw new Error('Only test is allowed; arbitrary shell is unavailable')
        return { checks: await workspace.test(context.signal) }
      } }),
  ]
}
