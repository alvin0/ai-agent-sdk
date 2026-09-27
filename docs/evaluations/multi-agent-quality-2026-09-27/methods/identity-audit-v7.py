import pathlib,json
p=pathlib.Path(__file__).resolve().parent
fixtures={x['id']:x['expected'] for x in json.loads(pathlib.Path('test-human/multi-agent/fixtures-v1.json').read_text())}
rows=[json.loads(l) for l in (p/'formal-v7/runs.jsonl').read_text().splitlines()]
assert len(rows)==216
collisions=[]
for row in rows:
 actual=row['grade'].get('actual');ids=actual.get('sourceIds') if actual else None
 valid=isinstance(ids,list) and all(isinstance(x,str) for x in ids)
 exact=valid and sorted(ids)==sorted(fixtures[row['id']]['sourceIds'])
 if exact!=row['grade']['exactSourceIdentity']:collisions.append({k:row[k] for k in ['provider','id','arm','repeat']})
result={'formal-v7':{'rows':len(rows),'strictArrayIdentityMatchesSavedGrade':not collisions,'collisionRows':collisions}}
(p/'strict-identity-audit-v7.json').write_text(json.dumps(result,indent=2))
assert not collisions
print(result)
