# Getting Started

Before writing code, pick the layer you want to own. The SDK is deliberately
layered, and most of the API surface makes sense only once you know which layer
you are standing on.

## Three levels of API

| Level | Entry point | You own | Use when |
| --- | --- | --- | --- |
| **Composition root** | `createAgentRuntime()` | Providers, observability, lifecycle | Almost always. Start here. |
| **Reusable definition** | `defineAgent()` + `createSession()` | Agent identity and policy as module-scope values | The same agent serves many requests |
| **Raw loop** | `runAgent()`, `runTurn()`, `ModelRegistry.stream()` | Every execution boundary, explicitly | You deliberately own history or execution policy |

```text
createAgentRuntime()                    ← providers, observability, close reports
    │
    runtime.agent({ … })                ← identity, instructions, model, capabilities
        │
        createSession({ … })            ← one conversation: history, memory, skills
            │
            run() / stream()            ← one turn
                │
        runAgent({ mode, history })     ← you own history, SDK owns execution policy
                │
        runTurn({ registry, tools })    ← you own every execution boundary
                │
        registry.stream(call)           ← you own the loop entirely
```

Descend only when the level above cannot express what you need. Every level
below the first requires you to handle history, bounds, and cancellation
yourself.

## Seven design principles

When something in the SDK looks unusual, one of these is normally the reason.

**1. Adapters are the only layer that knows a wire format.** A provider supplies
four things — `connect`, `endpointPath`, `buildBody`, `translate` — and
`stream()` lives in the base class, not in the provider. A provider therefore
cannot ship its own fetch loop that forgets attribution headers, mishandles
abort, or invents error codes.

**2. Streaming is the only path.** There is no separate non-streaming call that
could drift. A one-shot API such as `agent.generate()` drains the same stream the
live API uses.

**3. Missing data stays missing.** Token usage a provider did not report is
`missing` or `partial` — never a fabricated zero. A budget that cannot be
measured says so instead of silently passing.

**4. Privacy is the default, not a setting you remember.** Observation defaults
to `content: 'none'`. The exact-wire request logger is a separately gated
high-risk capability that refuses construction unless both `content: 'full'` and
`allowWireBodies: true` are set.

**5. Ownership and lifetime are explicit.** Every capability declares who closes
it. Nothing is auto-closed on your behalf, and nothing invents a close action for
a resource it never acquired.

**6. Runtime tiers are declared and checked.** Every package declares
`universal`, `browser`, or `node`. A static gate rejects a Universal declaration
that imports a Node builtin, and rejects an Edge journey elevated by a Node
capability.

**7. Bounds everywhere, product concepts nowhere.** 16 model steps, 64 dispatched
tools, a 500,000 aggregate reported-token ceiling, and more — all
host-configurable, none of them a tenant or a billing plan.

## What you have to do as a result

| Principle | Consequence for your code |
| --- | --- |
| Streaming only | Await `.result`, or iterate the run handle |
| Missing stays missing | Check usage coverage before charging anything to it |
| Explicit ownership | Close the runtime, then close what you connected |
| Declared tiers | Pick the package matching your deployment target |
| No model default | Always name a `model` |

## How to read these docs

| I want to… | Go to |
| --- | --- |
| Install and run something today | [Installation](/en/01-introduction/installation), [Quick Start](/en/01-introduction/quick-start) |
| Build an agent | [Agents](/en/02-agents/) |
| Give it typed functions | [Tools](/en/03-tools/) |
| Give it progressively disclosed capabilities | [Skills](/en/04-skills/) |
| Keep continuity across long tasks | [Memory](/en/05-memory/) |
| Coordinate several steps or agents | [Workflows](/en/06-workflows/) |
| Consume or publish MCP tools | [MCP](/en/07-mcp/) |
| Talk to agents in other services | [A2A](/en/08-a2a/) |
| Point the SDK at an endpoint | [Providers](/en/09-providers/) |
| Ship it to production | [Advanced](/en/10-advanced/) |
| Understand the internals | [Internals](/en/11-internals/) |
| Look up an exact export | [API Reference](/en/13-api-reference/) |
