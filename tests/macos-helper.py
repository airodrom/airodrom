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
info={'CFBundleExecutable':'AirodromMenu','CFBundleIdentifier':'local.pi.bridge.fixture','CFBundlePackageType':'APPL','LSUIElement':True,'AirodromNode':node,'AirodromControl':str(control),'AirodromDataDir':str(runtime)}
with (contents/'Info.plist').open('wb') as f: plistlib.dump(info,f)
status={'state':'Connected','pid':12345,'endpoint':'http://127.0.0.1:43117','mcp':{'ready':True,'lastCallAt':None},'tasks':{'active':0,'connected':0,'total':2,'counts':{'completed':2}},'lastActivityAt':None,'lastHeartbeatAt':None,'now':1700000000000,'managed':True}
control.write_text('process.stdout.write(JSON.stringify('+json.dumps(status)+'));')
def run(*args):
 return subprocess.run([str(exe),*args],capture_output=True,text=True,timeout=30)
for action in ['status','start','stop','restart','open','cli','doctor','requalify']:
 p=run('--action',action)
 assert p.returncode==0,(action,p.stderr,p.stdout)
 assert json.loads(p.stdout)['state']=='Connected'
print('PASS: all eight CLI actions use the shared native Process runner and decode safe status')
status['tasks']['active']=1
status['product']={'control':'Ready','status':'Degraded','runtime':'Degraded','runtimeReason':'opencode_runtime_pins_changed','memory':'Ready','provider':'Unavailable','approvals':2,'mission':{'id':'c2ed1b09-65db-4ae1-9746-ad5bfe902b30','label':'Bounded local conversation','state':'running','phase':'OpenCode executing','progress':'indeterminate'},'diagnostic':'AIRODROM · PRE-RELEASE\nControl: Ready'}
control.write_text('process.stdout.write(JSON.stringify('+json.dumps(status)+'));')
p=run('--inspect-menu')
assert p.returncode==0,(p.stderr,p.stdout)
menu=json.loads(p.stdout)
assert menu['template_icon'] is True
def rows(items):
 for item in items:
  yield item
  yield from rows(item.get('items',[]))
native={item['title']:item for item in rows(menu['items'])}
assert 'Status: Degraded' in native
assert 'Approvals: 2 waiting' in native
assert native['Open Mission']['enabled'] is False # Legacy fixture has no local CLI home.
assert native['Stop Service']['enabled'] is False
assert native['Start Service']['enabled'] is False
assert native['Quit Menu Bar (service stays running)']['key']=='q'
assert any('Requalification required' in title for title in native)
assert 'token=' not in p.stdout and '127.0.0.1' not in p.stdout
print('PASS: actual native menu uses template identity, canonical degraded runtime, approval count and state-aware service controls')
info['AirodromHome']=str(root)
with (contents/'Info.plist').open('wb') as f: plistlib.dump(info,f)
p=run('--inspect-menu');assert p.returncode==0
native={item['title']:item for item in rows(json.loads(p.stdout)['items'])}
assert native['Open Mission']['enabled'] is True and native['Cancel Mission']['enabled'] is True
print('PASS: task-bound Mission open/cancel controls are enabled only for the supported local operator helper')
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
for action in ['start','stop','restart','requalify']:
 p=run(action)
 assert p.returncode==1 and 'control request is active' in json.loads(p.stdout)['message']
for action in ['status','open']:
 p=run(action)
 assert p.returncode==0 and json.loads(p.stdout)['state']=='Stopped'
lock.close()
print('PASS: held mutation flock refuses start/stop/restart while status/open remain available')
for action in ['start','stop','restart','requalify']:
 p=run(action)
 assert p.returncode==0
 with open(runtime/'macos-control.lock') as f: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('PASS: mutation lock released after every completed action; --control-locked passed to Node')
control.write_text('process.exit(1);')
p=run('start')
assert p.returncode==1
with open(runtime/'macos-control.lock') as f: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('PASS: mutation lock released after failed control process')
control.write_text('setTimeout(()=>process.stdout.write(JSON.stringify('+json.dumps(status)+')),26000);')
p=subprocess.run([str(exe),'--action','start'],capture_output=True,text=True,timeout=40)
assert p.returncode==0 and json.loads(p.stdout)['state']=='Stopped'
print('PASS: legitimate qualification-length startup exceeds the old25s deadline without interruption')
