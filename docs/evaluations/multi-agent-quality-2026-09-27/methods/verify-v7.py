import pathlib,subprocess,json,concurrent.futures
p=pathlib.Path('artifacts/multi-agent-quality-8c_f2p6p')
commands={
 'tests-v7':['pnpm','exec','vitest','run'],
 'root-types-v7':['pnpm','exec','tsc','--noEmit'],
 'core-types-v7':['pnpm','--filter','@alvin0/ai-agent-sdk-core','typecheck'],
 'lint-v7':['pnpm','lint'],
 'core-pack-v7':['pnpm','--filter','@alvin0/ai-agent-sdk-core','test:pack'],
 'core-public-types-v7':['pnpm','--filter','@alvin0/ai-agent-sdk-core','check:types'],
 'core-publint-v7':['pnpm','--filter','@alvin0/ai-agent-sdk-core','check:publint'],
 'conformance-v7':['node','--experimental-strip-types','test-human/multi-agent/conformance.ts','--sdk-root',str(p/'candidate-sdk-v7'),'--output',str(p/'conformance-v7')],
}
def run(item):
 name,command=item
 with (p/(name+'.log')).open('w') as log: rc=subprocess.run(command,stdout=log,stderr=log).returncode
 print(name,rc,flush=True)
 return name,rc
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: result=dict(pool.map(run,commands.items()))
(p/'verification-v7.json').write_text(json.dumps(result,indent=2))
