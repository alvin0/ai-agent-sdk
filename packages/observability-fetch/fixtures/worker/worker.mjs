import { runPackedFetchObservationFixture } from './fixture.mjs'

export default {
  async fetch() {
    globalThis.Buffer = undefined
    globalThis.process = undefined
    return Response.json(await runPackedFetchObservationFixture())
  },
}
