# License

AI Agent SDK is licensed under the **Apache License, Version 2.0**.

The full text is in `LICENSE` at the repository root, and at
<https://www.apache.org/licenses/LICENSE-2.0>.

## What that means in practice

| You may | Conditions |
| --- | --- |
| Use it commercially | — |
| Modify it | State significant changes |
| Distribute it | Include the license and `NOTICE` if present |
| Sublicense it | — |
| Use it privately | — |
| Use the contributors' patent grants | The grant terminates if you initiate patent litigation over the work |

You must retain copyright, patent, trademark, and attribution notices from the
source.

The software is provided **"as is", without warranties or conditions of any
kind**, and contributors are not liable for damages arising from its use.

Apache-2.0 does **not** grant trademark rights to the project's names or logos.

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

Contributions are accepted under the same Apache-2.0 terms, per section 5 of the
license: any contribution intentionally submitted for inclusion in the work is
licensed under those terms, without additional conditions, unless you explicitly
state otherwise.

## Read next

- [Contributing](/en/14-project/contributing)
- [Dependency policy](/en/14-project/dependency-policy)
