import {
  assertPortableNoFollowResult,
  runPortableNoFollowFixture,
} from './fixture.mjs'

const deno = globalThis.Deno
const endpoint = deno === undefined ? globalThis.process?.argv[2] : deno.args[0]
if (endpoint === undefined) throw new Error('portable no-follow endpoint is required')
const result = await runPortableNoFollowFixture(endpoint)
assertPortableNoFollowResult(result, deno === undefined ? 'node' : 'deno')
console.log(`${deno === undefined ? 'node' : 'deno'}-no-follow:pass`)
