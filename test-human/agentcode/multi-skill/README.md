# AgentCode multi-skill release rescue

This is the heaviest human acceptance path for AgentCode. It seeds a broken
React, TypeScript, Vite, and Zustand application, gives the agent a shallow
catalog of three pinned skills.sh skills, and checks whether one continuous SDK
session can diagnose, refactor, add browser tests, survive compaction, and close
the release gates.

The prompt deliberately names work domains instead of skill IDs. A successful
run must route to and behaviorally apply:

- `systematic-debugging`
- `vercel-react-best-practices`
- `playwright-skill`

Prepare/verify configuration without filesystem or provider work:

```powershell
npm run human:agentcode:multi-skill -- --dry-run
```

Run the real exercise with the default `gpt-5.6-luna` model and `medium`
reasoning effort:

```powershell
npm run human:agentcode:multi-skill
```

Use a unique report directory when retaining several runs:

```powershell
npm run human:agentcode:multi-skill -- `
  --report-dir test-human/results/agentcode-multiskill/run-001
```

The harness verifies the pinned skills cache, atomically seeds only its owned
workspace, runs `npm ci`, prepares Chromium, and confirms that the fixture starts
red before contacting the provider. After the agent turn it runs host-owned
static/regression checks plus unit, build, and Playwright gates. One repair turn
is allowed by default in the same conversation; set `--repair-turns 0` to inspect
the first attempt without recovery.

Reports include:

- `summary.json`: overall acceptance and paths;
- `baseline.json` and `preparation.json`: controlled starting state;
- `verification-N.json`: host-owned checks and command results;
- `skill-report.json`: bounded activation, request-exposure, resource,
  application, compaction, skill-I/O, and trace evidence;
- `providers/<provider>/logs/<date>.jsonl`: isolated provider requests over time.

The overall acceptance includes a separate `skillEvidenceComplete` gate. It is
green only when every expected skill was behaviorally applied, the report has
no ordering or recorded problems, and no timeline, problem, skill, or pending
correlation records were omitted. A behaviorally-applied count alone cannot
make an incomplete audit pass.

The skill report only claims observable protocol ordering. In schema v2,
“behaviorally applied” means the model received the loaded instructions before
a successful material action (`write_file`, `replace_in_file`, `run_command`
with exit code 0 and no timeout, or
an explicitly successful provider-native action). Inspection-only operations
such as list, read, and grep do not count. Semantic understanding is established
jointly by that conservative trace and the independent application verifier.

Safety: the disposable workspace carries an ownership marker. Automatic reset
refuses a foreign/non-owned directory and rejects filesystem/project roots.
Dependency scripts are disabled during host installation. The application and
Playwright packages are still executable code during the agent's npm commands,
so run this acceptance path in a disposable environment when stronger isolation
is required.
