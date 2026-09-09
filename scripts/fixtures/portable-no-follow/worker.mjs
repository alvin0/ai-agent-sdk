import {
  assertPortableNoFollowResult,
  runPortableNoFollowFixture,
} from './fixture.mjs'

export default {
  async fetch(request) {
    const endpoint = new URL(request.url).searchParams.get('endpoint')
    const result = await runPortableNoFollowFixture(endpoint)
    assertPortableNoFollowResult(result, 'workerd')
    return Response.json(result)
  },
}
