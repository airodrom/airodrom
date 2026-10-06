# Native helper fixture checks; run npm run macos:prepare first.
import fcntl,json,os,pathlib,plistlib,shutil,subprocess,tempfile,atexit
project=pathlib.Path(__file__).resolve().parent.parent
root=pathlib.Path(tempfile.mkdtemp(prefix='pi-helper-'))
atexit.register(shutil.rmtree,root,ignore_errors=True)
app=root/'Fixture.app'
contents=app/'Contents'
exe=contents/'MacOS'/'AirodromMenu'
exe.parent.mkdir(parents=True,exist_ok=True)
shutil.copy2(project/'work/macos/Pi Bridge.app/Contents/MacOS/AirodromMenu',exe)
runtime=root/'fixture-runtime'
runtime.mkdir(exist_ok=True,mode=0o700)
runtime.chmod(0o700)
control=root/'fixture-control.cjs'
node=shutil.which('node')
info={'CFBundleExecutable':'AirodromMenu','CFBundleIdentifier':'local.pi.bridge.fixture','CFBundlePackageType':'APPL','LSUIElement':True,'PiBridgeNode':node,'PiBridgeControl':str(control),'PiBridgeDataDir':str(runtime)}
with (contents/'Info.plist').open('wb') as f: plistlib.dump(info,f)
status={'state':'Connected','pid':12345,'endpoint':'http://127.0.0.1:43117','mcp':{'ready':True,'lastCallAt':None},'tasks':{'active':0,'connected':0,'total':2,'counts':{'completed':2}},'lastActivityAt':None,'lastHeartbeatAt':None,'now':1700000000000,'managed':True}
control.write_text('process.stdout.write(JSON.stringify('+json.dumps(status)+'));')
def run(*args):
 return subprocess.run([str(exe),*args],capture_output=True,text=True,timeout=30)
for action in ['status','start','stop','restart','open']:
 p=run('--action',action)
 assert p.returncode==0,(action,p.stderr,p.stdout)
 assert json.loads(p.stdout)['state']=='Connected'
print('PASS: all five CLI actions use the shared native Process runner and decode safe status')
control.write_text('console.error("SECRET_FROM_STDERR"); process.stdout.write("invalid"); process.exit(1);')
p=run('--action','status')
assert p.returncode==1 and 'SECRET' not in p.stdout+p.stderr and json.loads(p.stdout)['state']=='Error'
print('PASS: malformed reply and process stderr return a generic error without disclosure')
lock=open(runtime/'menu.lock','a+')
os.chmod(runtime/'menu.lock',0o600)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
p=run()
assert p.returncode==0 and 'already running' in p.stderr
lock.close()
print('PASS: an existing valid helper flock prevents a duplicate helper')
ui=runtime/'ui.json'
for record,mode in [({'url':'http://127.0.0.1:43117/#token=bad','port':43117},0o600),({'url':'http://example.com:43117/#token='+'a'*64,'port':43117},0o600),({'url':'http://127.0.0.1:43117/#token='+'a'*64,'port':43117},0o644)]:
 ui.write_text(json.dumps(record));ui.chmod(mode)
 p=run('--open-control-center')
 assert p.returncode==1 and not p.stdout and not p.stderr
ui.unlink()
ui.symlink_to(control)
p=run('--open-control-center')
assert p.returncode==1
ui.unlink()
print('PASS: opener refuses malformed tokens, remote origins, nonprivate files, and symlinks')
control.write_text('setInterval(()=>{},1000);')
p=run('--action','status')
assert p.returncode==1 and 'timed out' in json.loads(p.stdout)['message']
print('PASS: a hung control command is terminated after 25 seconds')

status={'state':'Stopped'
,'mcp':{'ready':False,'lastCallAt':None},'tasks':{'active':0,'connected':0,'total':0,'counts':{}},'lastActivityAt':None,'lastHeartbeatAt':None,'now':1700000000000,'managed':True}
control.write_text('if(process.argv[3]!=="--control-locked")process.exit(2); process.stdout.write(JSON.stringify('+json.dumps(status)+'));')
def run(action): return subprocess.run([str(exe),'--action',action],capture_output=True,text=True,timeout=10)
lock=open(runtime/'macos-control.lock','a+')
os.chmod(runtime/'macos-control.lock',0o600)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
for action in ['start','stop','restart']:
 p=run(action)
 assert p.returncode==1 and 'control request is active' in json.loads(p.stdout)['message']
for action in ['status','open']:
 p=run(action)
 assert p.returncode==0 and json.loads(p.stdout)['state']=='Stopped'
lock.close()
print('PASS: held mutation flock refuses start/stop/restart while status/open remain available')
for action in ['start','stop','restart']:
 p=run(action)
 assert p.returncode==0
 with open(runtime/'macos-control.lock') as f: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('PASS: mutation lock released after every completed action; --control-locked passed to Node')
control.write_text('process.exit(1);')
p=run('start')
assert p.returncode==1
with open(runtime/'macos-control.lock') as f: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('PASS: mutation lock released after failed control process')
