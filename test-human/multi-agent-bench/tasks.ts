import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url))
export interface Task {
  id: string
  category: string
  prompt: string
  checks: string[]
}
export const tasks: Task[] = [
  {
    id: 'extraction', category: 'parallel research', checks: [],
    prompt: 'Read every regions/*.json. Write answer.json with {requests,errors,serviceIds}: total requests, '
      + 'total errors, and all service ids sorted lexicographically. Use only the source data.',
  },
  {
    id: 'code-change', category: 'disjoint code changes',
    prompt: 'Implement both functions in src/ according to SPEC.md. Verify with shell test.',
    checks: [
      'load("src/names.cjs").normalize("  Hello   WORLD ") === "hello-world"',
      'load("src/names.cjs").normalize("") === ""',
      'load("src/prices.cjs").cents(12.345) === 1235',
      'load("src/prices.cjs").cents(0) === 0',
    ],
  },
  {
    id: 'bug-hunt', category: 'independent hypotheses',
    prompt: 'Find and fix cache expiration bugs across this repo. Preserve its public API. Verify with shell test.',
    checks: [
      '(()=>{const c=load("src/cache.cjs").createCache(); c.put("a",4,2,100);return c.get("a",2099)===4})()',
      '(()=>{const c=load("src/cache.cjs").createCache(); c.put("a",4,2,100);return c.get("a",2100)===null})()',
      'load("src/cache.cjs").createCache().get("missing",0) === null',
    ],
  },
  {
    id: 'sequential', category: 'tightly coupled negative control', checks: [],
    prompt: 'Read input.json. Starting at seed, apply each operation in order: '
      + 'next=(previous*multiply+add)%modulus. Write answer.json {trace:[each next],final:last next}.',
  },
  {
    id: 'review', category: 'fresh context verification', checks: [],
    prompt: 'Review src/ against POLICY.md. Do not change source. Write findings.json '
      + '{findings:[{file,rule,example}]}. rule must be active-admin or exact-origin. '
      + 'Each example contains a JSON input that the current function wrongly accepts: '
      + 'a user object for auth, a URL string for redirect. Report only proven violations.',
  },
  {
    id: 'shared-artifact', category: 'collaboration on shared artifact', checks: [],
    prompt: 'Reconcile the team migration fragments in teams/ into one plan.json following SPEC.md. '
      + 'Resolve cross-team dependencies and duplicate ownership into a consistent runnable plan.',
  },
]

const json = async (root: string, file: string): Promise<any> => JSON.parse(await readFile(join(root, file), 'utf8'))
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

async function extraction(root: string): Promise<boolean[]> {
  const sources = await Promise.all(['east', 'west', 'north', 'south', 'central', 'edge']
    .map(region => json(join(fixtureRoot, 'extraction'), `regions/${region}.json`)))
  const services = sources.flatMap(source => source.services) as { id: string; requests: number; errors: number }[]
  const answer = await json(root, 'answer.json')
  return [answer.requests === services.reduce((sum, s) => sum + s.requests, 0),
    answer.errors === services.reduce((sum, s) => sum + s.errors, 0),
    same(answer.serviceIds, services.map(s => s.id).sort())]
}

async function sequential(root: string): Promise<boolean[]> {
  const input = await json(join(fixtureRoot, 'sequential'), 'input.json')
  let value: number = input.seed
  const trace = input.operations.map((op: { multiply: number; add: number }) => {
    value = (value * op.multiply + op.add) % input.modulus
    return value
  })
  const answer = await json(root, 'answer.json')
  return [same(answer.trace, trace), answer.final === value]
}

async function review(root: string): Promise<boolean[]> {
  const answer = await json(root, 'findings.json')
  const findings = answer.findings as { file: string; rule: string; example: any }[]
  const auth = findings.filter(f => f.file === 'src/auth.cjs' && f.rule === 'active-admin')
  const redirect = findings.filter(f => f.file === 'src/redirect.cjs' && f.rule === 'exact-origin')
  const badUser = auth.some(({ example: u }) => (u.role === 'admin' || u.active === true)
    && !(u.role === 'admin' && u.active === true))
  const badUrl = redirect.some(({ example }) => {
    if (typeof example !== 'string' || !example.startsWith('https:')) return false
    try {
      const url = new URL(example)
      return url.hostname !== 'example.com' || !!url.username || !!url.password || !!url.port
    } catch { return true }
  })
  const intact = await Promise.all(['auth', 'redirect', 'display'].map(async name =>
    (await readFile(join(root, `src/${name}.cjs`), 'utf8'))
      === (await readFile(join(fixtureRoot, 'review', `src/${name}.cjs`), 'utf8'))))
  return [badUser, badUrl, findings.length === 2 && intact.every(Boolean)]
}

async function shared(root: string): Promise<boolean[]> {
  const answer = await json(root, 'plan.json')
  const expected = [
    { id: 'assets', after: [], owners: ['web'] },
    { id: 'backup', after: [], owners: ['ops'] },
    { id: 'schema', after: ['backup'], owners: ['api', 'ops'] },
    { id: 'server', after: ['assets', 'schema'], owners: ['api'] },
    { id: 'client', after: ['server'], owners: ['web'] },
    { id: 'verify', after: ['client'], owners: ['ops'] },
  ]
  return expected.map((step, index) => {
    const actual = answer.steps?.[index]
    return actual?.id === step.id && same(actual.after, step.after) && same(actual.owners, step.owners)
  }).concat(answer.steps?.length === expected.length)
}

export async function artifactChecks(task: Task, root: string): Promise<boolean[]> {
  const graders: Record<string, (root: string) => Promise<boolean[]>> = { extraction, sequential, review,
    'shared-artifact': shared }
  return graders[task.id]!(root)
}
