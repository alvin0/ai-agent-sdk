# External skills.sh website showcase

This is a live acceptance test, not a scripted demo with locally authored skills.
It acquires Anthropic's public
[`frontend-design`](https://skills.sh/anthropics/skills/frontend-design) skill,
pins the upstream Git commit, verifies the installed directory hash, and exposes
only that skill to a real SDK agent session.

```powershell
npm run human:skill-showcase
```

Defaults are Codex `gpt-5.6-luna` with reasoning effort `medium`. Provider request
logs are isolated under the run report. Alternative live providers can be selected:

```powershell
npm run human:skill-showcase -- `
  --provider openai `
  --model gpt-5.6 `
  --effort medium
```

Use `--dry-run` to inspect configuration without downloading a skill or calling a
provider.

## What makes the proof meaningful

The prompt describes a fictional night-train product and functional behavior, but
does not prescribe an aesthetic. The upstream skill contributes its own design
process: subject-grounded art direction, a deliberate palette and type system, a
signature element, a two-pass critique, responsive behavior, keyboard focus, and
reduced-motion restraint.

The host rejects the run unless all of these are true:

- initial model context contains only skill metadata, not the full upstream body;
- the model calls `load_skill` before its first workspace write;
- a phrase from the pinned upstream body appears in a later model request;
- the generated website contains functional comparison, departure selection, and
  local persistence;
- `design-rationale.md` carries evidence of the upstream two-pass design process;
- the model creates and observes a green `npm test` run;
- the deep completion gate and trace both complete cleanly.

If the host-owned artifact checks fail, the harness feeds only those failed checks
back into the same conversation for up to two repair turns. This deliberately
tests whether the agent can revisit the upstream instructions and improve real
files instead of weakening the verifier.

Every run leaves the website under
`test-human/workspaces/skill-showcase/<run-id>/` and bounded event, request-shape,
skill-I/O, trace, provider, and summary reports under
`test-human/results/skill-showcase/<run-id>/`.

The source is locked in `skill-sources.lock.json` with:

- the exact Skills CLI version;
- an immutable GitHub commit archive;
- the resolved 40-character revision;
- whole-directory SHA-256 and file count;
- the original skills.sh registry URL.

Downloaded skill scripts are not executed by the acquisition step. The prepared
copy is cached under this folder's ignored `.cache/` directory and reverified on
every reuse.

After a passing run, use the printed `cd ...; npm start` command to inspect the
website in a browser without downloading another preview dependency.
