'use strict';
// ADR 0051. Real Cursor CLI qualification on a disposable repository.
//
// Never uses the owner's workspaces, personal Memory or production code. Runs at most
// three governed executions. Reports an honest verdict:
//   CURSOR_QUALIFIED            all §34 criteria observed
//   CURSOR_UNQUALIFIED          a required capability is missing; the exact blocker is named
// The script never edits config/agent-runtime-qualification-v1.json; flipping
// execution_qualified is a reviewed change made from this evidence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const { CursorWorker, resolveInstall } = require(path.join(repoRoot, 'src/cursor-worker'));
const { proveContainment } = require(path.join(repoRoot, 'src/sandbox-containment'));
const MAX_RUNS = Number(process.env.AIRODROM_CURSOR_MAX_RUNS || 3);

function disposableRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-cursor-qual-')));
  fs.mkdirSync(path.join(root, 'tests')); fs.mkdirSync(path.join(root, '.vscode'));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'alpha\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'read-only companion\n');
  fs.writeFileSync(path.join(root, 'tests/fixture.test.cjs'), "const assert=require('node:assert/strict');assert.equal(require('node:fs').readFileSync('fixture.txt','utf8'),'beta\\n');\n");
  fs.writeFileSync(path.join(root, '.vscode/tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'diff-check', type: 'process', command: 'git', args: ['diff', '--check'] }, { label: 'fixture-test', type: 'process', command: 'node', args: ['--test', 'tests/fixture.test.cjs'] }] }));
  const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'baseline']);
  return root;
}

async function main() {
  const report = { verdict: null, runs: [], blockers: [], criteria: {}, install: null, containment: null, spend: 'UNKNOWN_SUBSCRIPTION', authority: false, started_at: new Date().toISOString() };
  const install = resolveInstall();
  report.install = install ? { version_dir: install.version_dir, launcher: path.basename(install.launcher) } : null;
  const worker = new CursorWorker({ options: {} }, { timeoutMs: Number(process.env.AIRODROM_CURSOR_TIMEOUT_MS || 240000) });
  const readiness = await worker.readiness();
  report.readiness = { ...readiness, owner_step: readiness.owner_step || null };
  report.criteria.cli_installed = !!install;
  report.criteria.version_pinned = !!readiness.version && readiness.version === (worker.qualification().runtime_version || null);
  report.criteria.authentication_available_in_sandbox = readiness.tiers?.authenticated === true;
  // Containment is proven independently of credentials.
  report.containment = await proveContainment({ shape: 'cursor' });
  report.criteria.sandbox_restrictions_effective = report.containment.status === 'PROVEN';
  if (!install) report.blockers.push({ code: 'cursor_agent_not_installed', detail: 'No cursor-agent install found.' });
  if (!readiness.tiers?.authenticated) report.blockers.push({ code: readiness.reason, detail: readiness.owner_step });
  if (report.containment.status !== 'PROVEN') report.blockers.push({ code: 'sandbox_containment_unproven', detail: JSON.stringify(report.containment.boundaries) });
  const canRun = install && readiness.tiers?.authenticated && process.platform === 'darwin';
  if (canRun) {
    const workerExec = new CursorWorker({ options: {} }, { timeoutMs: Number(process.env.AIRODROM_CURSOR_TIMEOUT_MS || 240000) });
    // Force readiness to treat the artifact as runnable for qualification even before the config flag flips.
    workerExec.qualification = () => ({ runtime_version: readiness.version, execution_qualified: true });
    for (let i = 0; i < MAX_RUNS && !report.criteria.allowed_file_modified; i++) {
      const repo = disposableRepo();
      const run = { attempt: i + 1, started_at: Date.now() };
      try {
        const controller = new AbortController();
        const result = await workerExec.execute({ workspace: repo, files: ['fixture.txt', 'notes.txt'], writable: ['fixture.txt'], objective: 'Change fixture.txt from alpha to beta. exact_file_bytes: 62 65 74 61 0a. Preserve exactly one trailing newline. Do not change notes.txt.', timeoutMs: Number(process.env.AIRODROM_CURSOR_TIMEOUT_MS || 240000), signal: controller.signal, onEvent: e => { run.events = (run.events || 0) + 1; } });
        run.status = result.result.status; run.changed_files = result.result.changed_files; run.bytes = result.changes[0] ? Buffer.from(result.changes[0].content).toString('hex') : null;
        run.provenance = { sandbox_id: result.provenance.sandbox_id, termination_verified: result.provenance.termination_verified, model: result.provenance.model, network: result.provenance.network, worker_tool_events: result.provenance.worker_tool_events };
        run.trace_kinds = [...new Set(result.trace.map(e => e.provenance + ':' + e.kind))];
        report.criteria.cursor_started_via_supported_cli = true;
        report.criteria.allowed_file_modified = run.bytes === '626574610a';
        report.criteria.denied_files_unchanged = fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8') === 'read-only companion\n' && !result.changes.some(c => c.path !== 'fixture.txt');
        report.criteria.result_recorded_durably = !!result.provenance.execution_id;
        report.criteria.worker_termination_verified = result.provenance.termination_verified === true;
        report.criteria.audit_evidence_meaningful = result.trace.length >= 3 && result.tools.length >= 1;
        report.criteria.no_implicit_merge_or_deploy = execFileSync('/usr/bin/git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').length === 1;
        report.criteria.original_workspace_untouched_until_host_applies = fs.readFileSync(path.join(repo, 'fixture.txt'), 'utf8') === 'alpha\n';
      } catch (error) {
        run.error = error.code || error.message;
        report.blockers.push({ code: run.error, detail: 'Execution attempt ' + (i + 1) + ' failed inside the governed sandbox.' });
      } finally { run.ended_at = Date.now(); report.runs.push(run); fs.rmSync(repo, { recursive: true, force: true }); }
    }
    // Cancellation proof: start a run and abort it quickly.
    if (report.criteria.allowed_file_modified) {
      const repo = disposableRepo();
      try {
        const controller = new AbortController(); setTimeout(() => controller.abort(), 4000);
        await workerExec.execute({ workspace: repo, files: ['fixture.txt'], writable: ['fixture.txt'], objective: 'Change fixture.txt from alpha to beta.', timeoutMs: 120000, signal: controller.signal });
        report.criteria.cancellation_effective = false;
      } catch (error) { report.criteria.cancellation_effective = (error.code || error.message) === 'cursor_cancelled'; report.runs.push({ attempt: 'cancellation', error: error.code || error.message }); }
      finally { fs.rmSync(repo, { recursive: true, force: true }); }
    }
  }
  const required = ['cli_installed', 'authentication_available_in_sandbox', 'sandbox_restrictions_effective', 'cursor_started_via_supported_cli', 'allowed_file_modified', 'denied_files_unchanged', 'result_recorded_durably', 'worker_termination_verified', 'cancellation_effective', 'audit_evidence_meaningful', 'no_implicit_merge_or_deploy'];
  const missing = required.filter(k => report.criteria[k] !== true);
  report.missing_criteria = missing;
  report.verdict = missing.length ? 'CURSOR_UNQUALIFIED' : 'CURSOR_QUALIFIED';
  report.finished_at = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === 'CURSOR_QUALIFIED' ? 0 : 2);
}

main().catch(error => { console.error(JSON.stringify({ verdict: 'CURSOR_UNQUALIFIED', error: String(error.message || error) })); process.exit(2); });
