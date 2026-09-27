"""Strict three-arm comparison. Derived comparisons reuse identical raw candidate rows."""
import pathlib,json,hashlib,sys,subprocess,re,math
root=pathlib.Path(sys.argv[1])
m=json.loads((root/'manifest.json').read_text())
fbytes=pathlib.Path('test-human/multi-agent/fixtures-v1.json').read_bytes()
assert hashlib.sha256(fbytes).hexdigest()==m['sourceHashes']['fixtures-v1.json'], 'fixture drift'
assert hashlib.sha256(fbytes).hexdigest()==m['protocol']['fixtureSHA256'], 'frozen protocol fixture drift'
f=json.loads(fbytes)
oracle={x['id']:x['expected'] for x in f}
cohort=[x for x in f if not m['pilot'] or x['family']=='late-dependency']
repeats=1 if m['pilot'] else m['protocol']['repeats']
rows=[json.loads(l) for l in (root/'runs.jsonl').read_text().splitlines()]
def strict_grade(row):
    result=row['result'];actual=None
    try:
        text=re.sub(r'^```(?:json)?\s*','',(result.get('text') or '').strip())
        value=json.loads(re.sub(r'\s*```$','',text),parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        if isinstance(value,dict):actual=value
    except (ValueError,TypeError):pass
    expected=oracle[row['id']]
    def ids(value):
        return '|'.join(sorted(value)) if isinstance(value,list) and all(isinstance(v,str) for v in value) else None
    identity=actual is not None and ids(actual.get('sourceIds'))==ids(expected['sourceIds'])
    numbers=all(actual is not None and (actual.get(k) is None if expected[k] is None else
        type(actual.get(k)) in (int,float) and math.isfinite(actual[k]) and abs(actual[k]-expected[k])<1e-6)
        for k in ['totalObserved','totalBaseline','changePercent'])
    correct=result.get('status')=='completed' and actual is not None and set(actual)==set(expected) and actual.get('status')==expected['status'] and identity and numbers
    return {'correct':correct,'exactSourceIdentity':identity,'falseCompletion':actual is not None and actual.get('status')=='completed' and not correct,**({} if actual is None else {'actual':actual})}
assert all(row['grade']==strict_grade(row) for row in rows), 'saved primary grade differs from frozen raw-output oracle'
expected={(p['provider'],x['id'],n,a) for p in m['protocol']['models'] for x in cohort for n in range(repeats) for a in ['BASE','REFERENCE','CANDIDATE']}
key=lambda r:(r['provider'],r['id'],r['repeat'],r['arm'])
assert len(rows)==len(expected)==len({key(r) for r in rows}) and {key(r) for r in rows}==expected, 'incomplete/duplicate cohort'
assert json.loads((root/'complete.json').read_text())['loadedBundlesUnchanged'] is True
attempts=[json.loads(l) for l in (root/'attempts.jsonl').read_text().splitlines()]
assert len(attempts)==len(expected) and {key(r) for r in attempts}==expected, 'missing attempt starts'
reports={}
for baseline in ['BASE','REFERENCE']:
    out=root/('comparison-'+baseline.lower());out.mkdir(exist_ok=True)
    subset=[]
    for r in rows:
        if r['arm'] not in [baseline,'CANDIDATE']:continue
        copy=dict(r);copy['originalArm']=r['arm'];copy['arm']='CANDIDATE' if r['arm']=='CANDIDATE' else 'BASE';subset.append(copy)
    derived=dict(m);derived.update(arms={'BASE':m['arms'][baseline],'CANDIDATE':m['arms']['CANDIDATE']},plannedAttempts=len(subset),derivation={'parent':'../runs.jsonl','baselineArm':baseline,'candidateRowsReusedAcrossComparisons':True,'newProviderCalls':0})
    (out/'manifest.json').write_text(json.dumps(derived,indent=2))
    (out/'runs.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in subset))
    (out/'complete.json').write_text((root/'complete.json').read_text())
    for script in ['analyze.py','review-results.py']:
        with (out/(script+'.log')).open('w') as log:subprocess.run(['python3','test-human/multi-agent/'+script,str(out)],stdout=log,stderr=log,check=True)
    reports[baseline]=json.loads((out/'report.json').read_text())
gates={}
for p in m['protocol']['models']:
    provider=p['provider'];ref=reports['REFERENCE']['models'][provider]
    before=ref['pairedSuccess']['BASE'];after=ref['pairedSuccess']['CANDIDATE']
    all_before=ref['allAttempts']['BASE'];all_after=ref['allAttempts']['CANDIDATE']
    pairs=before['attempts']
    gates[provider]={'zeroNewPrimaryLossesVsBASE':reports['BASE']['models'][provider]['pairedQuality']['newLosses']==0,'zeroNewPrimaryLossesVsREFERENCE':ref['pairedQuality']['newLosses']==0,'comparisonVsBASE':reports['BASE']['models'][provider]['pairedQuality'],'comparisonVsREFERENCE':ref['pairedQuality'],
        'completeSuccessPairsVsREFERENCE':pairs,'noPairedTokenIncreaseVsREFERENCE':pairs>0 and after['meanReportedTokens']<=before['meanReportedTokens'],'noPairedLatencyIncreaseVsREFERENCE':pairs>0 and after['meanLatencyMs']<=before['meanLatencyMs'],
        'allAttemptTokenMeansVsREFERENCE':{'before':all_before['meanReportedTokens'],'after':all_after['meanReportedTokens']},'allAttemptLatencyMeansVsREFERENCE':{'before':all_before['meanLatencyMs'],'after':all_after['meanLatencyMs']},
        'fullUsageCoverage':all(all_after[k]==all_after['attempts'] and all_before[k]==all_before['attempts'] for k in ['completeUsageRows','reconciledUsageRows']),
        'allAttemptCandidateCorrect':all_after['correct'],'allAttemptReferenceCorrect':all_before['correct']}
report={'rawAttempts':len(rows),'pilot':m['pilot'],'gates':gates,'qualityGatePassed':all(g['zeroNewPrimaryLossesVsBASE'] and g['zeroNewPrimaryLossesVsREFERENCE'] for g in gates.values()),'pairedEfficiencyGatePassed':all(g['noPairedTokenIncreaseVsREFERENCE'] and g['noPairedLatencyIncreaseVsREFERENCE'] and g['fullUsageCoverage'] for g in gates.values()),'limitations':['Author-exposed task families; repeated variants share facts. Not a universal or statistical guarantee.','Derived comparisons share the same candidate attempts, not independent replication.','Missing usage is unknown. No favorable primary regrade or selective retry.']}
(root/'quality-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
