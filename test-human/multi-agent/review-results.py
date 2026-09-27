"""Secondary semantic/format review preserving every primary raw grade and pair loss."""
import pathlib, json, sys, re, hashlib
root=pathlib.Path(sys.argv[1]);fixtures=json.loads(pathlib.Path('test-human/multi-agent/fixtures-v1.json').read_text());oracle={f['id']:f['expected'] for f in fixtures}
rows=[json.loads(line) for line in (root/'runs.jsonl').read_text().splitlines()]
review=[];pairs={}
for row in rows:pairs.setdefault((row['provider'],row['id'],row['repeat']),{})[row['arm']]=row
for row in rows:
 if row['grade']['correct']:continue
 text=row['result'].get('text') or '';expected=oracle[row['id']];candidates=[]
 for match in re.finditer(r'\{[^{}]*\}',text):
  try:
   value=json.loads(match.group())
   if isinstance(value,dict) and set(value)==set(expected):candidates.append(value)
  except ValueError:pass
 unique={json.dumps(v,sort_keys=True) for v in candidates}
 actual=json.loads(next(iter(unique))) if len(unique)==1 else None
 def equal(v):
  if v is None:return False
  for key,target in expected.items():
   current=v.get(key)
   if key=='sourceIds':
    if not isinstance(current,list) or sorted(current)!=sorted(target):return False
   elif isinstance(target,(float,int)) and not isinstance(target,bool):
    if not isinstance(current,(int,float)) or abs(current-target)>1e-6:return False
   elif current!=target:return False
  return True
 semantic=equal(actual)
 counterpart=pairs.get((row['provider'],row['id'],row['repeat']),{}).get('BASE',{})
 newloss=row['arm']=='CANDIDATE' and counterpart.get('grade',{}).get('correct',False)
 numeric_unknown=actual is not None and actual.get('status')=='unknown' and all(actual.get(k) is None for k in ['totalObserved','totalBaseline','changePercent'])
 if semantic:reason='format-only: embedded answer matches all frozen facts/IDs; raw strict grade stays fail'
 elif row['family']=='failed-dependency-control' and numeric_unknown:reason='unknown/no fabricated numbers, but sourceIds is not empty: oracle requires verified evidence IDs; task does not explicitly specify empty IDs for failed sources'
 else:reason='semantic or missing answer: inspect actual, model evidence-presence and provider status; raw grade stays fail'
 evidence=row['result'].get('evidence',[])
 required=set(expected['sourceIds']);consumer=[e for e in evidence if e['worker'] in ['consumer','lead']]
 observed_required=any(required<=set(e['sourceIdsPresent']) for e in consumer) if required else None
 unsupported=actual is not None and actual.get('status')=='completed' and not semantic
 review.append({'provider':row['provider'],'id':row['id'],'repeat':row['repeat'],'arm':row['arm'],'newPairedLoss':newloss,
  'rawGrade':row['grade'],'secondaryAnswer':actual,'semanticAnswerMatches':semantic,'unsupportedCompletion':unsupported,
  'requiredEvidencePresentAtModelBoundary':observed_required,'reason':reason,'textSHA256':hashlib.sha256(text.encode()).hexdigest(),
  'disposition':'retain primary failure; no favorable regrade, selective retry or SDK regression dismissal'})
(root/'failure-review.json').write_text(json.dumps({'primaryGradeUnchanged':True,'rows':review},indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'failures':len(review),'newPairedLosses':sum(r['newPairedLoss'] for r in review),'formatOnly':sum(r['semanticAnswerMatches'] for r in review),'unsupportedCompletions':sum(r['unsupportedCompletion'] for r in review)},indent=2))
