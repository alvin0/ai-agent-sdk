"""Descriptive paired analysis; never discard failures or substitute missing usage with zero."""
import json, pathlib, sys, statistics, hashlib
root = pathlib.Path(sys.argv[1])
rows = [json.loads(line) for line in (root / 'runs.jsonl').read_text().splitlines()]
manifest = json.loads((root / 'manifest.json').read_text())
fixture_bytes = pathlib.Path('test-human/multi-agent/fixtures-v1.json').read_bytes()
if hashlib.sha256(fixture_bytes).hexdigest() != manifest['sourceHashes']['fixtures-v1.json']:
    raise ValueError('Fixture changed after cohort freeze; cannot reuse oracle')
fixtures = json.loads(fixture_bytes)
expected_repeats = 1 if manifest['pilot'] else manifest['protocol']['repeats']
expected_ids = [f['id'] for f in fixtures if not manifest['pilot'] or f['family'] == 'late-dependency']
oracle = {f['id']: f['expected'] for f in fixtures}
keys = [(r['provider'], r['id'], r['repeat'], r['arm']) for r in rows]
expected = {(m['provider'], i, n, a) for m in manifest['protocol']['models'] for i in expected_ids for n in range(expected_repeats) for a in ['BASE', 'CANDIDATE']}
if len(keys) != len(set(keys)) or set(keys) != expected or not (root/'complete.json').exists():
    raise ValueError('Incomplete or duplicated cohort; keep raw artifacts and do not make a final comparison')
if json.loads((root/'complete.json').read_text()).get('loadedBundlesUnchanged') is not True:
    raise ValueError('Loaded SDK source integrity was not confirmed')
def measurement(row):
    result = row['result']; terminals = result.get('terminals', [])
    real = [t for t in terminals if not (row['family'] == 'failed-dependency-control' and t['worker'] == 'source_a')]
    usages = [t['data']['usage'] for t in real]
    coverage = {}
    for usage in usages:
        for k, v in usage['coverage'].items(): coverage[k] = coverage.get(k, 0) + v
    known = sum(u['reported'].get('totalTokens', 0) for u in usages)
    # No completed terminal records is missing evidence, not a zero-token call.
    authoritative = bool(real) and all(u['authoritative'] for u in usages)
    counts = {'modelCalls': 0, 'toolCalls': 0, 'providerAttempts': 0}
    for terminal in real:
        ops = terminal['data']['operationCounts']
        for key, op in [('modelCalls', 'model-call'), ('toolCalls', 'tool'), ('providerAttempts', 'provider-attempt')]: counts[key] += ops[op]['total']
    model_observed = [m for m in result.get('modelEnds', []) if not (row['family'] == 'failed-dependency-control' and m['worker'] == 'source_a')]
    model_known = sum(m['data'].get('reported', {}).get('totalTokens', 0) for m in model_observed)
    required = set(oracle[row['id']]['sourceIds'])
    synthesis = [event for event in result.get('evidence', []) if event['worker'] in ['consumer', 'lead']]
    visible = bool(synthesis) and required <= set(synthesis[0]['sourceIdsPresent']) if required else None
    return {'initialRequiredSourceIdsVisible': visible, 'reportedTokenSubtotal': known, 'completeTokenEvidence': authoritative, 'coverage': coverage, **counts,
            'elapsedMs': result.get('elapsedMs'), 'terminalRuns': len(real), 'modelEndRecords': len(model_observed),
            'tokenReconciliation': known == model_known and len(model_observed) == counts['modelCalls']}
for row in rows: row['measurement'] = measurement(row)
def mean(values): return statistics.mean(values) if values else None
def summary(selected):
    totals = [r['measurement']['reportedTokenSubtotal'] for r in selected]
    times = [r['measurement']['elapsedMs'] for r in selected if r['measurement']['elapsedMs'] is not None]
    return {'attempts': len(selected), 'correct': sum(r['grade']['correct'] for r in selected),
        'exactSourceIdentity': sum(r['grade']['exactSourceIdentity'] for r in selected), 'falseCompletion': sum(r['grade']['falseCompletion'] for r in selected),
        'effects': sum(r['result'].get('effects', 0) for r in selected),
        'sourceMarkerRows': sum(r['measurement']['initialRequiredSourceIdsVisible'] is not None for r in selected),
        'initialRequiredSourceIdsVisible': sum(r['measurement']['initialRequiredSourceIdsVisible'] is True for r in selected),
        'completeUsageRows': sum(r['measurement']['completeTokenEvidence'] for r in selected),
        'reconciledUsageRows': sum(r['measurement']['tokenReconciliation'] for r in selected),
        'reportedTokenSubtotal': sum(totals), 'meanReportedTokens': mean(totals), 'meanLatencyMs': mean(times),
        'modelCalls': sum(r['measurement']['modelCalls'] for r in selected), 'toolCalls': sum(r['measurement']['toolCalls'] for r in selected),
        'providerAttempts': sum(r['measurement']['providerAttempts'] for r in selected)}
report = {'scope': manifest['liveSurface'], 'rows': len(rows), 'models': {},
    'limitations': ['Six exposed synthetic lifecycle families, not blind/domain-general evaluation.',
    'Source visibility checks exact supplied IDs in the first prepared synthesis model request; it is not a substitute for full numeric task correctness or proof that a provider accepted the request.',
    'Host controls lifecycle timing; autonomous lead planning and production task distribution are outside this cohort.',
    'Only supplied in-memory evidence and read-only team tools are exposed; effects=0 does not prove arbitrary external-tool policy.',
    'Three repeats and two translations share family facts; they are not independent task families.',
    'Synthetic source failure has no external provider call; its canonical records are retained and excluded from provider-token totals.',
    'Total-token counters follow each provider definition and include reported cache contributions; no USD or cross-provider billing claim.',
    'Failures remain in all-attempt denominators. Efficiency primary uses matched successful rows with complete usage.']}
losses = []
for model in manifest['protocol']['models']:
    provider = model['provider']; selected = [r for r in rows if r['provider'] == provider]
    pairs = {}
    for row in selected: pairs.setdefault((row['id'], row['repeat']), {})[row['arm']] = row
    wins = []; new_losses = []; ties = 0
    paired_success = []
    for key, pair in pairs.items():
        base, candidate = pair['BASE'], pair['CANDIDATE']
        if base['grade']['correct'] and not candidate['grade']['correct']: new_losses.append(key); losses.append({'provider': provider, 'id': key[0], 'repeat': key[1], 'BASE': base, 'CANDIDATE': candidate})
        elif not base['grade']['correct'] and candidate['grade']['correct']: wins.append(key)
        else: ties += 1
        if base['grade']['correct'] and candidate['grade']['correct'] and base['measurement']['completeTokenEvidence'] and candidate['measurement']['completeTokenEvidence']: paired_success.append(pair)
    common = {a: summary([p[a] for p in paired_success]) for a in ['BASE', 'CANDIDATE']}
    before, after = common['BASE']['meanReportedTokens'], common['CANDIDATE']['meanReportedTokens']
    report['models'][provider] = {'model': model['id'], 'allAttempts': {a: summary([r for r in selected if r['arm'] == a]) for a in ['BASE', 'CANDIDATE']},
        'pairedQuality': {'pairs': len(pairs), 'wins': len(wins), 'newLosses': len(new_losses), 'ties': ties},
        'pairedSuccess': common, 'pairedSuccessTokenChangePercent': None if not before else (after / before - 1) * 100,
        'families': {f: {a: summary([r for r in selected if r['family'] == f and r['arm'] == a]) for a in ['BASE', 'CANDIDATE']} for f in manifest['protocol']['families']}}
(root/'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n')
(root/'new-losses.json').write_text(json.dumps(losses, indent=2, ensure_ascii=False)+'\n')
(root/'measured-rows.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False)+'\n')
print(json.dumps({'rows':len(rows),'models':{p:{'quality':d['pairedQuality'],'allAttempts':d['allAttempts'],'pairedSuccessTokenChangePercent':d['pairedSuccessTokenChangePercent']} for p,d in report['models'].items()}},indent=2))
