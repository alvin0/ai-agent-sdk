export default {
  fetch() {
    return Response.json({
      buffer: typeof globalThis.Buffer,
      process: typeof globalThis.process,
    })
  },
}
