'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyProviderRuntime, verifyWorkerPackage, verifyBuiltinThemeAssets, verifyWorkerRuntimeClosure, verifyRuntimeLibrary, verifyOpenSslConfig, sanitizedRuntimeEnv, FORBIDDEN_RUNTIME_SELECTION_ENV, TRUSTED_DEV_MODE_ENV, isTrustedDeveloperModeEnabled, isApprovedTrustedDeveloperWorkspace, sha256Tree, compareProviderRuntimeNames, inspectProbe, createPreflightCanaries, verifyPreflightCanaries, createWritableSessionCanary, assertCanaryCoverage, makeProfile, makeWorkerProfile, makeRuntimeDeny, runtimeDenyMatches, readManifest, PREFLIGHT, LEVEL1_PREFLIGHT, ACTIVE_CHAT_PREFLIGHT } = require('../src/worker-sandbox');
const { LOCAL_OLLAMA, prepareWorkerProfile } = require('../src/config');
const { failureReport, preflightTask, removePreflightRoot } = require('../scripts/worker-preflight.cjs');
const { ACTIVE_CHAT_PROFILE_ID, TASK_A_REQUEST } = require('../src/active-chat-mission');
const { createMissionFields } = require('../src/level1-profile');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const OPERATOR_MANIFEST = path.resolve(__dirname, '../config/safe-autonomy-manifest.json');
const hostQualification = { skip: !fs.existsSync(OPERATOR_MANIFEST) ? 'Operator-owned runtime pins are absent; run private host qualification separately' : false };
const SYSTEM_PROFILE = '/System/Library/Sandbox/Profiles/system.sb';
const DYLD_PROFILE = '/System/Library/Sandbox/Profiles/dyld-support.sb';


test('trusted developer mode is explicit, scoped to a selected ~/code descendant, and keeps external network denied', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-trusted-developer-root-')));
  const workspace = path.join(root, 'project'); const sessionDir = path.join(root, 'session'); const protectedDir = path.join(root, 'protected');
  fs.mkdirSync(workspace); fs.mkdirSync(sessionDir); fs.mkdirSync(protectedDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(isTrustedDeveloperModeEnabled('1'), true);
  assert.equal(isTrustedDeveloperModeEnabled('true'), false);
  assert.equal(isTrustedDeveloperModeEnabled(undefined), false);
  const previousTrustedMode = process.env[TRUSTED_DEV_MODE_ENV];
  try {
    process.env[TRUSTED_DEV_MODE_ENV] = '1';
    assert.equal(isTrustedDeveloperModeEnabled(undefined), false, 'missing input cannot inherit host authority');
    assert.equal(isTrustedDeveloperModeEnabled(), false);
  } finally {
    if (previousTrustedMode === undefined) delete process.env[TRUSTED_DEV_MODE_ENV];
    else process.env[TRUSTED_DEV_MODE_ENV] = previousTrustedMode;
  }
  assert.equal(TRUSTED_DEV_MODE_ENV, 'PI_TRUSTED_DEV_MODE');
  assert.equal(isApprovedTrustedDeveloperWorkspace(workspace, root), true);
  assert.equal(isApprovedTrustedDeveloperWorkspace(root, root), false);
  assert.equal(isApprovedTrustedDeveloperWorkspace(sessionDir, path.join(root, 'other-root')), false);

  const common = {
    task: { mission: {} }, workspace, sessionDir, readRoots: [workspace, root], writeRoots: [workspace, sessionDir],
    exactReadFiles: [], protectedRead: [protectedDir], protectedWrite: [protectedDir], protectedReadPatterns: [], protectedWritePatterns: [],
    socketPath: path.join(sessionDir, 'policy.sock'), executable: process.execPath, nodePath: process.execPath, envPath: '/usr/bin/env'
  };
  const hardened = makeWorkerProfile(common);
  const trusted = makeWorkerProfile({ ...common, trustedDeveloperMode: true });
  assert.match(hardened, /\(deny network\* \(require-not \(remote unix-socket/);
  assert.doesNotMatch(hardened, /localhost:\*/);
  assert.match(trusted, /\(deny network\* \(require-all .*remote unix-socket.*remote ip \"localhost:\*\".*local ip \"localhost:\*\"/);
  assert.match(trusted, /\(allow network-bind \(local ip "localhost:\*"\)\)/);
  assert.match(trusted, /\(allow network-inbound \(local ip "localhost:\*"\)\)/);
  assert.match(trusted, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.doesNotMatch(trusted, /remote ip "\*:\*"/);
  assert.match(trusted, new RegExp(`\\(deny file-read\\* \\(subpath "${protectedDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`));
  assert.match(trusted, new RegExp(`\\(deny file-write\\* \\(subpath "${protectedDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`));

  const level1Mission = createMissionFields('task_a');
  const level1 = makeWorkerProfile({ ...common, task: { workspace, mission: level1Mission }, trustedDeveloperMode: true });
  assert.doesNotMatch(level1, /localhost:\*/, 'restricted Level 1 profile cannot inherit trusted-developer loopback access');
});

test('pinned startup closure includes bridge extension imports, the full Pi bundle, provider closure, and bundled startup assets', hostQualification, () => {
  const repository = path.resolve(__dirname, '..');
  const manifest = readManifest(path.join(repository, 'config/safe-autonomy-manifest.json'));
  const extension = fs.readFileSync(path.join(repository, 'src/safety-extension.mjs'), 'utf8');
  const eventExtension = fs.readFileSync(path.join(repository, 'src/chatgpt-event-extension.mjs'), 'utf8');
  assert.match(extension, /from '\.\/chatgpt-event-extension\.mjs'/);
  assert.match(extension, /await import\(moduleUrl\)/);
  assert.match(eventExtension, /from '\.\/chatgpt-events\.js'/);
  const pinnedPi = verifyWorkerPackage(manifest.worker);
  assert.equal(JSON.parse(fs.readFileSync(pinnedPi.packageMetadata, 'utf8')).version, '1.0.2');
  assert.ok(manifest.worker.files.length > 50, 'the full Pi bundle inventory is pinned');
  assert.equal(verifyWorkerRuntimeClosure(manifest.worker).roots.length, 9);
  assert.equal(verifyProviderRuntime(manifest.providerRuntime).roots.length, 3);
  assert.deepEqual(verifyBuiltinThemeAssets(manifest.worker, pinnedPi).paths.map(file => path.basename(file)).sort(), ['dark.json', 'light.json']);
});

test('preflight harness describes the required pinned-node, WorkerSandbox.prepare-only operation without executing it', hostQualification, () => {
  const manifest = readManifest(path.resolve(__dirname, '../config/safe-autonomy-manifest.json'));
  const node = manifest.executables.find(entry => entry.id === 'node');
  const result = spawnSync(node.path, ['scripts/worker-preflight.cjs', '--describe'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.equal(description.kind, 'WORKER_SANDBOX_PREFLIGHT_ONLY');
  assert.equal(description.executionContext, 'operator-terminal');
  assert.equal(description.mandatoryPreparation, 'WorkerSandbox.prepare()');
  assert.deepEqual(description.probes, ['canonical-seatbelt-probes', 'exact-unix-policy-socket-connectivity', 'direct-tcp-127.0.0.1:11434-denied']);
  assert.match(description.prohibitedEffects.join(' '), /Pi inference/);
});

test('active-chat preflight description and task select the restricted profile with a sealed undisclosed fixture', hostQualification, t => {
  const repository = path.resolve(__dirname, '..');
  const manifest = readManifest(path.join(repository, 'config/safe-autonomy-manifest.json'));
  const node = manifest.executables.find(entry => entry.id === 'node');
  const result = spawnSync(node.path, ['scripts/worker-preflight.cjs', '--describe', '--active-chat'], { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.equal(description.profile, ACTIVE_CHAT_PROFILE_ID);
  assert.deepEqual(description.command.slice(-1), ['--active-chat']);
  assert.ok(description.probes.includes('active-chat-seatbelt-probes'));
  assert.match(description.fixture, /sealed disposable fixture/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-active-preflight-'));
  t.after(() => removePreflightRoot(root));
  const workspace = path.join(root, 'workspace'); const sessionDir = path.join(root, 'session'); const workerProfile = path.join(sessionDir, 'profile');
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(workerProfile, { recursive: true, mode: 0o700 });
  const task = preflightTask({ activeChat: true, workspace, sessionDir, workerProfile });
  const taskA = fs.readFileSync(path.join(workspace, 'evidence/task-a.txt'), 'utf8');
  assert.equal(task.mission.capabilityProfile, ACTIVE_CHAT_PROFILE_ID);
  assert.equal(task.localOllamaTransport, true);
  assert.equal(task.activeChat.phase, 'task_a_running');
  assert.equal(fs.statSync(path.join(workspace, 'evidence')).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(workspace, 'evidence/task-a.txt')).mode & 0o777, 0o400);
  assert.equal(TASK_A_REQUEST.includes(taskA.trim()), false);
  assert.match(ACTIVE_CHAT_PREFLIGHT, /direct Active Chat fixture read/);
});

test('provider runtime tree pins reject modified or unpinned imported code before worker launch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-runtime-'));
  const entrypoint = path.join(root, 'api.mjs'); fs.writeFileSync(entrypoint, 'export const streamSimple = () => {}\n');
  const manifest = { entrypoint, entrypointSha256: digest(entrypoint), roots: [{ path: root, sha256: sha256Tree(root).sha256 }] };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(verifyProviderRuntime(manifest).entrypoint, fs.realpathSync(entrypoint));
  fs.writeFileSync(entrypoint, 'export const streamSimple = () => { throw new Error("modified") }\n');
  assert.throws(() => verifyProviderRuntime(manifest), /provider runtime hash mismatch/);
});

test('worker runtime dependency closure pins the Pi agent graph, rejects tampering, and remains read-only', t => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-worker-runtime-closure-')));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const core = path.join(fixture, 'pi-agent-core');
  const chord = path.join(fixture, 'chord');
  for (const directory of [path.join(core, 'dist'), path.join(chord, 'dist/context')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: '@fixture/pi-agent-core', version: '1.0.0', type: 'module', exports: { '.': { import: './dist/index.js' } } }));
  fs.writeFileSync(path.join(chord, 'package.json'), JSON.stringify({ name: '@fixture/chord', version: '1.0.0', type: 'module', exports: { './context': { import: './dist/context/index.js' } } }));
  const coreEntry = path.join(core, 'dist/index.js');
  const chordContext = path.join(chord, 'dist/context/index.js');
  fs.writeFileSync(coreEntry, 'const { context } = require("@fixture/chord/context"); export { context };\n');
  fs.writeFileSync(chordContext, 'export const context = "reviewed";\n');
  const makeClosure = () => ({
    roots: [
      { package: '@fixture/pi-agent-core', version: '1.0.0', path: core, sha256: sha256Tree(core, 'worker runtime').sha256 },
      { package: '@fixture/chord', version: '1.0.0', path: chord, sha256: sha256Tree(chord, 'worker runtime').sha256 }
    ],
    entrypoints: [{ package: '@fixture/pi-agent-core', path: 'dist/index.js' }]
  });

  const closure = makeClosure();
  const verified = verifyWorkerRuntimeClosure({ runtimeClosure: closure });
  assert.deepEqual(verified.roots, [fs.realpathSync(core), fs.realpathSync(chord)]);
  assert.ok(verified.files.includes(fs.realpathSync(chordContext)), 'the Chord context export resolves within the declared closure');
  const profile = makeProfile({ readRoots: verified.roots, writeRoots: [], protectedRead: [], protectedWrite: [] });
  for (const root of verified.roots) {
    assert.ok(profile.includes(`(allow file-read* file-test-existence (subpath "${root}"))`));
    assert.doesNotMatch(profile, new RegExp(`\\(allow[^\\n]*file-write[^\\n]*${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'runtime package roots stay read-only');
  }

  fs.writeFileSync(coreEntry, 'export const changed = true;\n');
  assert.throws(() => verifyWorkerRuntimeClosure({ runtimeClosure: closure }), /Pinned worker runtime hash mismatch/);
  fs.writeFileSync(coreEntry, 'const { context } = require("@fixture/chord/context"); export { context };\n');
  fs.writeFileSync(chordContext, 'export const context = "tampered";\n');
  assert.throws(() => verifyWorkerRuntimeClosure({ runtimeClosure: closure }), /Pinned worker runtime hash mismatch/);
  fs.writeFileSync(chordContext, 'export const context = "reviewed";\n');

  fs.writeFileSync(coreEntry, 'import "untrusted-sibling"; export const reviewed = true;\n');
  const untrustedClosure = makeClosure();
  assert.throws(() => verifyWorkerRuntimeClosure({ runtimeClosure: untrustedClosure }), /Undeclared worker runtime package: untrusted-sibling/);
});

test('current worker runtime closure pins the proven Pi agent core and Chord dependencies', hostQualification, () => {
  const worker = readManifest(path.resolve(__dirname, '../config/safe-autonomy-manifest.json')).worker;
  const verified = verifyWorkerRuntimeClosure(worker);
  const roots = new Map(worker.runtimeClosure.roots.map(item => [item.package, item]));
  assert.ok(roots.has('@earendil-works/pi-agent-core'));
  assert.ok(roots.has('@earendil-works/chord'));
  assert.ok(verified.files.some(file => file.endsWith('/@earendil-works/chord/dist/context/index.js')));
});

test('Pi startup grants only the two pinned built-in themes required before RPC', hostQualification, () => {
  const manifest = readManifest(path.resolve(__dirname, '../config/safe-autonomy-manifest.json'));
  const pinnedPi = verifyWorkerPackage(manifest.worker);
  const themes = verifyBuiltinThemeAssets(manifest.worker, pinnedPi).paths;
  const packageJson = JSON.parse(fs.readFileSync(pinnedPi.packageMetadata, 'utf8'));
  const themeRoot = path.join(path.dirname(path.dirname(pinnedPi.bundleRoot)), 'dist', 'modes', 'interactive', 'theme');
  assert.equal(packageJson.version, '1.0.2');
  assert.deepEqual(themes, ['dark.json', 'light.json'].map(name => path.join(themeRoot, name)).sort());
  const profile = makeProfile({ readRoots: [], exactReadFiles: themes, writeRoots: [], protectedRead: [], protectedWrite: [] });
  for (const theme of themes) assert.ok(profile.includes(`(allow file-read* file-test-existence (literal "${theme}"))`));
  assert.doesNotMatch(profile, /\(allow [^\n]*file-write/);
  assert.equal(profile.includes(`(subpath "${themeRoot}")`), false);
  const themeLoader = fs.readFileSync(path.join(pinnedPi.bundleRoot, 'chunks', 'chunk-6FX7UEPL.js'), 'utf8');
  assert.match(themeLoader, /function getBuiltinThemes\(\).*?darkPath=.*?"dark\.json".*?lightPath=.*?"light\.json"/s);
  assert.match(themeLoader, /function initTheme\(.*?loadTheme\(/s);
});

test('Pi built-in theme verification rejects missing, modified, aliased, and substituted assets before launch', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-builtin-themes-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleRoot = path.join(root, 'dist', 'bundle');
  const themeRoot = path.join(root, 'dist', 'modes', 'interactive', 'theme');
  fs.mkdirSync(bundleRoot, { recursive: true }); fs.mkdirSync(themeRoot, { recursive: true });
  const dark = path.join(themeRoot, 'dark.json'), light = path.join(themeRoot, 'light.json');
  fs.writeFileSync(dark, '{"name":"dark"}\n'); fs.writeFileSync(light, '{"name":"light"}\n');
  const worker = { builtinThemeAssets: [{ path: dark, sha256: digest(dark) }, { path: light, sha256: digest(light) }] };
  assert.deepEqual(verifyBuiltinThemeAssets(worker, { bundleRoot }).paths, [dark, light]);
  fs.appendFileSync(dark, 'modified');
  assert.throws(() => verifyBuiltinThemeAssets(worker, { bundleRoot }), /verification failed/);
  fs.writeFileSync(dark, '{"name":"dark"}\n');
  fs.unlinkSync(light);
  assert.throws(() => verifyBuiltinThemeAssets(worker(), { bundleRoot }));
  fs.writeFileSync(light, '{"name":"light"}\n');
  const custom = path.join(root, 'custom.json'); fs.writeFileSync(custom, '{}');
  assert.throws(() => verifyBuiltinThemeAssets({ builtinThemeAssets: [{ path: custom, sha256: digest(custom) }, { path: light, sha256: digest(light) }] }, { bundleRoot }), /not an approved bundled theme/);
  assert.throws(() => verifyBuiltinThemeAssets({ builtinThemeAssets: [{ path: dark, sha256: digest(dark), aliases: [light] }, { path: light, sha256: digest(light) }] }, { bundleRoot }), /cannot use aliases/);
});

test('provider runtime tree pins use a locale-independent path order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-order-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'lowercase');
  fs.writeFileSync(path.join(root, 'Z.js'), 'uppercase');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = crypto.createHash('sha256')
    .update(`F\0Z.js\0${digest(path.join(root, 'Z.js'))}\0`)
    .update(`F\0a.js\0${digest(path.join(root, 'a.js'))}\0`)
    .digest('hex');
  assert.equal(compareProviderRuntimeNames('Z.js', 'a.js'), -1);
  assert.equal(sha256Tree(root).sha256, expected);
});

test('runtime dylib dependencies require a pinned canonical target and generate only exact alias and target reads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-dylib-'));
  const libraryDir = path.join(root, 'libraries'); const aliasDir = path.join(root, 'loader-path');
  const canonicalFile = path.join(libraryDir, 'libdependent.1.2.dylib');
  const loaderAlias = path.join(aliasDir, 'libdependent.1.dylib');
  const protectedFile = path.join(root, 'protected', 'secret');
  fs.mkdirSync(libraryDir, { recursive: true }); fs.mkdirSync(aliasDir, { recursive: true }); fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
  fs.writeFileSync(canonicalFile, 'reviewed dependent library'); fs.writeFileSync(protectedFile, 'must remain denied');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const canonical = fs.realpathSync(canonicalFile);
  const record = { path: canonical, sha256: digest(canonical), aliases: [loaderAlias] };
  let aliasTarget = canonical;
  const originalRealpath = fs.realpathSync;
  const verifyWithAlias = operation => {
    fs.realpathSync = function(file, ...args) {
      if (path.resolve(file) === loaderAlias) return aliasTarget;
      return originalRealpath.call(this, file, ...args);
    };
    try { return operation(); }
    finally { fs.realpathSync = originalRealpath; }
  };
  const verified = verifyWithAlias(() => verifyRuntimeLibrary(record));
  assert.deepEqual(verified.paths, [canonical, loaderAlias]);
  const profile = makeProfile({ readRoots: [], exactReadFiles: verified.paths, writeRoots: [], protectedRead: [protectedFile], protectedWrite: [protectedFile] });
  assert.ok(profile.includes(`(allow file-read* file-test-existence (literal "${canonical}"))`));
  assert.ok(profile.includes(`(allow file-read* file-test-existence (literal "${loaderAlias}"))`));
  assert.doesNotMatch(profile, new RegExp(`\\(allow file-read\\* file-test-existence \\(subpath "${canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`));
  const protectedCanonical = fs.realpathSync(protectedFile);
  assert.ok(profile.includes(`(deny file-read* (subpath "${protectedCanonical}"))`));
  assert.ok(profile.includes(`(deny file-write* (subpath "${protectedCanonical}"))`));
  assert.match(profile, /\(deny network\*\)/);
  assert.match(PREFLIGHT, /host:'127\.0\.0\.1',port:9/);

  fs.writeFileSync(canonicalFile, 'changed dependent library');
  assert.throws(() => verifyWithAlias(() => verifyRuntimeLibrary(record)), /runtime library verification failed/);
  fs.writeFileSync(canonicalFile, 'reviewed dependent library');
  const replacement = path.join(libraryDir, 'libreplacement.1.2.dylib'); fs.writeFileSync(replacement, 'replacement target');
  aliasTarget = replacement;
  assert.throws(() => verifyWithAlias(() => verifyRuntimeLibrary(record)), /alias target mismatch/);
});

test('OpenSSL runtime configuration pins reviewed includes and rejects content, alias, and selector changes', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-openssl-config-')));
  const configDir = path.join(root, 'config'); const aliasDir = path.join(root, 'aliases'); const protectedFile = path.join(root, 'protected', 'secret');
  const includeFile = path.join(configDir, 'included.cnf'); const configFile = path.join(configDir, 'openssl.cnf'); const alias = path.join(aliasDir, 'openssl.cnf');
  fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(aliasDir, { recursive: true }); fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
  fs.writeFileSync(includeFile, '# reviewed include\n');
  fs.writeFileSync(configFile, `openssl_conf = openssl_init\n.include ${includeFile}\n`);
  fs.writeFileSync(protectedFile, 'must remain denied');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const includeRecord = { kind: 'openssl', path: includeFile, sha256: digest(includeFile), aliases: [], includes: [] };
  const record = { kind: 'openssl', path: configFile, sha256: digest(configFile), aliases: [alias], includes: [includeRecord] };
  let aliasTarget = configFile;
  const originalRealpath = fs.realpathSync;
  const verifyWithAlias = operation => {
    fs.realpathSync = function(file, ...args) {
      if (path.resolve(file) === alias) return aliasTarget;
      return originalRealpath.call(this, file, ...args);
    };
    try { return operation(); }
    finally { fs.realpathSync = originalRealpath; }
  };
  const verified = verifyWithAlias(() => verifyOpenSslConfig(record));
  assert.deepEqual(verified.paths, [configFile, alias, includeFile]);
  const profile = makeProfile({ readRoots: [], exactReadFiles: verified.paths, writeRoots: [], protectedRead: [protectedFile], protectedWrite: [protectedFile] });
  for (const file of verified.paths) assert.ok(profile.includes(`(allow file-read* file-test-existence (literal "${file}"))`));
  assert.doesNotMatch(profile, new RegExp(`\\(allow file-read\\* file-test-existence \\(subpath "${configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`));
  assert.doesNotMatch(profile, new RegExp(`\\(allow [^\\n]*file-write[^\\n]*${configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'configuration is read-only under the deny-by-default policy');
  const protectedCanonical = fs.realpathSync(protectedFile);
  assert.ok(profile.includes(`(deny file-read* (subpath "${protectedCanonical}"))`));
  assert.ok(profile.includes(`(deny file-write* (subpath "${protectedCanonical}"))`));
  assert.match(profile, /\(deny network\*\)/);
  assert.match(PREFLIGHT, /host:'127\.0\.0\.1',port:9/);

  fs.writeFileSync(includeFile, '# changed include\n');
  assert.throws(() => verifyWithAlias(() => verifyOpenSslConfig(record)), /OpenSSL configuration verification failed/);
  fs.writeFileSync(includeFile, '# reviewed include\n');
  fs.writeFileSync(configFile, `openssl_conf = openssl_init\n.include ${path.join(configDir, 'unreviewed.cnf')}\n`);
  record.sha256 = digest(configFile);
  assert.throws(() => verifyWithAlias(() => verifyOpenSslConfig(record)), /include is not pinned|unreviewed include directives/);
  fs.writeFileSync(configFile, `openssl_conf = openssl_init\n.include ${includeFile}\n`); record.sha256 = digest(configFile);
  const replacement = path.join(configDir, 'replacement.cnf'); fs.writeFileSync(replacement, '# replacement\n');
  aliasTarget = replacement;
  assert.throws(() => verifyWithAlias(() => verifyOpenSslConfig(record)), /alias target mismatch/);

  const cleanEnv = sanitizedRuntimeEnv({ PATH: '/usr/bin:/bin', HOME: root, TMPDIR: path.join(root, 'tmp'), LANG: 'C' });
  for (const name of FORBIDDEN_RUNTIME_SELECTION_ENV) assert.equal(Object.hasOwn(cleanEnv, name), false);
  assert.throws(() => sanitizedRuntimeEnv({ ...cleanEnv, OPENSSL_CONF: configFile }), /Unapproved runtime configuration selector/);
  assert.throws(() => sanitizedRuntimeEnv({ ...cleanEnv, NODE_OPTIONS: `--openssl-config=${configFile}` }), /Unapproved runtime configuration selector/);
});

test('local Ollama worker profile retains only the exact configured provider and model without auth material', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-profile-'));
  const source = path.join(root, 'source'); const destination = path.join(root, 'worker');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ defaultProvider: 'ollama', defaultModel: 'qwen3-coder:30b', apiKey: 'must-not-be-copied' }));
  fs.writeFileSync(path.join(source, 'models.json'), JSON.stringify({ providers: { cloud: { baseUrl: 'https://example.invalid', models: [{ id: 'other' }] } } }));
  fs.writeFileSync(path.join(source, 'auth.json'), 'private fixture that must not be copied');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  prepareWorkerProfile(source, destination, { localOllamaOnly: true });
  const settings = JSON.parse(fs.readFileSync(path.join(destination, 'settings.json'), 'utf8'));
  const models = JSON.parse(fs.readFileSync(path.join(destination, 'models.json'), 'utf8'));
  assert.deepEqual(settings, { defaultProvider: LOCAL_OLLAMA.provider, defaultModel: LOCAL_OLLAMA.model, defaultThinkingLevel: 'off', enableTelemetry: false, packages: [], retry: { enabled: false } });
  assert.deepEqual(Object.keys(models.providers), ['ollama']);
  assert.equal(models.providers.ollama.baseUrl, LOCAL_OLLAMA.baseUrl);
  assert.equal(models.providers.ollama.models[0].id, LOCAL_OLLAMA.model);
  assert.equal(fs.existsSync(path.join(destination, 'auth.json')), false);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ defaultProvider: 'cloud', defaultModel: 'other' }));
  assert.throws(() => prepareWorkerProfile(source, path.join(root, 'wrong'), { localOllamaOnly: true }), /requires the configured ollama/);
});

test('probe diagnostics preserve useful output and fail closed for empty, signalled, spawn, timeout, and marker failures', () => {
  const marker = 'expected-marker';
  const empty = inspectProbe('canonical-seatbelt-probes', { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, marker);
  assert.equal(empty.success, false); assert.equal(empty.stdout, ''); assert.equal(empty.stderr, ''); assert.match(empty.reason, /stderr=<empty>.*stdout=<empty>/);

  const stdoutOnly = inspectProbe('canonical-seatbelt-probes', { status: 1, stdout: Buffer.from('useful stdout'), stderr: Buffer.alloc(0) }, marker);
  assert.equal(stdoutOnly.success, false); assert.match(stdoutOnly.reason, /useful stdout/);

  const whitespaceStderr = inspectProbe('canonical-seatbelt-probes', { status: 1, stdout: '', stderr: Buffer.from(' \n\t') }, marker);
  assert.equal(whitespaceStderr.stderr, ' \n\t'); assert.match(whitespaceStderr.reason, /stderr=<whitespace>/);

  const signalled = inspectProbe('level1-seatbelt-probes', { status: null, signal: 'SIGTERM', stdout: '', stderr: '' }, marker);
  assert.equal(signalled.success, false); assert.equal(signalled.signal, 'SIGTERM'); assert.match(signalled.reason, /signal=SIGTERM/);

  const spawnFailure = inspectProbe('exact-ollama-tcp-probe', { status: null, error: { code: 'EACCES' }, stdout: '', stderr: '' }, marker);
  assert.equal(spawnFailure.success, false); assert.equal(spawnFailure.errorCode, 'EACCES'); assert.match(spawnFailure.reason, /errorCode=EACCES/);

  const timeout = inspectProbe('exact-ollama-tcp-probe', { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' }, marker);
  assert.equal(timeout.success, false); assert.equal(timeout.timedOut, true); assert.match(timeout.reason, /errorCode=ETIMEDOUT/);

  const missingMarker = inspectProbe('exact-ollama-tcp-probe', { status: 0, stdout: 'node-reached-javascript\nwrapper exited normally', stderr: '' }, marker);
  assert.equal(missingMarker.success, false); assert.equal(missingMarker.nodeReachedJavaScript, true); assert.equal(missingMarker.childStatus, 0); assert.equal(missingMarker.markerPresent, false); assert.match(missingMarker.reason, /expectedMarkerPresent=false/);

  const redactedAndBounded = inspectProbe('canonical-seatbelt-probes', { status: 1, stdout: `api_key=private-value\n${'x'.repeat(5000)}`, stderr: '' }, marker);
  assert.doesNotMatch(redactedAndBounded.stdout, /private-value/);
  assert.match(redactedAndBounded.stdout, /api_key=<redacted>/);
  assert.match(redactedAndBounded.stdout, /\[truncated\]$/);

  const report = failureReport(Object.assign(new Error('fixture failure'), { probeDiagnostics: { canonical: timeout } }));
  assert.equal(report.status, 'failed');
  assert.equal(report.error, 'fixture failure');
  for (const key of ['stage', 'childStatus', 'signal', 'errorCode', 'nodeReachedJavaScript', 'stdout', 'stderr', 'markerPresent']) assert.ok(Object.hasOwn(report.probes.canonical, key));
  assert.deepEqual(report.probes.canonical, timeout);
});

test('preflight active denial probes contain only parent-created disposable canaries covered by explicit deny rules', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-canary-parent-'));
  const canaries = createPreflightCanaries(parent);
  const session = path.join(parent, 'session'); fs.mkdirSync(session);
  const writableCanary = createWritableSessionCanary(session);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const denial = verifyPreflightCanaries(canaries);
  for (const target of [...denial.read, ...denial.write, ...denial.create]) assert.ok(path.resolve(target).startsWith(`${canaries.root}${path.sep}`));
  assert.equal(JSON.stringify(denial).includes(os.homedir()), false);
  assert.equal(JSON.stringify(denial).includes(path.resolve(__dirname, '..')), false);
  assert.ok(writableCanary.startsWith(`${fs.realpathSync(session)}${path.sep}`));
  assert.equal(fs.lstatSync(writableCanary).isFile(), true);
  const profile = makeProfile({ readRoots: [parent], writeRoots: [parent], protectedRead: [canaries.root], protectedWrite: [canaries.root] });
  assert.doesNotThrow(() => assertCanaryCoverage(profile, denial));
  assert.match(PREFLIGHT, /denialCanaries/);
  assert.match(LEVEL1_PREFLIGHT, /denialCanaries/);
  assert.doesNotMatch(LEVEL1_PREFLIGHT, /workspaceProbePath/);
});

test('runtime containment deny requires every filter and preserves only authorized runtime exceptions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-containment-'));
  const runtimeRoot = path.join(root, 'runtime');
  const sessionDir = path.join(runtimeRoot, 'sessions', 'current');
  const workspace = path.join(runtimeRoot, 'workspaces', 'current');
  const otherSession = path.join(runtimeRoot, 'sessions', 'other');
  const privateRuntime = path.join(runtimeRoot, 'private', 'state.sqlite');
  const protectedInSession = path.join(sessionDir, 'credentials');
  for (const dir of [sessionDir, workspace, otherSession, path.dirname(privateRuntime), protectedInSession]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privateRuntime, 'private runtime data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const scope = {
    runtimeRoot: fs.realpathSync(runtimeRoot),
    sessionDir: fs.realpathSync(sessionDir),
    workspace: fs.realpathSync(workspace)
  };
  const deny = makeRuntimeDeny(scope);
  assert.equal(deny, `(deny file-read* file-write* (require-all (subpath "${scope.runtimeRoot}") (require-not (subpath "${scope.sessionDir}")) (require-not (subpath "${scope.workspace}"))))`);

  const pinnedRuntimeLibrary = '/opt/airodrom/fixture-runtime/libnode.dylib';
  for (const requiredRuntimePath of ['/', '/System/Library/Frameworks', '/usr/lib/dyld', pinnedRuntimeLibrary]) {
    assert.equal(runtimeDenyMatches(scope, requiredRuntimePath), false, `${requiredRuntimePath} must not match the bridge runtime deny`);
  }
  assert.equal(runtimeDenyMatches(scope, path.join(scope.sessionDir, 'scratch.txt')), false);
  assert.equal(runtimeDenyMatches(scope, path.join(scope.workspace, 'fixture.txt')), false);
  assert.equal(runtimeDenyMatches(scope, path.join(scope.runtimeRoot, 'sessions', 'other', 'secret.txt')), true, 'another task session remains private');
  assert.equal(runtimeDenyMatches(scope, path.join(scope.runtimeRoot, 'private', 'state.sqlite')), true, 'bridge private runtime data remains private');

  const canonicalProfile = makeProfile({
    readRoots: [scope.sessionDir, scope.workspace],
    writeRoots: [scope.sessionDir, scope.workspace],
    protectedRead: [protectedInSession],
    protectedWrite: [protectedInSession],
    socketPath: path.join(root, 'policy.sock'),
    denyFork: true,
    execPaths: [process.execPath]
  }) + `${deny}\n`;
  const workerProfile = makeWorkerProfile({
    task: {}, workspace: scope.workspace, sessionDir: scope.sessionDir,
    readRoots: [scope.sessionDir, scope.workspace], writeRoots: [scope.sessionDir, scope.workspace],
    protectedRead: [protectedInSession], protectedWrite: [protectedInSession],
    protectedReadPatterns: [], protectedWritePatterns: [], socketPath: path.join(root, 'policy.sock'),
    executable: process.execPath, nodePath: process.execPath, envPath: '/usr/bin/env'
  }) + `${deny}\n`;
  const protectedPath = fs.realpathSync(protectedInSession);
  for (const profile of [canonicalProfile, workerProfile]) {
    assert.ok(profile.includes(`(deny file-read* (subpath "${protectedPath}"))`), 'protected read deny remains explicit inside an exception');
    assert.ok(profile.includes(`(deny file-write* (subpath "${protectedPath}"))`), 'protected write deny remains explicit inside an exception');
    assert.match(profile, /\(deny network\* \(require-not \(remote unix-socket/);
    assert.match(profile, /\(allow network-outbound \(remote unix-socket/);
    assert.ok(profile.endsWith(`${deny}\n`), 'the complete generated profile retains the grouped runtime deny');
  }
  assert.doesNotMatch(canonicalProfile, /\(allow process-fork\)/);
  assert.match(canonicalProfile, /\(allow process-exec \(literal "/);

  const outsideWorkspace = path.join(root, 'workspace-outside-runtime'); fs.mkdirSync(outsideWorkspace);
  const outsideDeny = makeRuntimeDeny({ ...scope, workspace: fs.realpathSync(outsideWorkspace) });
  assert.equal(outsideDeny, `(deny file-read* file-write* (require-all (subpath "${scope.runtimeRoot}") (require-not (subpath "${scope.sessionDir}"))))`);
});

test('current imported dyld policy permits only the root literal while generated profiles retain descendant denies', t => {
  for (const file of [SYSTEM_PROFILE, DYLD_PROFILE]) {
    if (!fs.existsSync(file)) t.skip(`macOS sandbox profile unavailable: ${file}`);
  }
  const system = fs.readFileSync(SYSTEM_PROFILE, 'utf8');
  const dyld = fs.readFileSync(DYLD_PROFILE, 'utf8');
  const exactRoot = /\(allow file-read\* file-test-existence\s+\(literal "\/"\)\s*\)/;
  assert.match(system, exactRoot);
  assert.match(dyld, exactRoot);
  assert.doesNotMatch(dyld, /\(subpath "\/"\)/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-root-compat-'));
  const readable = path.join(root, 'readable'); const protectedChild = path.join(root, 'protected');
  fs.mkdirSync(readable); fs.mkdirSync(protectedChild);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonicalProtectedChild = fs.realpathSync(protectedChild);
  const profile = makeProfile({ readRoots: [readable], writeRoots: [], protectedRead: [protectedChild], protectedWrite: [protectedChild], socketPath: path.join(root, 'policy.sock') });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(import "\/System\/Library\/Sandbox\/Profiles\/system\.sb"\)/);
  assert.ok(profile.includes(`(deny file-read* (subpath "${canonicalProtectedChild}"))`));
  assert.ok(profile.includes(`(deny file-write* (subpath "${canonicalProtectedChild}"))`));
  assert.ok(profile.indexOf('(import "/System/Library/Sandbox/Profiles/system.sb")') < profile.indexOf('(deny file-read*'));
  assert.match(profile, /path-literal ".*policy\.sock"/);
  assert.match(PREFLIGHT, /node-reached-javascript/);
  assert.match(LEVEL1_PREFLIGHT, /node-reached-javascript/);
});
