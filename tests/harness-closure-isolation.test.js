'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeWorkerProfile } = require('../src/worker-sandbox');
const { HELPER } = require('../src/slack-credentials');
const { HostExecutor } = require('../src/host-exec');
test('ordinary and trusted workers deny helper before exec through every process API and alias', { skip: process.platform !== 'darwin' }, t => {
  assert.ok(fs.existsSync(HELPER), 'dedicated helper must exist for real OS regression');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-helper-boundary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, 'linked'), copy = path.join(root, 'renamed'), hard = path.join(root, 'hardlink');
  fs.symlinkSync(HELPER, link); fs.copyFileSync(HELPER, copy); fs.chmodSync(copy, 0o700); fs.linkSync(HELPER, hard);
  const attempts = [
    ['absolute', HELPER], ['basename/PATH', 'pi-slack-keychain'], ['cwd-relative', './pi-slack-keychain'],
    ['symlink', link], ['renamed', copy], ['hardlink', hard], ['env override', HELPER],
    ['missing domain', HELPER], ['spoofed domain', HELPER], ['dev fallback', HELPER]
  ];
  for (const trustedDeveloperMode of [false, true]) {
    const profile = makeWorkerProfile({ task: {}, workspace: root, sessionDir: root, readRoots: ['/'], writeRoots: [root], protectedRead: [], protectedWrite: [], trustedDeveloperMode, executable: process.execPath, nodePath: process.execPath, envPath: '/usr/bin/env' });
    assert.doesNotMatch(profile, /^\(allow process-exec\)$/m);
    const file = path.join(root, `worker-${trustedDeveloperMode}.sb`); fs.writeFileSync(file, profile);
    for (const [label, target] of attempts) for (const api of ['spawnSync', 'execFileSync', 'execSync']) {
      const code = `const cp=require('child_process');try { const f=${JSON.stringify(target)}; let r; if(${JSON.stringify(api)}==='spawnSync'){r=cp.spawnSync(f,['probe','invalid-account'],{stdio:'ignore'});process.exit(r.status===64?64:r.error?0:2);} else if(${JSON.stringify(api)}==='execFileSync')cp.execFileSync(f,['probe','invalid-account'],{stdio:'ignore'});else cp.execSync("'"+f+"' probe invalid-account",{stdio:'ignore'});process.exit(2);}catch(e){process.exit(e.status===64?64:0)}`;
      const child = spawnSync('/usr/bin/sandbox-exec', ['-f', file, process.execPath, '-e', code], { cwd: path.dirname(HELPER), env: { PATH: `${path.dirname(HELPER)}:/usr/bin:/bin`, PI_SLACK_KEYCHAIN_HELPER: HELPER, BRIDGE_EXECUTION_DOMAIN: 'control_plane_internal', PI_TRUSTED_DEV_MODE: '1' }, encoding: 'utf8' });
      assert.equal(child.status, 0, `${label}/${api}/trusted=${trustedDeveloperMode}: ${child.stderr}`);
    }
    const shell = spawnSync('/usr/bin/sandbox-exec', ['-f', file, '/bin/sh', '-c', '"$PI_SLACK_KEYCHAIN_HELPER" probe invalid-account'], { env: { PI_SLACK_KEYCHAIN_HELPER: HELPER }, encoding: 'utf8' });
    assert.notEqual(shell.status, 64); assert.match(shell.stderr, /Operation not permitted/);
    const read = spawnSync('/usr/bin/sandbox-exec', ['-f', file, '/bin/sh', '-c', 'cat "$PI_SLACK_KEYCHAIN_HELPER" >/dev/null'], { env: { PATH: '/usr/bin:/bin', PI_SLACK_KEYCHAIN_HELPER: HELPER }, encoding: 'utf8' });
    assert.notEqual(read.status, 0, 'helper bytes cannot be copied or interpreted');
  }
});
test('generic host executor cannot confer helper authority via allowlist, copied identity or spoofed domain', async () => {
  let calls = 0;
  const host = new HostExecutor({ allowed: [HELPER], spawnImpl: () => { calls++; throw Error('must not spawn'); }, executionDomain: 'control_plane_internal' });
  assert.equal(host.executionDomain, 'worker');
  await assert.rejects(host.run(HELPER, ['probe', 'invalid-account'], { executionDomain: 'control_plane_internal', trusted_mode: true }), /not allowlisted/);
  assert.throws(() => host.spawnTracked(HELPER, []), /not allowlisted/);
  assert.equal(calls, 0);
});
test('host capability interpreter children inherit denial before helper exec', { skip: process.platform !== 'darwin' }, async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-host-boundary-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const copy=path.join(root,'renamed');fs.copyFileSync(HELPER,copy);fs.chmodSync(copy,0o700);
  const host=new HostExecutor({allowed:[process.execPath,'/bin/sh','/missing/fixed-tool']});
  for(const file of [HELPER,copy]){
   const result=await host.run(process.execPath,['-e',`const r=require('child_process').spawnSync(${JSON.stringify(file)},['probe','invalid-account']);console.log(JSON.stringify({status:r.status,error:r.error?.code}));`]);
   assert.equal(result.exitCode,0,result.stderr);const outcome=JSON.parse(result.stdout);assert.notEqual(outcome.status,64);assert.equal(outcome.error,'EPERM');
  }
  const shell=await host.run('/bin/sh',['-c',`'${HELPER}' probe invalid-account`]);assert.notEqual(shell.exitCode,64);assert.match(shell.stderr,/Operation not permitted/);
});
