/** Deterministic runtime fixtures. Answers/repairs remain host-side, never in the task workspace. */
import type { Task } from './tasks.ts'
import { incidentExtraction, moduleAudit, migration } from './volume.ts'

export function seededRandom(seed: number) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}
const encode = (value: unknown) => JSON.stringify(value)
const assertResult = (name: string, input: unknown, output: unknown) =>
  `JSON.stringify(load(${encode(`src/${name}.cjs`)}).run(${encode(input)})) === ${encode(encode(output))}`


function codeChange(): Task {
  const definitions: { name: string; spec: string; source: string; cases: unknown[] }[] = [
    { name: 'slug', spec: 'Input string: trim, lowercase, replace each whitespace run with a hyphen.',
      source: 'x => x.trim().toLowerCase().replace(/\\s+/g,"-")', cases: ['', ' A B ', 'one\ttwo', 'X', ' a  B C '] },
    { name: 'money', spec: 'Input array of prices: round each price * 100 then sum the integer cents.',
      source: 'x => x.reduce((n,v)=>n+Math.round(v*100),0)', cases: [[], [0], [1.234, 2.345], [10, -1], [0.1, 0.2]] },
    { name: 'unique', spec: 'Input numeric array: return unique numbers sorted ascending.',
      source: 'x => [...new Set(x)].sort((a,b)=>a-b)', cases: [[], [2, 1, 2], [10, 2], [-2, 0, -2], [4]] },
    { name: 'window', spec: 'Input {values,start,size}: truncate start and size, clamp both to >=0, slice values.',
      source: 'x => x.values.slice(Math.max(0,Math.trunc(x.start)),Math.max(0,Math.trunc(x.start))+Math.max(0,'
        + 'Math.trunc(x.size)))',
      cases: [{ values: [1, 2, 3], start: 1, size: 2 }, { values: [], start: 0, size: 2 },
        { values: [1, 2], start: -1, size: 1 }, { values: [1], start: 3, size: 1 },
        { values: [1, 2], start: 0.8, size: -1 }] },
    { name: 'stats', spec: 'Input numeric array: return {count,sum,min,max}, null extrema for empty input; '
      + 'property order as shown.',
      source: 'x => ({count:x.length,sum:x.reduce((a,b)=>a+b,0),min:x.length?Math.min(...x):null,'
        + 'max:x.length?Math.max(...x):null})',
      cases: [[], [0], [-4, -2], [1, 2, 5], [7, 7]] },
    { name: 'histogram', spec: 'Input strings: count each exact string, return [string,count] pairs sorted '
      + 'lexicographically by string.',
      source: 'x => [...new Set(x)].sort().map(k=>[k,x.filter(v=>v===k).length])',
      cases: [[], ['a', 'b', 'a'], ['__proto__', ''], ['x'], ['B', 'a', 'B']] },
    { name: 'backoff', spec: 'Input {base,attempt,cap}: min(cap,base*2^max(0,trunc(attempt))).',
      source: 'x => Math.min(x.cap,x.base*2**Math.max(0,Math.trunc(x.attempt)))',
      cases: [{ base: 5, attempt: 3, cap: 100 }, { base: 3, attempt: -1, cap: 50 }, { base: 2, attempt: 8, cap: 20 },
        { base: 0, attempt: 2, cap: 20 }, { base: 3, attempt: 1.9, cap: 20 }] },
    { name: 'segments', spec: 'Input slash-separated string: split at slash, discard empty pieces, trim each '
      + 'piece, discard whitespace-only pieces.',
      source: 'x => x.split("/").map(v=>v.trim()).filter(Boolean)', cases: ['', '/', '/a//b/', ' a / b ', 'a/ /c'] },
  ]
  const files: Record<string, string> = {
    'src/interface.cjs': 'exports.version = 1; // FROZEN: modules export run(input); no cross-module imports.\n' }
  const repairs: Record<string, string> = {}, moduleChecks: Record<string, string[]> = {}
  for (const def of definitions) {
    files[`spec/${def.name}.md`] = `${def.name}: ${def.spec}\n`
      + `Only modify src/${def.name}.cjs. Keep the shared interface frozen.`
    files[`src/${def.name}.cjs`] = 'exports.run = input => { throw Error("TODO"); };\n'
    repairs[`src/${def.name}.cjs`] = `exports.run = ${def.source};\n`
    // Evaluate trusted generator functions only, never workspace code, to freeze expected results.
    const run = new Function(`return (${def.source})`)() as (input: unknown) => unknown
    moduleChecks[def.name] = def.cases.map(input => assertResult(def.name, input, run(input)))
  }
  files['SPEC.md'] = 'Implement all eight spec/*.md sections. Each module has a disjoint write set. '
    + 'src/interface.cjs is frozen. Export run(input) in each module. No imports. Run shell test or shell test '
    + '<module>. Hidden checks include edge cases.'
  return { id: 'code-change', kind: 'overhead', category: 'eight independent modules', files, repairs,
    frozen: ['src/interface.cjs'], moduleChecks, checks: Object.values(moduleChecks).flat(),
    prompt: 'Implement all eight modules in src/ following SPEC.md and each spec/*.md. Preserve the frozen '
      + 'shared interface. Verify with shell test.' }
}

function bugHunt(): Task {
  const repairs: Record<string, string> = {
    'src/cache.cjs': 'exports.expired = (now,created,ttl) => now >= created + ttl*1000;',
    'src/ranges.cjs': 'exports.overlaps = (a,b) => a[0]<b[1] && b[0]<a[1] && a[0]<a[1] && b[0]<b[1];',
    'src/billing.cjs': 'exports.total = (cents,discount,tax) => Math.round((cents-discount)*(1+tax));',
    'src/routing.cjs': 'exports.allowed = u => u.active === true && u.role === "admin";',
  }
  const files: Record<string, string> = {
    'src/cache.cjs': 'exports.expired = (now,created,ttl) => now > created + ttl;',
    'src/ranges.cjs': 'exports.overlaps = (a,b) => a[0]<=b[1] && b[0]<=a[1];',
    'src/billing.cjs': 'exports.total = (cents,discount,tax) => Math.round(cents*(1+tax)-discount);',
    'src/routing.cjs': 'exports.allowed = u => u.active === true || u.role === "admin";',
  }
  for (let i = 0; i < 26; i++) {
    files[`src/helper-${i}.cjs`] = `// Independent healthy utility ${i}\nexports.identity = x => x;\n`
  }
  files['README.md'] = 'Four independent regressions: cache.expired(nowMs,createdMs,ttlSeconds), expired at '
    + 'exact boundary; ranges.overlaps([start,end],[start,end]) uses half-open ranges, empty ranges never '
    + 'overlap; billing.total(cents,discountCents,taxFraction) applies discount BEFORE tax, rounds once; '
    + 'routing.allowed(user) requires active strictly true AND role admin. Preserve APIs, leave healthy '
    + 'utilities intact. shell test <module> accepts cache, ranges, billing, routing.'
  const moduleChecks: Record<string, string[]> = {
    cache: [[100, 100, 2, false], [2099, 100, 2, false], [2100, 100, 2, true], [2101, 100, 2, true], [0, 0, 0, true]]
      .map(([now, created, ttl, expected]) =>
        `load("src/cache.cjs").expired(${now},${created},${ttl}) === ${expected}`),
    ranges: [ [[0, 2], [2, 4], false], [[0, 3], [2, 4], true], [[1, 1], [0, 3], false],
      [[-3, -1], [0, 1], false], [[0, 3], [1, 2], true] ].map(([a, b, expected]) =>
      `load("src/ranges.cjs").overlaps(${encode(a)},${encode(b)}) === ${expected}`),
    billing: [[1000, 100, 0.2, 1080], [101, 1, 0.05, 105], [0, 0, 0.2, 0], [900, 0, 0, 900], [200, 200, 0.5, 0]]
      .map(([cents, discount, tax, expected]) =>
        `load("src/billing.cjs").total(${cents},${discount},${tax}) === ${expected}`),
    routing: [{ active: true, role: 'guest' }, { active: false, role: 'admin' }, {},
      { active: 1, role: 'admin' }, { active: true, role: 'admin' }]
      .map(u => `load("src/routing.cjs").allowed(${encode(u)}) === ${u.active === true && u.role === 'admin'}`),
  }
  return { id: 'bug-hunt', kind: 'overhead', category: 'four independent subsystems', files, repairs, moduleChecks,
    frozen: Object.keys(files).filter(name => name.includes('helper-')), checks: Object.values(moduleChecks).flat(),
    prompt: 'Find and fix the four independent bugs in this 30-source-file repo using README.md contracts. '
      + 'Preserve public APIs and healthy modules. Verify with shell test <module> and shell test.' }
}

function handlerSource(rule: string, bad: boolean): string {
  const sources: Record<string, string[]> = {
    'active-admin': ['x => x.active === true && x.role === "admin"',
      'x => x.role === "admin" || x.active === true'],
    'exact-origin': ['x => typeof x === "string" && /^https:\\/\\/example\\.com(?:\\/|$)/.test(x)',
      'x => typeof x === "string" && x.startsWith("https:")'],
    'bounded-count': ['x => Number.isInteger(x) && x >= 0 && x <= 100',
      'x => Number.isInteger(x) && x <= 100'],
  }
  return sources[rule]![Number(bad)]!
}

function review(): Task {
  const files: Record<string, string> = {}, reviewCases: NonNullable<Task['reviewCases']> = []
  const policies = ['active-admin', 'exact-origin', 'bounded-count']
  for (let i = 0; i < 12; i++) {
    const rule = policies[Math.floor(i / 4)]!
    const file = `src/handler-${String(i).padStart(2, '0')}.cjs`
    const bad = [0, 3, 5, 7, 10].includes(i)
    const source = handlerSource(rule, bad)
    files[file] = `// Policy: ${rule}\nexports.accepts = ${source};\n`
    const examples: Record<string, unknown> = {
      'active-admin': { active: true, role: 'guest' }, 'exact-origin': 'https://evil.example/', 'bounded-count': -1,
    }
    if (bad) reviewCases.push({ file, rule, example: examples[rule] })
  }
  files['POLICY.md'] = 'Each handler exports accepts(input), returning boolean. Its comment identifies its '
    + 'rule. active-admin: object with active strictly true AND role exactly admin. exact-origin: URL origin '
    + 'https://example.com, no credentials or explicit ports. bounded-count: integer from 0 through 100 '
    + 'inclusive. Report a violation only with a JSON input the ORIGINAL function accepts but its rule rejects. '
    + 'Preserve source.'
  return { id: 'review', kind: 'overhead', category: 'executable counterexample review', files, reviewCases, checks: [],
    prompt: 'Review all 12 src/ handlers against POLICY.md. Do not change source. Write findings.json '
      + '{findings:[{file,rule,example}]}. Include all proven violations with concrete JSON inputs accepted by '
      + 'the original handler but forbidden by its policy. No false positives.' }
}

function shared(): Task {
  const files: Record<string, string> = {}
  const patches: { id: string; owner: string; priority: number; after: string[] }[] = []
  const ids = ['backup', 'schema', 'assets', 'server', 'client', 'canary', 'switch', 'verify']
  for (let i = 0; i < 8; i++) {
    const own = { id: ids[i]!, owner: `team-${i}`, priority: 10 + i, after: i ? [ids[i - 1]!] : [] }
    let staleAfter: string[] = []
    if (i === 7) staleAfter = ['verify']
    else if (i > 0) staleAfter = [ids[i - 1]!]
    const conflict = { id: ids[(i + 1) % 8]!, owner: `team-${i}`, priority: 1,
      after: staleAfter }
    patches.push(own, conflict)
    files[`teams/team-${i}.json`] = encode({ proposals: [own, conflict] })
  }
  files['SPEC.md'] = 'Reconcile every teams/*.json proposal. For each id, choose owner from highest-priority '
    + 'proposal. Its after list is authoritative; lower-priority dependency proposals are stale and MUST be '
    + 'discarded (some introduce cycles). Output plan.json {steps:[{id,owner,after}]}, topologically sorted; '
    + 'lexical tie break. Sort each after array. Include each id exactly once.'
  const steps = ids.map(id => {
    const p = patches.filter(p => p.id === id).sort((a, b) => b.priority - a.priority)[0]!
    return { id, owner: p.owner, after: p.after }
  })
  return { id: 'shared-artifact', kind: 'overhead', category: 'eight conflicting fragments',
    checks: [], files, expected: { steps },
    prompt: 'Reconcile all eight migration fragments in teams/ following SPEC.md. Resolve conflicting owners '
      + 'and dependencies, including stale cyclic constraints. Write one consistent plan.json.' }
}

export function generateScaledTasks(seed: number, sequential: Task): Task[] {
  const random = seededRandom(seed)
  return [incidentExtraction(random), moduleAudit(random), migration(random),
    codeChange(), bugHunt(), sequential, review(), shared()]
}

