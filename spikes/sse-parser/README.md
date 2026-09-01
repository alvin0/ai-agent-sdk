# Owned SSE parser qualification spike

This directory is intentionally outside every production package. It answers one
question: can `eventsource-parser@4.1.0` be replaced without weakening streaming
correctness, cancellation, resource bounds, or runtime portability?

The candidate follows the current WHATWG [event stream parsing algorithm](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)
and [UTF-8 decode algorithm](https://encoding.spec.whatwg.org/#utf-8-decode). It owns
the byte decoder, accepts arbitrary chunk boundaries, uses replacement decoding for
invalid UTF-8, strips only the stream-start BOM, and discards unterminated EOF data.

Default parser-owned limits are 256 KiB for a pending line, 1 MiB for assembled
event data, and 1 MiB across all pending parser storage. A limit failure is a typed
`SseResourceLimitError`; the failed parser cannot resume. Cancellation clears all
buffers and makes subsequent use fail closed.

Run the reproducible qualification from the repository root:

```sh
node --expose-gc spikes/sse-parser/evaluate.ts
```

The command runs the conformance corpus, boundary and cancellation checks, 100,000
seeded differential partitions against the exact-pinned parser, 1,000,000 seeded
byte fuzz cases, and five isolated benchmark pairs. It prints a machine-readable
JSON report. The reviewed run is archived in `report.json`; conclusions and the
deterministic E1 rule are in `REPORT.md` and the project ADR.

The reference import deliberately resolves through
`packages/provider-http/node_modules`: that production package remains the sole
direct dependency owner, while the spike evaluates the exact instance selected by
the frozen workspace lock.
