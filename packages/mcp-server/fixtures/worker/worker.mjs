export default {
  async fetch() {
    globalThis.Buffer = undefined
    globalThis.process = undefined
    const { runPackedMcpServerFixture } = await import('./fixture.mjs')
    return Response.json(await runPackedMcpServerFixture())
  },
}
