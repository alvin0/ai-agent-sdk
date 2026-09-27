import pathlib,json,shutil,hashlib,subprocess

scratch=pathlib.Path(__file__).resolve().parent
out=pathlib.Path('docs/evaluations/multi-agent-quality-2026-09-27')
live=scratch/'formal-v7'
assert json.loads((live/'complete.json').read_text())['loadedBundlesUnchanged']
quality=json.loads((live/'quality-report.json').read_text())
ref=json.loads((live/'comparison-reference'/'report.json').read_text())
base=json.loads((live/'comparison-base'/'report.json').read_text())
baseline=json.loads((scratch/'baseline.json').read_text())
stage=hashlib.sha256(subprocess.check_output(['git','diff','--cached','--binary'])).hexdigest()
assert stage==baseline['initialCachedSHA256'], 'Index changed: reconcile ownership before reporting'
patch=subprocess.check_output(['git','diff','--binary',baseline['head'],'--','packages','samples'])
assert hashlib.sha256(patch).hexdigest()==json.loads((scratch/'candidate-freeze-v7.json').read_text())['patchSHA256'], 'Current production source differs from measured candidate'
out.mkdir(exist_ok=False)
for name in ['pilot-v1','formal-v1','formal-v3','formal-v4','formal-v7','conformance-v1','conformance-v1-r2','conformance-v1-r3','conformance-v3','conformance-v4','conformance-v6','conformance-v7','conformance-v7-r2','conformance-reference-policy-regression','conformance-v7-r3','conformance-reference-policy-regression-r2','native-v1-codex','native-v1-zenmux','native-v3-codex','native-v3-zenmux','native-v4-codex','native-v4-zenmux','policy-reference-v10','policy-v6','policy-v7','native-v7-codex','native-v7-zenmux']:
    shutil.copytree(scratch/name,out/name)
for name in ['baseline.json','verification-v3.json','verification-v4.json','verification-v6.json','verification-v7.json','environment.json','strict-identity-audit-v1-v3.json','strict-identity-audit-v7.json','conformance-final-v7.patch','supplementary-verification-v7.json','commentary-policy-tests-v7.patch','conformance-policy-verification-v7.json','analysis-integrity-checks.json','candidate-freeze-v1.json','candidate-freeze-v2.json','candidate-freeze-v3.json','candidate-freeze-v4.json','candidate-freeze-v5.json','candidate-freeze-v6.json','candidate-freeze-v7.json','candidate-source-v1.patch','candidate-source-v2.patch','candidate-source-v3.patch','candidate-source-v4.patch','candidate-source-v5.patch','candidate-source-v6.patch','candidate-source-v7.patch','quality-only-managed.ts.patch','quality-only-team.ts.patch','quality-only-source-hashes.json','quality-only-definition.ts.patch','quality-only-run-agent.ts.patch']:
    shutil.copy2(scratch/name,out/name)
logs=out/'validation';logs.mkdir()
for pattern in ['*v3.log','*v4.log','*v6.log','*v7.log','*v7-r3.log','finish-v3-r2.log','candidate-sdk-v*-build.log','team-tests-v1*.log','conformance-v1*.log','core-build-v1*.log','conformance-reference-policy-regression.log','conformance-reference-policy-regression-r2.log']:
    for file in scratch.glob(pattern):shutil.copy2(file,logs/file.name)
methods=out/'methods';methods.mkdir()
for file in ['prepare-v1.py','prepare-v2.py','prepare-v3.py','prepare-v4.py','prepare-v5.py','prepare-v6.py','prepare-v7.py','verify-v7.py','identity-audit-v7.py','verify-policy-regression-v7.py','finish-v1.py','finish-v3.py','finish-v3-failed.py','finish-v3-r2-source.py','finish-v4.py','finish-v7.py','run-v3.py','run-v4.py','run-v4-precheck-failed.py','run-v7.py','publish-report.py']:
    shutil.copy2(scratch/file,methods/file)
for name in ['integrity-forged-grade','integrity-protocol-fixture-drift','integrity-duplicate-row','integrity-missing-attempt-start']:
    shutil.copy2(scratch/name/'rejection.log',logs/(name+'.log'))
verification={'indexUnchanged':stage==baseline['initialCachedSHA256'],'indexSHA256':stage,'measuredProductionPatchSHA256':hashlib.sha256(patch).hexdigest(),'fixtureSHA256':baseline['fixtureSHA256'],'local':json.loads((scratch/'verification-v7.json').read_text()),'supplementary':json.loads((scratch/'supplementary-verification-v7.json').read_text()),'qualityGates':quality,'scope':'Working tree production source, not the existing staged intermediate version. Immutable SDK hashes cover all built package outputs at cohort start/end.'}
(out/'verification.json').write_text(json.dumps(verification,indent=2)+'\n')
lines=['# Multiple-agent quality follow-up — 2026-09-27','',
    'The final v7 candidate removes SDK-mandated progress narration by default and fixes disabled-tool guidance, and shortens generic dependency/protocol descriptions. The default commentary style is now `auto`; explicit `concise` and `off` remain available. This is a public default behavior change: hosts requiring progress narration should request `concise`. The chat sample already does so. Caller-defined workflows, roles, tools and output contracts remain host-owned; lower-level team/session APIs and manual/full/reporting policies remain available.', '',
    f"Strict quality gate: **{'PASS' if quality['qualityGatePassed'] else 'NOT MET'}**. Paired efficiency/usage gate: **{'PASS' if quality['pairedEfficiencyGatePassed'] else 'NOT MET'}**. These are descriptive results on six author-exposed lifecycle families, not a universal no-regression guarantee.", '',
    'Compared with v10 in the same final cohort, Codex improves 31/36 → 36/36 and ZenMux 18/36 → 30/36, with zero new paired losses for both. Paired tokens and latency decrease for both providers. The global quality gate is still not met: ZenMux has two new primary losses versus the original BASE, and six candidate failures total. All six return unknown/null correctly but use the worker address as an evidence ID; their primary grades stay failed.', '',
    '## Quality and performance', '',
    '| Provider | Original BASE correct | v10 REFERENCE correct | v7 correct | Wins / new losses vs BASE | Wins / new losses vs v10 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |']
for provider,data in ref['models'].items():
    original=base['models'][provider];pq=original['pairedQuality'];rq=data['pairedQuality']
    lines.append(f"| {provider} | {original['allAttempts']['BASE']['correct']}/36 | {data['allAttempts']['BASE']['correct']}/36 | {data['allAttempts']['CANDIDATE']['correct']}/36 | {pq['wins']} / {pq['newLosses']} | {rq['wins']} / {rq['newLosses']} |")
lines+=['', 'Paired-success means below use the identical successful, complete-usage pairs against v10. They are conditional, and share the same candidate rows as the BASE comparison. All attempts, failures, usage gaps and dispatch counts remain in the raw reports.', '',
    '| Provider | Complete-success pairs | Tokens before → after | Token change | Latency before → after (ms) |',
    '| --- | ---: | ---: | ---: | ---: |']
for provider,data in ref['models'].items():
    before=data['pairedSuccess']['BASE'];after=data['pairedSuccess']['CANDIDATE'];delta=data['pairedSuccessTokenChangePercent']
    lines.append(f"| {provider} | {before['attempts']} | {before['meanReportedTokens']:.1f} → {after['meanReportedTokens']:.1f} | {delta:+.2f}% | {before['meanLatencyMs']:.0f} → {after['meanLatencyMs']:.0f} |")
lines+=['', 'Incomplete reported token subtotals remain incomplete. No USD, production-distribution, cross-provider billing, or statistical-superiority claim is made.', '',
    '## Mechanisms and verification', '',
    '- The old `concise` default appended mandatory progress narration after caller instructions. Chat-style providers can return that prose with final JSON. The `auto` default leaves narration to caller/model policy without stripping output, changing reasoning effort, or limiting tool use.',
    '- Controlled public-boundary probes confirm `workerTeamTools:false` supplies no team tools or advertised team tool verbs. Private attachment access now preserves false; reporting/full remain available. The strengthened public conformance assertion checks both tools and advertised system verbs for false/reporting/full policies; it fails on the old reference (32/33) and passes on v7 (33/33). The conformance CLI now returns a nonzero exit status for failed cases after preserving all results; both exit statuses are verified.',
    '- Four new model-boundary tests verify the default and explicit styles across an actual tool round, preserving caller instructions and tool execution.',
    '- Routing addresses, actual result payloads and missing/partial results are labeled separately. The SDK does not insert a domain schema, expected answer or source-ID oracle.',
    '- Terminal response is the task return value; quiet context messages do not substitute it. Generic descriptions are shortened without changing tool capabilities.',
    '- Dependency reports identify full versus truncated payloads. The scoped reader returns the same retained observation and still supports closed original producers, byte caps and Unicode boundaries.',
    '- 236 files / 3,046 tests and 33/33 public conformance pass, along with root/core typechecks, architecture lint and core pack/publint/public types. Isolated v7 builds all 26 packages.',
    '- The refused-handoff fixture rejects the second lead→consumer delivery, rather than a prose prefix. The intermediate mistakenly rejected initial task and failed; failed logs remain retained.',
    '- Analyzer independently recomputes frozen primary grades from raw text. Forged grades, fixture drift and missing/duplicate attempts are rejected.', '',
    '## Native tool acceptance', '',
    '| Provider | Real spawn | Both real measurement tools | Dependency consumer | Exact final answer |',
    '| --- | --- | --- | --- | --- |']
for provider in ['codex','zenmux']:
    checks=json.loads((out/('native-v7-'+provider)/(provider+'.json')).read_text())['checks']
    lines.append('| '+provider+' | '+' | '.join('PASS' if checks[k] else 'FAIL' for k in ['nativeSpawn','bothActualMeasurements','dependencyConsumer','finalAnswer'])+' |')
lines+=['', 'Native acceptance is candidate-only and separate from the paired benchmark. Each worker reads supplied in-memory facts with read-only authority; zero observed effects does not prove arbitrary external-tool safety.', '',
    '## Evidence, failures and limits', '',
    '- [Controlled policy probe](policy-v7/results.json), [final public conformance](conformance-v7-r3/results.json), [old-reference regression](conformance-reference-policy-regression-r2/results.json) and [verified exit codes](conformance-policy-verification-v7.json).',
    '- [Final quality gates](formal-v7/quality-report.json), [comparison versus v10](formal-v7/comparison-reference/report.json), [comparison versus original BASE](formal-v7/comparison-base/report.json), and [all 216 raw attempts](formal-v7/runs.jsonl).',
    '- [All strict failures versus v10](formal-v7/comparison-reference/failure-review.json) and [new raw losses](formal-v7/comparison-reference/new-losses.json); original BASE review is retained alongside. A correct embedded JSON answer remains a primary format failure.',
    '- Failed-source task does not explicitly specify empty IDs, while the unchanged oracle requires verified payload IDs. Addresses in `sourceIds` remain primary failures; they are not favorably regraded.',
    '- [Pilot v1](pilot-v1/quality-report.json), [full v1](formal-v1/quality-report.json) and [full v3](formal-v3/quality-report.json) and [full v4](formal-v4/quality-report.json) are retained separately, including failed quality/efficiency gates. v2 and v5 were built but never measured live. v6 failed typechecks because its first disabled-tool fix compared a string-only access type to false; it was blocked from live measurement. v7 corrects the private type and attachment normalization. Failed gates/probes remain retained.',
    '- Six families × two translations × three repeats × three arms × two providers = 216 final attempts; translations/repeats share facts. Six order permutations balance across the cohort, not within each language. One active workflow per provider; no selective retries or best-of rows.',
    '- Host controls scheduling in the cohort. Autonomous planning has only the separate native smoke; broader unseen workloads remain unverified.',
    '- This candidate combines several changes. Controlled probes establish policy consistency, not each change’s individual contribution to live gains; no isolated ablation or statistical-superiority claim is made.',
    '- Every cohort pins fixture/oracle, model/effort/limits and all built SDK hashes. Exact harness source, full source patches, build freezes and validation logs are retained. No env/auth store or HTTP bodies are copied.', '',
    'The retained v3 observer initially started before the result file existed. It failed without starting a native workflow; the main paired cohort continued unchanged. A separate observer recovery started after the file existed and scheduled the native checks once. Original failure and recovery logs/source are retained. No attempt, arm or grade was retried. The original parent helper reports that observer failure even though the main cohort completes; the final integrity/coverage checks and independent recovered observer establish completion.', '',
    '## Ownership', '',
    'The staged index is unchanged. These fixes are in the working tree; existing staged intermediate code is not the measured final source. No staging, commit, reset, stash or checkout was performed. See [verification](verification.json) and [final source freeze](candidate-freeze-v7.json).', '']
(out/'findings.md').write_text('\n'.join(lines))
hashes={str(f.relative_to(out)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(out.rglob('*')) if f.is_file()}
(out/'SHA256SUMS.json').write_text(json.dumps(hashes,indent=2)+'\n')
print(json.dumps({'evidence':str(out),'files':len(hashes),'qualityGatePassed':quality['qualityGatePassed'],'pairedEfficiencyGatePassed':quality['pairedEfficiencyGatePassed']}))
