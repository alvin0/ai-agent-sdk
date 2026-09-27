import pathlib,time,subprocess,json
p=pathlib.Path('artifacts/multi-agent-quality-8c_f2p6p')
for i in range(360):
    if 'final_analysis_and_native_complete' in (p/'finish-v3-r2.log').read_text():break
    time.sleep(5)
else:raise RuntimeError('previous cohort/native did not complete')
assert (p/'formal-v3'/'quality-report.json').exists()
assert (p/'verification-v4.json').exists() and not any(json.loads((p/'verification-v4.json').read_text()).values())
with (p/'formal-v4.log').open('w') as log:
    run=subprocess.Popen(['node','--env-file=.env','--experimental-strip-types','test-human/multi-agent/quality-runner.ts','--baseline','artifacts/plan-completion-hHIqY2/candidate-sdk','--reference','artifacts/multi-agent-audit-n62xvl_w/final-sdk-v10','--candidate',str(p/'candidate-sdk-v4'),'--output',str(p/'formal-v4')],stdout=log,stderr=log)
    print('formal_v4_started',flush=True)
    time.sleep(1)
    with (p/'finish-v4.log').open('w') as finishlog:
        finish=subprocess.Popen(['python3',str(p/'finish-v4.py')],stdout=finishlog,stderr=finishlog)
        rc=run.wait();frc=finish.wait()
        print('cohort_exit',rc,'analysis_native_exit',frc,flush=True)
        assert rc==frc==0
