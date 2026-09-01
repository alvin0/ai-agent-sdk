export default {
  async fetch() {
    globalThis.Buffer = undefined
    globalThis.process = undefined
    const { runPackedMcpFixture } = await import('./fixture.mjs')
    return Response.json(await runPackedMcpFixture())
  },
}
