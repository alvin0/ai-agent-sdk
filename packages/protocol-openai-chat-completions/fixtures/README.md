# Stream fixtures

Five `.txt` bodies, each a complete SSE response body as it arrives on the wire:
one `data:` line per event, blank-line terminated.

| File | What it is |
| --- | --- |
| `text-stream.txt` | A text answer fragmented so that cuts land inside multi-byte characters and inside a surrogate pair. Carries no usage chunk. |
| `tool-call-split-args.txt` | Two tool calls whose `arguments` arrive in fragments that split `\uXXXX` escapes, a surrogate pair, and an escaped quote. Ends with `tool_calls`, then usage, then `[DONE]`. |
| `truncated-mid-delta.txt` | Cut inside a `content` value. No trailing newline: the last event was never terminated. |
| `truncated-mid-args.txt` | Cut inside a tool call's `arguments` value, same way. |
| `done-without-finish.txt` | Every event complete and `[DONE]` delivered, but no `finish_reason` anywhere. |

These are handwritten to the Chat Completions wire shape, not captured from an
account: the properties they serve are about framing, escaping and termination,
and a recording would pin an account's model ids and token counts for no gain.
The three truncated and unfinished bodies deliberately end without a trailing
newline where the point is a half-written event, so a reader that drops the
incomplete tail and a reader that flushes it both have something to test.
