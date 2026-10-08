#!/usr/bin/env python3
"""Recognized secrets scan with checksum-verified tool and redacted metadata only."""
import hashlib,io,json,os,platform,subprocess,tarfile,tempfile,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
TOOLS={'Linux': {'url': 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz', 'sha256': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'}, 'Darwin': {'url': 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz', 'sha256': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'}}
with tempfile.TemporaryDirectory(prefix='airodrom-secret-scan-') as tmp:
    spec=TOOLS[platform.system()]
    data=urllib.request.urlopen(spec['url'],timeout=60).read()
    if hashlib.sha256(data).hexdigest()!=spec['sha256']:raise SystemExit('Scanner checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(data)) as t:binary=t.extractfile('gitleaks').read()
    exe=Path(tmp)/'gitleaks';exe.write_bytes(binary);exe.chmod(0o700)
    failed=False
    for mode in ['dir','git']:
        report=Path(tmp)/(mode+'.json')
        args=[str(exe),mode,str(ROOT),'--config',str(ROOT/'.gitleaks.toml'),'--redact=100','--no-banner','--report-format=json','--report-path',str(report)]
        if mode=='git':args+=['--log-opts=--all --full-history']
        run=subprocess.run(args,capture_output=True)
        findings=json.loads(report.read_text()) if report.exists() else []
        safe=[{k:f.get(k) for k in ['RuleID','File','StartLine','Commit']} for f in findings]
        print(json.dumps({'scope':mode,'exit':run.returncode,'findings':safe}))
        failed=failed or run.returncode not in [0] or bool(findings)
    if failed:raise SystemExit(1)

# Additional Cursor/provider/key classes, with exact seeded fixture fingerprints.
import re
PATTERN=re.compile(b'\\bcrsr_[A-Za-z0-9_-]{20,}\\b|\\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
SYNTHETIC={'tests/authenticated-research-routing.test.js': ['830b66b4bcc6703c098ab363e05b5ed3a7ed6ea6a5ee5c4706618054a9fda72d'], 'tests/harness-outbox.test.js': ['ecdf120ffa5e0c020ab284e197cee142c7c5a5f5398cde81af076abf36787fbc'], 'tests/orchestrator-mcp.test.js': ['1acbfa87bbda198ae8f81b1d0b71de3d8809b76bff4ace7c92c92a0c8804de17'], 'tests/anthropic-subscription-provider.test.js': ['2c6d42e7459781d25d05c53cd1faa36ebdaedb2df4b8d88bba9a55c31ec6e7e5'], 'tests/personal-memory.test.js': ['3021d90eb9437b2d8f30e8363695c4418b5e5f1870801b5c317e9398ee0f572d'], 'tests/work-execution-adapter.test.js': ['435cac2329d31b5d3015e8fccd5c55aa66a09b792d857f6e3c79654a32e133a4', 'a55c75b739378dcb790c08c3d5d9aae3e5c06ed15a3d6a1a3bd59a3ab751b7ae'], 'tests/memory-erasure-lifecycle.test.js': ['56d6ef24dadc7c5afb4bc2e930e6c2e75403f4307528ed4afaf5205f8ee56222'], 'tests/capability-expansion-v2.test.js': ['16691278653edb22eaa415e39bd7aafa4c5c34776148facba70ffc86b04a3821', '464a127b800f2e34faf1ca83258a9feed9192af6d8037c56862e0d97f5540966']}
unresolved=[]
for name in json.loads((ROOT/'release-files.json').read_text()):
    data=(ROOT/name).read_bytes()
    for m in PATTERN.finditer(data):
        if hashlib.sha256(m[0]).hexdigest() not in SYNTHETIC.get(name,[]):
            unresolved.append({'file':name,'rule':'cursor-provider-private-key','line':data[:m.start()].count(b'\n')+1})
# Intended reachable history is checked by object; known non-secret fixture values remain exact.
objects=subprocess.check_output(['git','rev-list','--objects','--all'],cwd=ROOT,text=True).splitlines()
known_values={v for values in SYNTHETIC.values() for v in values}
for line in objects:
    oid=line.split()[0]
    if subprocess.check_output(['git','cat-file','-t',oid],cwd=ROOT,text=True).strip()!='blob':continue
    data=subprocess.check_output(['git','cat-file','blob',oid],cwd=ROOT)
    for m in PATTERN.finditer(data):
        if hashlib.sha256(m[0]).hexdigest() not in known_values:
            unresolved.append({'object':oid,'rule':'cursor-provider-private-key'})
print(json.dumps({'scope':'additional-cursor-provider-history','findings':unresolved}))
if unresolved:raise SystemExit(1)
