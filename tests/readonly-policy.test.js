'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const SafetyPolicy = require('../src/safety-policy');
const { SafeDiagnostics, classify } = require('../src/safe-diagnostics');
const bash = command => ({ toolName: 'bash', input: { command } });
function fixture(t) {
  const workspace = fs.mkdtempSync('/private/tmp/readonly-policy-');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: workspace, stdio: 'pipe' }).toString().trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/example.js'), 'acceptance_criterion\nacceptance_mode\nthird\n');
  git('add', 'src'); git('commit', '-m', 'Fixture');
  const policy = new SafetyPolicy();
  const task = policy.registerTask({ id: 'read', sessionId: 'session', workspace });
  return { workspace, git, policy, task, reader: new SafeDiagnostics(policy) };
}
test('inspection forms have no approval prompts and return actual bounded evidence', async t => {
  const { policy, task, reader, git } = fixture(t);
  const cases = [
    ['git status --short', /^$/], ['git log -1 --oneline', /Fixture/], ['git diff', /^$/],
    [`git show --name-only ${git('rev-parse', '--short', 'HEAD')}`, /src\/example.js/],
    ['git show HEAD', /\+acceptance_mode/],
    ['find . -name "*.js" -type f -maxdepth 3', /src\/example.js/],
    ['find . -type d -maxdepth 1', /^src$/],
    ['grep -n "acceptance_criterion\\|acceptance_mode" src/example.js', /1:acceptance_criterion\nsrc\/example.js:2:acceptance_mode/],
    ['rg -n "acceptance_criterion|acceptance_mode" src', /2:acceptance_mode/],
    ['grep -rlF acceptance src', /^src\/example.js\n$/],
    ["sed -n '2,3p' src/example.js", /^acceptance_mode\nthird\n$/],
    ['head -n 1 src/example.js', /^acceptance_criterion\n$/],
    ['tail -n 1 src/example.js', /^third\n$/],
    ['pwd && ls -la && cat src/example.js', /acceptance_mode/],
  ];
  for (const [command, expected] of cases) {
    const result = policy.check(task.id, bash(command));
    assert.equal(result.allow, true, command); assert.equal(result.approvalId, undefined, command);
    assert.match(await reader.execute(task, command), expected, command);
  }
  assert.deepEqual(policy.list(), []);
});
test('risky shell forms still require exact approval; protected reads remain denied', t => {
  const { workspace, policy, task } = fixture(t);
  for (const command of [
    'touch sentinel', 'rm src/example.js', 'npm install package', 'brew services restart bridge',
    'launchctl kickstart service', 'curl https://example.com', 'sudo ls', 'git add src',
    'git commit -am change', 'git reset --hard', 'git fetch', 'git push',
    'git show --output=sentinel', 'git show HEAD:src/example.js', 'git show --ext-diff',
    'git -c core.pager=sh show HEAD', 'git diff --textconv',
    'find . -delete', 'find . -exec cat {} \\;', 'find -L .',
    "sed -i '' s/a/b/ src/example.js", "sed -n '1w sentinel' src/example.js",
    "sed -n '1e touch sentinel' src/example.js", 'rg --pre=sh acceptance src',
    'ls > sentinel', 'cat src/example.js | sh', 'pwd; touch sentinel',
    'pwd && touch sentinel', 'cat $(touch sentinel)', 'cat `touch sentinel`',
    'cat src/*', 'ENV=value ls', 'bash -c pwd', 'git status\ntouch sentinel',
  ]) {
    assert.equal(classify(command, workspace), null, command);
    const result = policy.check(task.id, bash(command));
    assert.equal(result.allow, false, command); assert.ok(result.approvalId, command);
  }
  fs.writeFileSync(path.join(workspace, '.env'), 'private');
  fs.symlinkSync('/etc/passwd', path.join(workspace, 'escape'));
  for (const command of ['cat .env', 'sed -n 1p .env', 'cat escape', 'head /etc/passwd']) {
    const result = policy.check(task.id, bash(command));
    assert.equal(result.allow, false, command); assert.equal(result.approvalId, undefined, command);
  }
  assert.equal(fs.existsSync(path.join(workspace, 'sentinel')), false);
});
test('Git show cannot expose protected commit content or invoke configured helpers', async t => {
  const { workspace, git, policy, task, reader } = fixture(t);
  const helper = path.join(workspace, 'helper');
  fs.writeFileSync(helper, '#!/bin/sh\ntouch "' + workspace + '/sentinel"\n'); fs.chmodSync(helper, 0o700);
  git('config', 'diff.external', helper); git('config', 'core.fsmonitor', helper);
  git('config', 'core.pager', helper); git('config', 'log.showSignature', 'true');
  git('config', 'gpg.program', helper);
  git('config', 'diff.fixture.textconv', helper);
  fs.writeFileSync(path.join(workspace, '.gitattributes'), '*.js diff=fixture\n');
  assert.match(await reader.execute(task, 'git show HEAD'), /acceptance_mode/);
  assert.equal(fs.existsSync(path.join(workspace, 'sentinel')), false);
  git('config', 'core.fsmonitor', 'false');
  fs.writeFileSync(path.join(workspace, '.env'), 'PRIVATE_SENTINEL');
  git('add', '.env'); git('commit', '-m', 'Secret fixture');
  assert.equal(policy.check(task.id, bash('git show HEAD')).allow, true);
  await assert.rejects(reader.execute(task, 'git show HEAD'), /Protected/);
  await assert.rejects(reader.execute(task, 'git show --name-only HEAD'), /Protected/);
});

test('Git show rejects historical secret renames and deleted paths', async t => {
  const { workspace, git, task, reader } = fixture(t);
  fs.writeFileSync(path.join(workspace, '.env'), 'HISTORICAL_PRIVATE_SENTINEL');
  git('add', '.env'); git('commit', '-m', 'Private fixture');
  git('mv', '.env', 'renamed.txt'); git('commit', '-m', 'Rename fixture');
  await assert.rejects(reader.execute(task, 'git show HEAD'), /Protected|ENOENT/);
  git('rm', 'src/example.js'); git('commit', '-m', 'Delete fixture');
  await assert.rejects(reader.execute(task, 'git show HEAD'), /ENOENT/);
});
