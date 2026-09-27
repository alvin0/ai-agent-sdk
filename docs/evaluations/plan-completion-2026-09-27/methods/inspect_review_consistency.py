import json, hashlib, sys, re, unicodedata
from pathlib import Path
source, review, output = map(Path, sys.argv[1:4])
raw = source.joinpath('runs.jsonl').read_bytes()
review_raw = review.joinpath('reviews.jsonl').read_bytes()
rows = {(r['variantId'],r['repeat'],r['arm']):r for r in map(json.loads,raw.decode().splitlines())}
groups={}
def normalize(value):
    if isinstance(value,str): return re.sub(r'\s+',' ',unicodedata.normalize('NFC',value).casefold()).strip()
    if isinstance(value,list): return [normalize(v) for v in value]
    if isinstance(value,dict): return {k:normalize(v) for k,v in value.items()}
    return value
for item in map(json.loads,review_raw.decode().splitlines()):
    if item['status']!='reviewed': continue
    for score in item['scores']:
        row=rows.get((score['variantId'],score['repeat'],score['arm']))
        if row is None or row['status']!='needs-review': continue
        text=row['text'].strip()
        text=re.sub(r'^```(?:json)?\s*|\s*```$','',text)
        try: parsed=json.loads(text)
        except json.JSONDecodeError: continue
        canonical=json.dumps(normalize(parsed),sort_keys=True,ensure_ascii=False,separators=(',',':'))
        key=(score['variantId'],canonical)
        groups.setdefault(key,[]).append({'pairId':row['pairId'],'arm':row['arm'],'passed':score['passed'],'text':row['text']})
inconsistent=[{'variantId':key[0],'normalizedOutput':key[1],'ratings':ratings} for key,ratings in groups.items() if len({r['passed'] for r in ratings})>1]
result={'sourceSha256':hashlib.sha256(raw).hexdigest(),'reviewSha256':hashlib.sha256(review_raw).hexdigest(),'method':'NFC, case folding and whitespace normalization after JSON parsing; diagnostic flags for manual inspection, not automatic semantic equivalence or regrading','inconsistentGroups':inconsistent,'primaryScoresChanged':False}
with output.open('x') as file: json.dump(result,file,ensure_ascii=False,indent=2)
print(json.dumps({'groups':len(inconsistent),'output':str(output)}))
