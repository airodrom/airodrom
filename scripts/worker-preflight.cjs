#!/usr/bin/env node
'use strict';

// This harness is intentionally preflight-only. It never launches Pi, issues a
// grant, contacts Ollama, or starts the bridge service.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { WorkerSandbox, MANIFEST_PATH, readManifest, inspectProbe } = require('../src/worker-sandbox');
const { ACTIVE_CHAT_PROFILE_ID, missionFields, prepareFixtures } = require('../src/active-chat-mission');

const REPOSITORY = path.resolve(__dirname, '..');
const OLLAMA_TCP_PROBE = String.raw`
const net=require('node:net');
process.stdout.write('node-reached-javascript\n');
const s=net.createConnection({host:'127.0.0.1',port:11434});
const timer=setTimeout(()=>{s.destroy();process.stderr.write('ollama TCP probe timed out');process.exitCode=41},1000);
s.once('connect',()=>{clearTimeout(timer);s.destroy();process.stderr.write('sandbox unexpectedly allowed Ollama TCP');process.exitCode=41});
s.once('error',e=>{clearTimeout(timer);if(['EPERM','EACCES'].includes(e.code)){process.stdout.write('ollama-tcp-denied\n');return}process.stderr.write('Ollama TCP denial probe inconclusive: '+e.code);process.exitCode=41});
`;

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function parseArguments(argv) {
  const argumentsSet = new Set(argv);
  for (const argument of argumentsSet) {
    if (argument !== '--describe' && argument !== '--active-chat') throw new Error(`Unsupported preflight argument: ${argument}`);
  }
  return { describeOnly: argumentsSet.has('--describe'), activeChat: argumentsSet.has('--active-chat') };
}
function describe(manifest = readManifest(MANIFEST_PATH), { activeChat = false } = {}) {
  const node = manifest.executables.find(item => item.id === 'node');
  const command = [node?.path || '<pinned-node>', path.join(REPOSITORY, 'scripts/worker-preflight.cjs')];
  if (activeChat) command.push('--active-chat');
  return {
    kind: 'WORKER_SANDBOX_PREFLIGHT_ONLY', executionContext: 'operator-terminal',
    executable: node?.path || null,
    command,
    mandatoryPreparation: 'WorkerSandbox.prepare()',
    temporaryRoot: '/private/tmp/pi-bridge-worker-preflight-*',
    profile: activeChat ? ACTIVE_CHAT_PROFILE_ID : 'canonical-worker-sandbox',
    probes: activeChat
      ? ['canonical-seatbelt-probes', 'active-chat-seatbelt-probes', 'exact-unix-policy-socket-connectivity', 'direct-tcp-127.0.0.1:11434-denied']
      : ['canonical-seatbelt-probes', 'exact-unix-policy-socket-connectivity', 'direct-tcp-127.0.0.1:11434-denied'],
    ...(activeChat ? { fixture: 'per-run sealed disposable fixture; its content is neither logged nor supplied to the probe' } : {}),
    prohibitedEffects: ['Pi launch', 'Pi inference', 'bridge start', 'mission grant', 'credential access', 'Ollama HTTP request']
  };
}
function verifyHarness(manifest) {
  const pin = manifest.preflightHarness;
  if (!pin || pin.path !== 'scripts/worker-preflight.cjs' || !/^[a-f0-9]{64}$/.test(pin.sha256) || sha256(__filename) !== pin.sha256) {
    throw new Error('Pinned worker preflight harness verification failed');
  }
  const node = manifest.executables.find(item => item.id === 'node');
  if (!node || fs.realpathSync(node.path) !== fs.realpathSync(process.execPath)) throw new Error('Preflight must use the manifest-pinned Node executable');
}
function notAttemptedProbe(stage, expectedMarker, reason) {
  return { stage, childStatus: null, signal: null, errorCode: null, timedOut: false, nodeReachedJavaScript: false, expectedMarker, markerPresent: false, stdout: '', stderr: '', success: false, skipped: true, reason };
}
function mergeDiagnostics(base, error) {
  return { ...base, ...(error?.probeDiagnostics || {}) };
}
function probeFailure(prefix, diagnostics) {
  const error = new Error(`${prefix}: ${diagnostics.reason || 'probe failed without a reported reason'}`);
  error.probeDiagnostics = { [diagnostics.stage]: diagnostics };
  return error;
}
function failureReport(error) {
  const fallback = {
    canonical: notAttemptedProbe('canonical-seatbelt-probes', 'seatbelt-probes-passed', 'not attempted: preflight failed before canonical probe diagnostics were available'),
    level1: notAttemptedProbe('level1-seatbelt-probes', 'level1-seatbelt-probes-passed', 'not attempted: preflight failed before Level 1 probe diagnostics were available'),
    activeChat: notAttemptedProbe('active-chat-seatbelt-probes', 'active-chat-seatbelt-probes-passed', 'not attempted: preflight failed before Active Chat probe diagnostics were available'),
    exactOllamaTcp: notAttemptedProbe('exact-ollama-tcp-probe', 'ollama-tcp-denied', 'not attempted: preflight failed before exact Ollama TCP probe diagnostics were available')
  };
  return { kind: 'WORKER_SANDBOX_PREFLIGHT_ONLY', status: 'failed', error: error?.message || 'Preflight failed without a reported reason', probes: mergeDiagnostics(fallback, error) };
}
async function listen(server, socketPath) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
}
function preflightTask({ activeChat, workspace, sessionDir, workerProfile }) {
  const id = `preflight-${crypto.randomUUID()}`;
  const task = {
    id, workspace, sessionDir, workerProfile,
    workerToken: crypto.randomBytes(32).toString('hex'), mission: { requireGrant: false }
  };
  if (!activeChat) return task;
  const fixtures = prepareFixtures(workspace);
  task.mission = missionFields({ id: crypto.randomUUID(), workspace, fixtures });
  task.activeChat = { phase: 'task_a_running' };
  task.localOllamaTransport = true;
  return task;
}
function removePreflightRoot(root) {
  // Only the root made by this process is unsealed for cleanup. No existing
  // workspace or fixture permissions are touched.
  const fixtureDirectory = path.join(root, 'workspace', 'evidence');
  try {
    const stat = fs.lstatSync(fixtureDirectory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.chmodSync(fixtureDirectory, 0o700);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
async function run({ activeChat = false } = {}) {
  const manifest = readManifest(MANIFEST_PATH);
  verifyHarness(manifest);
  const probeDiagnostics = {
    canonical: notAttemptedProbe('canonical-seatbelt-probes', 'seatbelt-probes-passed', 'not attempted: WorkerSandbox.prepare() has not started'),
    level1: notAttemptedProbe('level1-seatbelt-probes', 'level1-seatbelt-probes-passed', 'not attempted: generic preflight has no Level 1 mission'),
    activeChat: notAttemptedProbe('active-chat-seatbelt-probes', 'active-chat-seatbelt-probes-passed', activeChat ? 'not attempted: Active Chat WorkerSandbox.prepare() has not started' : 'not attempted: generic preflight has no Active Chat mission'),
    exactOllamaTcp: notAttemptedProbe('exact-ollama-tcp-probe', 'ollama-tcp-denied', 'not attempted: WorkerSandbox.prepare() has not completed')
  };
  const root = fs.mkdtempSync(path.join('/private/tmp', 'pi-bridge-worker-preflight-'));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, 'workspace');
  const sessionDir = path.join(root, 'session');
  const workerProfile = path.join(sessionDir, 'profile');
  const socketPath = path.join(root, 'policy.sock');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workerProfile, { recursive: true, mode: 0o700 });
  const server = http.createServer((request, response) => { response.writeHead(204); response.end(); });
  let listening = false;
  try {
    await listen(server, socketPath);
    listening = true;
    const sandbox = new WorkerSandbox({ repoRoot: REPOSITORY, dataDir: path.join(root, 'runtime') });
    const task = preflightTask({ activeChat, workspace, sessionDir, workerProfile });
    let prepared;
    try {
      prepared = sandbox.prepare(task, { executable: manifest.worker.launcher, socketPath });
    } catch (error) {
      error.probeDiagnostics = mergeDiagnostics(probeDiagnostics, error);
      throw error;
    }
    Object.assign(probeDiagnostics, prepared.preflightDiagnostics || {});
    const child = spawnSync(prepared.sandboxExec, ['-f', prepared.profilePath, process.execPath, '-e', OLLAMA_TCP_PROBE], {
      cwd: prepared.cwd, env: prepared.env, encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024
    });
    probeDiagnostics.exactOllamaTcp = inspectProbe('exact-ollama-tcp-probe', child, 'ollama-tcp-denied');
    if (!probeDiagnostics.exactOllamaTcp.success) {
      const error = probeFailure('Exact Ollama TCP confinement probe failed', probeDiagnostics.exactOllamaTcp);
      error.probeDiagnostics = probeDiagnostics;
      throw error;
    }
    process.stdout.write(JSON.stringify({ ...describe(manifest, { activeChat }), status: 'passed', policyApplication: 'seatbelt-probes-passed', confinement: 'exact-Ollama-TCP-denied', managedLaunchAgentEvidence: false, probes: probeDiagnostics }) + '\n');
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    removePreflightRoot(root);
  }
}
if (require.main === module) {
  const options = parseArguments(process.argv.slice(2));
  if (options.describeOnly) {
    const manifest = readManifest(MANIFEST_PATH);
    verifyHarness(manifest);
    process.stdout.write(JSON.stringify(describe(manifest, options)) + '\n');
  } else run(options).catch(error => {
    process.stderr.write(JSON.stringify(failureReport(error)) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, describe, verifyHarness, OLLAMA_TCP_PROBE, notAttemptedProbe, mergeDiagnostics, probeFailure, failureReport, preflightTask, removePreflightRoot, run };