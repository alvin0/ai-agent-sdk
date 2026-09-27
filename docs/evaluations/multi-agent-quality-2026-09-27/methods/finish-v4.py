import pathlib,subprocess,json,time,shutil
r=pathlib.Path('artifacts/multi-agent-quality-8c_f2p6p')
live=r/'formal-v4'
started={}
deadline=time.monotonic()+3600
while time.monotonic()<deadline:
    rows=[json.loads(l) for l in (live/'runs.jsonl').read_text().split('\n')[:-1]] if (live/'runs.jsonl').exists() else []
    for provider in ['codex','zenmux']:
        if provider not in started and sum(x['provider']==provider for x in rows)==108:
            out=r/('native-v4-'+provider)
            log=(r/('native-v4-'+provider+'.log')).open('w')
            proc=subprocess.Popen(['node','--env-file=.env','--experimental-strip-types','test-human/multi-agent/native-smoke.ts','--sdk-root',str(r/'candidate-sdk-v4'),'--provider',provider,'--output',str(out)],stdout=log,stderr=log)
            started[provider]=(proc,log,out)
            print('native_started',provider,flush=True)
    if (live/'complete.json').exists() and len(started)==2 and all(v[0].poll() is not None for v in started.values()):break
    time.sleep(10)
else:raise RuntimeError('cohort/native deadline; preserve partial artifacts')
for provider,(proc,log,out) in started.items():
    log.close()
    if proc.returncode!=0:raise RuntimeError('native runner failed: '+provider)
    shutil.copy2('test-human/multi-agent/native-smoke.ts',out/'source.ts')
for script in ['quality-analyze.py']:
    with (r/('final-'+script+'.log')).open('w') as log:
        subprocess.run(['python3','test-human/multi-agent/'+script,str(live)],stdout=log,stderr=log,check=True)
print('final_analysis_and_native_complete',flush=True)
