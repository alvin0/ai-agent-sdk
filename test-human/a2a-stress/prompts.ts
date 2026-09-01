export const EXPECTED_WORKERS = Object.freeze(['delivery', 'analytics', 'collaboration'] as const)
export const EXPECTED_SIGNALS = Object.freeze([
  'DELIVERY-BOARD-READY',
  'FORECAST-LAB-READY',
  'DECISION-CENTER-READY',
] as const)
export const FINAL_DECISION = 'LAUNCHPAD-MVP-READY'

const PRODUCT_BRIEF = `
Build LaunchPad Ops: a polished, responsive, zero-dependency web MVP for a SaaS
launch team. It must be a real interactive website, not a report or mock data
dump. The seeded workspace contains the product brief, shared state contract,
sample data, index.html, and build script. Feature modules are intentionally
missing and must be implemented by agents.

The finished MVP must provide all of these user journeys:
- delivery board: search and filter work items, add a work item, and advance its
  status while showing owner, priority, due date, and blocked state;
- forecast lab: calculate completion/readiness/budget metrics, render an SVG
  progress visualization, and let the user change capacity and risk assumptions;
- decision center: add launch decisions, filter the activity feed, export a JSON
  snapshot, and persist user changes through the shared store;
- integrated shell: responsive navigation, launch status hero, usable empty
  states, accessible labels, and all three features on one coherent page.
`.trim()

export const MANAGED_STRESS_PROMPT = `
${PRODUCT_BRIEF}

You are the lead engineer. This task is deliberately split into independent
vertical slices and must exercise the managed A2A team.

Mandatory orchestration:
1. Call list_agents. Then create exactly three workers with spawn_agent named
   delivery, analytics, and collaboration. Issue all three independent
   spawn_agent calls in the same model step so they run concurrently.
2. Delegate the complete file ownership and acceptance contract below. Do not
   implement a worker-owned feature yourself and never let two agents edit the
   same file.
3. After all spawn results return, inspect every feature, test, and handoff doc.
   Integrate them by writing src/app.js and src/styles.css. Then run both
   npm test and npm run build with run_command.
4. Fix integration-only defects yourself. Do not report success until dist/ is
   created and host-verifiable.

Worker assignments:
- delivery owns only src/features/delivery.js, tests/delivery.test.mjs, and
  docs/delivery.md. Read product/delivery.md, shared core modules, and
  pressure/delivery.txt. Implement mountDelivery plus pure filtering/status
  helpers. Required marker: data-feature="delivery-board" and exact handoff
  signal DELIVERY-BOARD-READY.
- analytics owns only src/features/analytics.js, tests/analytics.test.mjs, and
  docs/analytics.md. Read product/analytics.md, shared core modules, and
  pressure/analytics.txt. Implement mountAnalytics plus pure readiness, budget,
  and forecast helpers and an SVG visualization. Required marker:
  data-feature="forecast-lab" and signal FORECAST-LAB-READY.
- collaboration owns only src/features/collaboration.js,
  tests/collaboration.test.mjs, and docs/collaboration.md. Read
  product/collaboration.md, shared core modules, and
  pressure/collaboration.txt. Implement mountCollaboration plus pure activity
  filtering and snapshot export helpers. Required marker:
  data-feature="decision-center" and signal DECISION-CENTER-READY.

Every worker must call list_files, grep_files, read_file, write_file, and
run_command; it must read its pressure file deeply enough to exercise automatic
token compaction, write all three owned files, run its own test with
npm test -- tests/<name>.test.mjs, read back its source and handoff doc, and
return an evidence-backed result. Large context is intentional: retain the file
ownership and product objective across compaction.

Coordinator integration contract:
- src/app.js must import and mount all three feature modules, expose a visible
  LaunchPad Ops header, subscribe to the shared store, and include exact marker
  data-app="launchpad-ops";
- src/styles.css must deliver a responsive, polished dashboard rather than raw
  unstyled controls;
- write docs/mvp-report.md citing all three signals, owned paths, test/build
  results, and exact final signal LAUNCHPAD-MVP-READY;
- read back the integrated source and report, run the full test/build gates, then
  return the website path and concise product summary.
`.trim()

export const DEFINED_STRESS_PROMPT = `
${PRODUCT_BRIEF}

You are lead engineer of a pre-defined LaunchPad Ops product team. The stable
roster already contains delivery, analytics, and collaboration specialists. Do
not spawn or impersonate another agent.

Mandatory orchestration:
1. Call list_agents and verify all three predefined peers.
2. Call followup_task once for each peer and tell it to execute its standing
   vertical-slice assignment. The three tasks are independent.
3. On the next model step call wait_agents with all three names. Do not begin
   integration before wait_agents returns.
4. Each specialist must create its feature source, unit test, and handoff doc,
   run its own test, then call send_message back to coordinator with its exact
   READY signal, owned paths, and test result. Treat those attributed messages
   as the merge-ready handoff record.
5. Read all nine worker-owned artifacts. Integrate them by writing src/app.js
   and src/styles.css, then run npm test and
   npm run build with run_command.

The integrated website must support the delivery-board, forecast-lab, and
decision-center journeys in the product brief. src/app.js must mount every
feature and contain data-app="launchpad-ops". Write docs/mvp-report.md with
DELIVERY-BOARD-READY, FORECAST-LAB-READY, DECISION-CENTER-READY, full gate
results, and LAUNCHPAD-MVP-READY. Read the final source/report back and return
the built dist/ path. Do not substitute prose for working website files.
`.trim()

export function specialistInstructions(
  worker: typeof EXPECTED_WORKERS[number],
): string {
  const assignments = {
    delivery: [
      'Own only src/features/delivery.js, tests/delivery.test.mjs, and docs/delivery.md.',
      'Read product/delivery.md, src/core/*.js, and pressure/delivery.txt.',
      'Build an interactive searchable/filterable delivery board with add and status-advance actions.',
      'Export mountDelivery and pure helpers; include data-feature="delivery-board" and DELIVERY-BOARD-READY.',
    ],
    analytics: [
      'Own only src/features/analytics.js, tests/analytics.test.mjs, and docs/analytics.md.',
      'Read product/analytics.md, src/core/*.js, and pressure/analytics.txt.',
      'Build readiness, budget, and forecast calculations plus capacity/risk controls and an SVG chart.',
      'Export mountAnalytics and pure helpers; include data-feature="forecast-lab" and FORECAST-LAB-READY.',
    ],
    collaboration: [
      'Own only src/features/collaboration.js, tests/collaboration.test.mjs, and docs/collaboration.md.',
      'Read product/collaboration.md, src/core/*.js, and pressure/collaboration.txt.',
      'Build decision capture, activity filtering, snapshot export, and persisted store mutations.',
      'Export mountCollaboration and pure helpers; include data-feature="decision-center" and DECISION-CENTER-READY.',
    ],
  } as const
  return [
    `You are the pre-defined ${worker} product engineer reporting to coordinator.`,
    ...assignments[worker],
    'Call list_files, grep_files, read_file, write_file, and run_command.',
    `Run npm test -- tests/${worker}.test.mjs, then read your source and handoff doc back.`,
    'The large pressure file must be read so automatic compaction occurs; continue the original task afterward.',
    'After verification call send_message targeting coordinator with owned paths, exact READY signal, and test result.',
    'Return the same implementation-backed handoff as your final answer. Never edit another agent or coordinator file.',
  ].join(' ')
}

export const MANAGED_WORKER_INSTRUCTIONS = [
  'You are a dynamically created LaunchPad Ops product engineer.',
  'Follow the delegated vertical slice and exclusive file ownership exactly.',
  'Use list_files, grep_files, read_file, write_file, and run_command against the workspace.',
  'Implement working website code and unit tests, not an analysis-only report.',
  'Read the assigned pressure file to exercise compaction and retain the product objective afterward.',
  'Run your owned test, read back source and handoff doc, and return paths, exact READY signal, behavior, and test evidence.',
].join(' ')
