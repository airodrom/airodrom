const test = require('node:test');
const assert = require('node:assert/strict');
const Rpc = require('../src/rpc-supervisor');

function failingWorker(stderr) {
  const source = `setTimeout(() => { process.stderr.write(${JSON.stringify(stderr)}); process.exit(1); }, 60); process.stdin.resume();`;
  return new Rpc({ executable: process.execPath, args: ['-e', source], cwd: process.cwd(), env: process.env, allowUnsandboxedTestFixture: true });
}

async function expectWorkerExit(stderr, check) {
  const rpc = failingWorker(stderr);
  await assert.rejects(rpc.start(), error => {
    assert.match(error.message, /^Pi exited \(1\)/);
    check(error.message);
    return true;
  });
}

test('all transports reject direct bash and session reassignment before any process exists', async () => {
  for (const Transport of [Rpc, require('../src/local-transport')]) {
    const rpc = new Transport();
    for (const type of ['bash','user_bash','switch_session','new_session','set_model','quit','__proto__']) await assert.rejects(rpc.sendCommand({ type, command: 'echo bypass' }), /not allowed/);
  }
});

test('Pi RPC refuses to spawn when the host OS sandbox is missing', async () => {
  const rpc = new Rpc({ executable: process.execPath, args: [] });
  await assert.rejects(rpc.start(), /sandbox is required/);
  assert.equal(rpc.running, false);
  assert.equal(rpc.child, undefined);
});

test('failed worker exit includes sanitized buffered stderr', async () => {
  await expectWorkerExit('worker bootstrap failed\n', message => assert.match(message, /worker bootstrap failed/));
});

test('module-not-found absolute paths expose only their basename', async () => {
  await expectWorkerExit("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/hidden/operator/foo.js'\n", message => {
    assert.match(message, /; missingModule=foo\.js:/);
    assert.doesNotMatch(message, /private|hidden|operator/);
  });
});

test('module-not-found file URLs expose only their basename', async () => {
  await expectWorkerExit("Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'file:///private/hidden/loader.mjs?token=secret-value#fragment'\n", message => {
    assert.match(message, /; missingModule=loader\.mjs:/);
    assert.doesNotMatch(message, /private|hidden|token|secret-value|fragment/);
  });
});

test('module-not-found scoped packages expose their package root', async () => {
  await expectWorkerExit("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@scope/package/subpath' imported from /private/hidden/entry.mjs\n", message => {
    assert.match(message, /; missingModule=@scope\/package:/);
    assert.doesNotMatch(message, /missingModule=@scope\/package\/subpath/);
  });
});

test('module-not-found diagnostics keep secret and path material absent', async () => {
  await expectWorkerExit("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/hidden/safe.mjs?token=secret-value'\nauthorization=Bearer private-token\n", message => {
    assert.match(message, /; missingModule=safe\.mjs:/);
    assert.doesNotMatch(message, /private|hidden|secret-value|private-token|token=/);
  });
});

test('malformed module identifiers reveal nothing', async () => {
  await expectWorkerExit("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '../untrusted/module.js'\n", message => {
    assert.doesNotMatch(message, /missingModule=/);
  });
});

test('failed worker exit redacts secret-like stderr values', async () => {
  await expectWorkerExit('api_key=super-secret-value\n', message => {
    assert.doesNotMatch(message, /super-secret-value/);
    assert.match(message, /redacted/);
  });
});

test('failed worker exit redacts absolute stderr paths', async () => {
  await expectWorkerExit('cannot load /Users/example/private/project/worker.js\n', message => {
    assert.doesNotMatch(message, /\/Users\/example\/private/);
    assert.match(message, /\[redacted-path\]/);
  });
});

test('failed worker exit bounds long stderr', async () => {
  await expectWorkerExit('x'.repeat(12000), message => {
    assert.ok(message.length <= 2040, `diagnostic was ${message.length} characters`);
    assert.match(message, /truncated/);
  });
});

test('failed worker exit with empty stderr retains the useful exit error', async () => {
  await expectWorkerExit('', message => assert.equal(message, 'Pi exited (1)'));
});

test('successful RPC request behavior remains unchanged', async () => {
  const source = `
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: { command: request.type } }) + '\\n');
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `;
  const rpc = new Rpc({ executable: process.execPath, args: ['-e', source], cwd: process.cwd(), env: process.env, allowUnsandboxedTestFixture: true });
  const state = await rpc.start();
  assert.deepEqual(state, { command: 'get_state' });
  assert.deepEqual(await rpc.sendCommand({ type: 'get_session_stats' }), { command: 'get_session_stats' });
  await rpc.shutdown();
  assert.equal(rpc.running, false);
});
