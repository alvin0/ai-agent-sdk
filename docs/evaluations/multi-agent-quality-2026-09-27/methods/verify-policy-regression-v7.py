import pathlib,subprocess,json,shutil,hashlib
p=pathlib.Path(__file__).resolve().parent
result={}
for name,sdk,expected in [('conformance-v7-r3',p/'candidate-sdk-v7',0),('conformance-reference-policy-regression-r2',pathlib.Path('artifacts/multi-agent-audit-n62xvl_w/final-sdk-v10'),1)]:
 with (p/(name+'.log')).open('w') as log:rc=subprocess.run(['node','--experimental-strip-types','test-human/multi-agent/conformance.ts','--sdk-root',str(sdk),'--output',str(p/name)],stdout=log,stderr=log).returncode
 assert rc==expected,(name,rc)
 src=pathlib.Path('test-human/multi-agent/conformance.ts')
 assert json.loads((p/name/'manifest.json').read_text())['harnessHash']==hashlib.sha256(src.read_bytes()).hexdigest()
 shutil.copy2(src,p/name/'source.ts')
 results=json.loads((p/name/'results.json').read_text())
 assert results['passed']==(33 if expected==0 else 32)
 result[name]={'exitCode':rc,'expectedExitCode':expected,'passed':results['passed'],'total':results['total']}
with (p/'root-types-final-v7.log').open('w') as log:rc=subprocess.run(['pnpm','exec','tsc','--noEmit'],stdout=log,stderr=log).returncode
assert rc==0
result['root-types-final-v7']=rc
(p/'conformance-policy-verification-v7.json').write_text(json.dumps(result,indent=2))
print(result)
