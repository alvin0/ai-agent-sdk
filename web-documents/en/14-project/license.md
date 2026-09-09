# License

AI Agent SDK is licensed under the **MIT License**.

The full text is in `LICENSE` at the repository root, and a copy ships in every
published package.

```text
Copyright (c) 2026 alvin0 (chaulamdinhai) <chaulamdinhai@gmail.com>
```

## What that means in practice

| You may | Conditions |
| --- | --- |
| Use it commercially | — |
| Modify it | — |
| Distribute it | Include the copyright notice and the license text |
| Sublicense it | Include the copyright notice and the license text |
| Use it privately | — |

The **only** condition is that the copyright notice and this permission notice
appear in all copies or substantial portions of the Software.

The software is provided **"as is", without warranty of any kind**, and the
authors and copyright holders are not liable for any claim or damages arising
from its use.

MIT grants no patent rights explicitly and no trademark rights to the project's
names or logos.

## Third-party licences

Production dependency SPDX expressions are checked against the design allowlist
by `pnpm check:supply-chain`, which also enforces SHA-512 lockfile integrity,
exact runtime pins, the reviewed lifecycle-script allowlist, and a clean
`pnpm audit --prod`.

Notable direct runtime dependencies:

| Dependency | Owner package |
| --- | --- |
| `eventsource-parser@4.1.0` | `@ai-agent-sdk/provider-http` (sole direct owner) |
| `@modelcontextprotocol/*` | `@ai-agent-sdk/mcp`, `mcp-server`, `mcp-node`, `mcp-node-server` |
| `@a2a-js/sdk` | `@ai-agent-sdk/a2a` |
| `@opentelemetry/api`, `@opentelemetry/api-logs` | `@ai-agent-sdk/observability-otel` (peer) |

See [the dependency policy](/en/14-project/dependency-policy) for the reviewed
exceptions and their expiry dates.

## Contributions

Contributions are accepted under the same MIT terms: any contribution
intentionally submitted for inclusion in the work is licensed under those terms,
without additional conditions, unless you explicitly state otherwise.

## Read next

- [Contributing](/en/14-project/contributing)
- [Dependency policy](/en/14-project/dependency-policy)
