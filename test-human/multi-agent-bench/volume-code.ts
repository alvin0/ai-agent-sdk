/** Source plus local contract context: every operation is independently auditable/migratable. */
const choose = (random: () => number, size: number) => Math.floor(random() * size)
const encode = JSON.stringify

function contractNote(random: () => number, symbol: string): string {
  const stages = ['rollout', 'backfill', 'reconciliation', 'cutover', 'verification', 'recovery']
  const systems = ['orders', 'accounts', 'invoices', 'subscriptions', 'exports', 'catalogs']
  const stage = stages[choose(random, stages.length)], system = systems[choose(random, systems.length)]
  return ` * ${symbol} ${stage} checkpoint: this operation belongs to the ${system} lane. `
    + 'The caller has already selected a tenant and supplied a validated business identifier. '
    + 'A previous release used a different transport, so historical examples must not override the '
    + 'current contract stated below. Preserve the request identity across retries, keep the original '
    + 'payload shape, and never infer authorization from a neighboring operation. The audit trail '
    + 'records the transport result after the operation returns.\n'

}

export function auditFile(random: () => number, file: string) {
  const findings: { file: string; symbol: string; rule: string }[] = []
  const rules = ['external-consent', 'write-key', 'legal-hold']
  const badSites = [choose(random, 8) * 3, choose(random, 8) * 3 + 1, choose(random, 8) * 3 + 2]
  let text = '// Independent module. Comments are context; audit the actual API calls.\n'
  for (let index = 0; index < 24; index++) {
    const symbol = `operation${index}`, kind = index % 3, bad = badSites.includes(index)
    const exempt = !bad && random() > 0.5
    const emptyKey = bad || exempt
    const requiresGuard = !bad && !exempt
    const bindings = [
      `  const audience = ${encode(exempt ? 'internal' : 'external')};\n  const consent = ${requiresGuard};`,
      `  const mode = ${encode(exempt ? 'read' : 'write')};\n`
        + `  const idempotencyKey = ${encode(emptyKey ? '' : symbol)};`,
      `  const retention = ${encode(exempt ? 'released' : 'hold')};\n  const archiveOnly = ${requiresGuard};`,
    ]
    const calls = ['api.publish({audience,consent})', 'api.retry({mode,idempotencyKey})',
      'api.remove({retention,archiveOnly})']
    text += `\n/**\n${contractNote(random, symbol)} */\nexports.${symbol} = api => {\n`
      + `${bindings[kind]}\n  return ${calls[kind]};\n};\n`
    if (bad) findings.push({ file, symbol, rule: rules[kind]! })
  }
  return { text, findings }
}

function migrationOperation(random: () => number, index: number) {
  const symbol = `operation${index}`, write = random() > 0.5, keyed = random() > 0.5
  const seconds = 1 + choose(random, 8), status = random() > 0.5
  const route = `/${write ? 'update' : 'fetch'}/${choose(random, 9000)}`
  const key = keyed ? `stable-${choose(random, 90000)}` : ''
  const field = status ? 'status' : 'body', retry = write ? 'never' : 'safe'
  const payload = index % 2 ? '{id:input.id,value:input.value}' : '{record:input.id,amount:input.value}'
  const request = `{route:${encode(route)},body:${payload},timeoutMs:${seconds * 1000},`
    + `retry:${encode(write && keyed ? 'idempotent' : retry)}${keyed ? `,idempotencyKey:${encode(key)}` : ''}}`
  const comment = `\n/**\n`
    + ` * Current contract: ${write ? 'WRITE' : 'READ'}, timeout ${seconds} seconds, `
    + `key ${encode(key)}, return response.${field}.\n */\n`
  return { symbol, comment,
    before: `exports.${symbol} = (client,input) => client.send(${encode(route)},${payload},`
      + `{timeout:${seconds},key:${encode(key)}}).${field};\n`,
    after: `exports.${symbol} = (client,input) => client.request(${request}).${field};\n`,
    request, field }
}

export function migrationFile(random: () => number, file: string) {
  let before = '', after = ''
  const checks: string[] = []
  for (let index = 0; index < 8; index++) {
    const op = migrationOperation(random, index)
    before += op.comment + op.before; after += op.comment + op.after
    for (const input of [{ id: 'alpha', value: 7 }, { id: 'beta', value: -3 }]) {
      // Compare keys without depending on object insertion order; prove response selection too.
      checks.push(`(()=>{const input=${encode(input)},expected=${op.request};let seen;`
        + `const client={request:r=>{seen=r;return {body:{accepted:input.id},status:input.value>0?201:409}}};`
        + `const result=load(${encode(file)}).${op.symbol}(client,input);`
        + 'return Object.keys(seen).length===Object.keys(expected).length&&'
        + 'Object.keys(expected).every(k=>JSON.stringify(seen[k])===JSON.stringify(expected[k]))'
        + `&&JSON.stringify(result)===JSON.stringify(${op.field === 'body'
          ? '{accepted:input.id}' : 'input.value>0?201:409'});})()`)
    }
  }
  return { before, after, checks }
}

/** Minimal call replacements; preserve contracts and unchanged export declarations. */
export function migrationEdits(before: string, after: string) {
  const calls = (source: string) => source.match(/client\.(?:send|request)\([^\n]+(?=\.(?:body|status);)/g) ?? []
  const old = calls(before), updated = calls(after)
  return old.map((text, index) => ({ old: text, new: updated[index]! }))
}
