import pathlib,subprocess,hashlib,json,tarfile
root=pathlib.Path('artifacts/multi-agent-quality-8c_f2p6p').resolve()
sdk=root/'candidate-sdk-v7'
sdk.mkdir()
archive=pathlib.Path('artifacts/neutral-evaluation/codex-luna-baseline-20260926-v1/sdk-source.tar').resolve()
with tarfile.open(archive) as t:t.extractall(sdk,filter='data')
head=json.loads((root/'baseline.json').read_text())['head'] if 'head' in json.loads((root/'baseline.json').read_text()) else subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()
patch=subprocess.check_output(['git','diff','--binary',head,'--','packages','samples'])
(root/'candidate-source-v7.patch').write_bytes(patch)
subprocess.run(['git','apply','--unsafe-paths','--directory='+str(sdk.relative_to(pathlib.Path.cwd())),str(root/'candidate-source-v7.patch')],check=True)
with (root/'candidate-sdk-v7-install.log').open('w') as out: subprocess.run(['pnpm','install','--offline','--frozen-lockfile','--ignore-scripts'],cwd=sdk,stdout=out,stderr=out,check=True)
with (root/'candidate-sdk-v7-build.log').open('w') as out: subprocess.run(['pnpm','build'],cwd=sdk,stdout=out,stderr=out,check=True)
(root/'candidate-freeze-v7.json').write_text(json.dumps({'sdkRoot':str(sdk),'head':head,'patchSHA256':hashlib.sha256(patch).hexdigest(),'archiveSHA256':hashlib.sha256(archive.read_bytes()).hexdigest()},indent=2))
print('final candidate built')
