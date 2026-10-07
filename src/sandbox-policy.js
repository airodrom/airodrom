'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { LEVEL1_PROFILE_ID, assertReadOnlyMission } = require('./level1-profile');
const { ACTIVE_CHAT_PROFILE_ID, assertActiveChatMission } = require('./active-chat-mission');

const MANIFEST_PATH = path.resolve(__dirname, '../config/safe-autonomy-manifest.json');
const TRUSTED_WORKSPACE_PATHS = [
  // Directory-level denies prevent renaming a trusted child through its parent.
  'src', 'scripts', 'macos', 'config',
  'src/capability-broker.js',
  'src/active-chat-mission.js',
  'src/mission-permissions.js', 'src/safety-policy.js', 'src/mission-authority.js', 'src/mission-coordinator.js',
  'src/sandbox-policy.js', 'src/sandbox-runner.js', 'src/mission-provider.js', 'src/bridge-controller.js',
  'src/control-server.js', 'src/config.js', 'src/safe-diagnostics.js',
  'src/host-worker-adapter.js', 'src/mission-supervisor.js',
  'src/mcp-tools.js', 'src/chatgpt-events.js',
  'src/web-reader.js', 'src/memory-store.js', 'src/task-session-model.js',
  'scripts/run.cjs', 'scripts/macos', 'macos', 'package.json', 'package-lock.json',
  'config/safe-autonomy-manifest.json', 'wire.log'
];
const SECRET_COMPONENT_PATTERN = String.raw`(^|/)(?:\.git|\.pi|\.codex|\.bridge|\.ssh|\.aws|\.gnupg|\.config|\.npmrc|\.netrc|\.pypirc|\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|auth\.json|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx))(/|$)`;
const PROBE_OUTPUT_LIMIT = 4096;
const FORBIDDEN_RUNTIME_SELECTION_ENV = Object.freeze(['NODE_OPTIONS', 'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_MODULES', 'OPENSSL_ENGINES']);
const TRUSTED_DEV_MODE_ENV = 'AIRODROM_TRUSTED_DEV_MODE';

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sbplPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Invalid sandbox path');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
function real(file) { return fs.realpathSync(file); }

function isTrustedDeveloperModeEnabled(value) { return value === '1'; }

function isApprovedTrustedDeveloperWorkspace(workspace, developerRoot = path.join(os.homedir(), 'code')) {
  if (typeof workspace !== 'string' || typeof developerRoot !== 'string' || !path.isAbsolute(workspace) || !path.isAbsolute(developerRoot)) return false;
  let root; let target;
  try { root = real(developerRoot); target = real(workspace); } catch { return false; }
  return target !== root && target.startsWith(`${root}${path.sep}`);
}

function normalizeProbeText(value, limit = PROBE_OUTPUT_LIMIT) {
  let text = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : value == null ? '' : String(value);
  // Probe output is host-controlled, but never let an incidental credential
  // echo become an audit record or error message.
  text = text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/((?:authorization|token|secret|password|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1<redacted>')
    .replace(/\b[a-f0-9]{32,}\b/gi, '<redacted-hex>');
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

function displayProbeText(value) {
  if (!value) return '<empty>';
  return value.trim() ? value : '<whitespace>';
}

function inspectProbe(stage, child, expectedMarker) {
  const stdout = normalizeProbeText(child?.stdout);
  const stderr = normalizeProbeText(child?.stderr);
  const childStatus = Number.isInteger(child?.status) ? child.status : null;
  const signal = typeof child?.signal === 'string' && child.signal ? child.signal : null;
  const errorCode = typeof child?.error?.code === 'string' && child.error.code ? child.error.code : null;
  const nodeReachedJavaScript = stdout.includes('node-reached-javascript');
  const markerPresent = typeof expectedMarker === 'string' && expectedMarker.length > 0 && stdout.includes(expectedMarker);
  const timedOut = errorCode === 'ETIMEDOUT';
  const success = errorCode === null && signal === null && childStatus === 0 && markerPresent;
  const reason = success ? 'passed' : [
    `stage=${stage}`,
    `childStatus=${childStatus === null ? '<none>' : childStatus}`,
    `signal=${signal || '<none>'}`,
    `errorCode=${errorCode || '<none>'}`,
    `expectedMarkerPresent=${markerPresent}`,
    `stderr=${displayProbeText(stderr)}`,
    `stdout=${displayProbeText(stdout)}`
  ].join('; ');
  return { stage, childStatus, signal, errorCode, timedOut, nodeReachedJavaScript, expectedMarker: expectedMarker || null, markerPresent, stdout, stderr, success, reason };
}

function assertProbeSuccess(diagnostics, prefix, allDiagnostics = {}) {
  if (diagnostics.success) return diagnostics;
  const error = new Error(`${prefix}: ${diagnostics.reason}`);
  error.probeDiagnostics = { ...allDiagnostics, [diagnostics.stage]: diagnostics };
  throw error;
}

function createPreflightCanaries(parent = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(parent, 'airodrom-sandbox-canary-'));
  fs.chmodSync(root, 0o700);
  const readFile = path.join(root, 'read.canary');
  const writeFile = path.join(root, 'write.canary');
  const createDirectory = path.join(root, 'create-target');
  fs.writeFileSync(readFile, 'preflight read canary\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(writeFile, 'preflight write canary\n', { mode: 0o600, flag: 'wx' });
  fs.mkdirSync(createDirectory, { mode: 0o700 });
  const canonicalCreateDirectory = real(createDirectory);
  return { root: real(root), readFile: real(readFile), writeFile: real(writeFile), createDirectory: canonicalCreateDirectory, createFile: path.join(canonicalCreateDirectory, 'new.canary') };
}

function verifyPreflightCanaries(canaries) {
  if (!canaries || typeof canaries.root !== 'string' || !path.isAbsolute(canaries.root)) throw new Error('Preflight denial canaries are missing');
  const root = real(canaries.root);
  const underRoot = file => typeof file === 'string' && path.resolve(file).startsWith(`${root}${path.sep}`);
  if (![canaries.readFile, canaries.writeFile, canaries.createDirectory, canaries.createFile].every(underRoot) ||
      !fs.lstatSync(canaries.readFile).isFile() || !fs.lstatSync(canaries.writeFile).isFile() || !fs.lstatSync(canaries.createDirectory).isDirectory() || fs.existsSync(canaries.createFile)) {
    throw new Error('Preflight denial canaries are invalid or outside their disposable root');
  }
  for (const file of [canaries.readFile, canaries.writeFile, canaries.createDirectory]) if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Preflight denial canary may not be a symbolic link');
  return { root, read: [canaries.readFile], write: [canaries.writeFile], create: [canaries.createFile] };
}

function createWritableSessionCanary(sessionDir) {
  const file = path.join(real(sessionDir), `.sandbox-write-canary-${crypto.randomUUID()}`);
  fs.writeFileSync(file, 'parent-created writable canary\n', { mode: 0o600, flag: 'wx' });
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Writable preflight canary is invalid');
  return real(file);
}

function assertCanaryCoverage(profile, canaries) {
  const root = sbplPath(canaries.root);
  if (!profile.includes(`(deny file-read* (subpath ${root}))`) || !profile.includes(`(deny file-write* (subpath ${root}))`)) {
    throw new Error('Preflight denial canaries are not covered by the generated sandbox policy');
  }
}

function readManifest(file = MANIFEST_PATH) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('Sandbox manifest must be a trusted, non-writable regular file');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!manifest || manifest.version !== 1 || manifest.platform !== 'darwin' || !Array.isArray(manifest.executables) || !Array.isArray(manifest.jobs)) throw new Error('Invalid sandbox manifest');
  return manifest;
}

function verifyPinnedFile(root, item) {
  if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid pinned input record');
  const lexical = path.resolve(root, item.path);
  if (!lexical.startsWith(`${root}${path.sep}`)) throw new Error(`Pinned input escapes repository: ${item.path}`);
  let cursor = lexical;
  while (cursor !== root) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Pinned input traverses a symbolic link: ${item.path}`);
    cursor = path.dirname(cursor);
  }
  const stat = fs.lstatSync(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pinned input must be a regular file: ${item.path}`);
  const digest = sha256(lexical);
  if (digest !== item.sha256) throw new Error(`Pinned input hash mismatch: ${item.path}`);
  return { lexical, digest };
}

function verifyExecutable(item) {
  if (!item || !path.isAbsolute(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid executable pin');
  const canonical = real(item.path);
  const stat = fs.statSync(canonical);
  if (!stat.isFile() || !(stat.mode & 0o111) || sha256(canonical) !== item.sha256) throw new Error(`Pinned executable verification failed: ${item.id || item.path}`);
  return canonical;
}

function verifyPinnedRuntimeFile(item, label) {
  if (!item || !path.isAbsolute(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`Invalid pinned ${label}`);
  const requestedCanonical = path.resolve(item.path);
  const lexical = fs.lstatSync(requestedCanonical);
  if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error(`Pinned ${label} must name its canonical regular file: ${item.path}`);
  const canonical = real(requestedCanonical);
  if (canonical !== requestedCanonical) throw new Error(`Pinned ${label} canonical path mismatch: ${item.path}`);
  const stat = fs.statSync(canonical);
  if (!stat.isFile() || sha256(canonical) !== item.sha256) throw new Error(`Pinned ${label} verification failed: ${item.path}`);
  const aliases = item.aliases == null ? [] : item.aliases;
  if (!Array.isArray(aliases)) throw new Error(`Pinned ${label} aliases must be an array: ${item.path}`);
  const paths = [canonical];
  for (const alias of aliases) {
    if (typeof alias !== 'string' || !path.isAbsolute(alias) || /[\0\r\n]/.test(alias)) throw new Error(`Invalid pinned ${label} alias: ${item.path}`);
    const requestedAlias = path.resolve(alias);
    if (requestedAlias === canonical || paths.includes(requestedAlias)) throw new Error(`Duplicate pinned ${label} alias: ${alias}`);
    let target;
    try { target = real(requestedAlias); } catch (error) { throw new Error(`Pinned ${label} alias is unavailable: ${alias}`); }
    if (target !== canonical) throw new Error(`Pinned ${label} alias target mismatch: ${alias}`);
    paths.push(requestedAlias);
  }
  return { canonical, paths };
}

function verifyRuntimeLibrary(item) { return verifyPinnedRuntimeFile(item, 'runtime library'); }

function parseOpenSslIncludes(file) {
  const includes = [];
  for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const content = line.replace(/#.*/, '').trim();
    const match = /^\.include\s+(.+)$/.exec(content);
    if (!match) continue;
    let include = match[1].trim();
    if ((include.startsWith('"') && include.endsWith('"')) || (include.startsWith("'") && include.endsWith("'"))) include = include.slice(1, -1);
    if (!path.isAbsolute(include) || /[\0\r\n$]/.test(include)) throw new Error(`OpenSSL configuration include must be an explicit absolute file: ${file}:${index + 1}`);
    includes.push(path.resolve(include));
  }
  return includes;
}

function verifyOpenSslConfig(item, seen = new Set()) {
  if (!item || item.kind !== 'openssl') throw new Error('Invalid pinned OpenSSL configuration');
  const verified = verifyPinnedRuntimeFile(item, 'OpenSSL configuration');
  if (seen.has(verified.canonical)) throw new Error(`OpenSSL configuration include cycle: ${verified.canonical}`);
  const nextSeen = new Set(seen); nextSeen.add(verified.canonical);
  if (!Array.isArray(item.includes)) throw new Error(`Pinned OpenSSL configuration includes must be declared: ${item.path}`);
  const children = item.includes.map(include => verifyOpenSslConfig(include, nextSeen));
  const actualIncludes = parseOpenSslIncludes(verified.canonical);
  if (actualIncludes.length !== children.length) throw new Error(`OpenSSL configuration has unreviewed include directives: ${item.path}`);
  const remaining = [...children];
  for (const actual of actualIncludes) {
    const index = remaining.findIndex(child => child.paths.includes(actual));
    if (index < 0) throw new Error(`OpenSSL configuration include is not pinned: ${actual}`);
    remaining.splice(index, 1);
  }
  const files = [{ canonical: verified.canonical, paths: verified.paths }, ...children.flatMap(child => child.files)];
  return { canonical: verified.canonical, paths: files.flatMap(file => file.paths), files };
}

function verifyRuntimeConfigInputs(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Pinned OpenSSL runtime configuration is required');
  const verified = items.map(item => verifyOpenSslConfig(item));
  const claimed = new Map();
  for (const input of verified) {
    for (const file of input.files) for (const inputPath of file.paths) {
      if (claimed.has(inputPath) && claimed.get(inputPath) !== file.canonical) throw new Error(`Pinned runtime configuration path has conflicting targets: ${inputPath}`);
      claimed.set(inputPath, file.canonical);
    }
  }
  return verified;
}

function sanitizedRuntimeEnv(values) {
  const env = { ...values };
  for (const name of FORBIDDEN_RUNTIME_SELECTION_ENV) if (Object.hasOwn(env, name)) throw new Error(`Unapproved runtime configuration selector: ${name}`);
  return env;
}

function verifyRuntimeLibraries(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Pinned Node runtime libraries are required');
  const verified = items.map(verifyRuntimeLibrary);
  const claimed = new Map();
  for (const library of verified) {
    for (const libraryPath of library.paths) {
      if (claimed.has(libraryPath) && claimed.get(libraryPath) !== library.canonical) throw new Error(`Pinned runtime library path has conflicting targets: ${libraryPath}`);
      claimed.set(libraryPath, library.canonical);
    }
  }
  return verified;
}

// Host module-integrity pins must not vary with the process locale or ICU data.
// The manifest format orders path names by their UTF-8 bytes.
function comparePathNames(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256Tree(root, label = 'runtime') {
  const canonicalRoot = real(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error(`Pinned ${label} root is not a directory`);
  const digest = crypto.createHash('sha256');
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => comparePathNames(a.name, b.name))) {
      const child = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unpinned symbolic link in ${label}: ${name}`);
      if (entry.isDirectory()) {
        digest.update(`D\0${name}\0`);
        walk(child, name);
      } else if (entry.isFile()) {
        digest.update(`F\0${name}\0${sha256(child)}\0`);
      } else throw new Error(`Unsupported ${label} entry: ${name}`);
    }
  };
  walk(canonicalRoot);
  return { root: canonicalRoot, sha256: digest.digest('hex') };
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const STATIC_MODULE_IMPORT = /\b(?:import|export)\s+(?:[^'"()]*?\s+from\s*)?['"]([^'"\r\n]+)['"]/g;
const STATIC_MODULE_REQUIRE = /\brequire\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g;
const NODE_BUILTINS = new Set(require('node:module').builtinModules);

function isChildPath(root, value) {
  return value.startsWith(`${root}${path.sep}`);
}

function checkedRuntimeRoot(item) {
  if (!item || typeof item.package !== 'string' || !PACKAGE_NAME.test(item.package) || typeof item.version !== 'string' || !item.version ||
      !path.isAbsolute(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    throw new Error('Invalid pinned worker runtime root');
  }
  const requested = path.resolve(item.path);
  const lexical = fs.lstatSync(requested);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error(`Pinned worker runtime root must name its canonical directory: ${item.package}`);
  const verified = sha256Tree(requested, 'worker runtime');
  if (verified.root !== requested) throw new Error(`Pinned worker runtime root canonical path mismatch: ${item.package}`);
  if (verified.sha256 !== item.sha256) throw new Error(`Pinned worker runtime hash mismatch: ${item.path}`);
  const metadata = path.join(verified.root, 'package.json');
  const metadataStat = fs.lstatSync(metadata);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error(`Pinned worker runtime package metadata is invalid: ${item.package}`);
  let packageJson;
  try { packageJson = JSON.parse(fs.readFileSync(metadata, 'utf8')); } catch { throw new Error(`Pinned worker runtime package metadata is invalid JSON: ${item.package}`); }
  if (packageJson.name !== item.package || packageJson.version !== item.version) throw new Error(`Pinned worker runtime package identity mismatch: ${item.package}`);
  return { ...item, root: verified.root, packageJson };
}

function packageNameFromSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier) throw new Error('Invalid worker runtime module specifier');
  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || /[\\\0?#]/.test(specifier)) {
    throw new Error(`Unsupported worker runtime module specifier: ${specifier}`);
  }
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!PACKAGE_NAME.test(name) || (specifier.startsWith('@') && parts.length < 2)) throw new Error(`Invalid worker runtime module specifier: ${specifier}`);
  return name;
}

function packageSubpath(specifier, packageName) {
  return specifier.slice(packageName.length) || '';
}

function importConditionTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return importConditionTarget(value.import ?? value.default ?? value.node);
}

function packageExportTarget(packageJson, subpath) {
  const key = subpath ? `.${subpath}` : '.';
  if (packageJson.exports) {
    let target = Object.hasOwn(packageJson.exports, key) ? importConditionTarget(packageJson.exports[key]) : null;
    if (target) return target;
    for (const [pattern, value] of Object.entries(packageJson.exports)) {
      if (!pattern.includes('*')) continue;
      const [prefix, suffix] = pattern.split('*');
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        target = importConditionTarget(value);
        if (target) return target.replaceAll('*', key.slice(prefix.length, key.length - suffix.length));
      }
    }
    throw new Error(`Pinned worker runtime package does not export ${key}: ${packageJson.name}`);
  }
  return subpath || packageJson.module || packageJson.main || 'index.js';
}

function checkedRuntimeFile(root, requested, description) {
  if (typeof requested !== 'string' || !requested || /[\\\0\r\n]/.test(requested)) throw new Error(`Invalid ${description}`);
  const lexical = path.resolve(root, requested);
  if (!isChildPath(root, lexical)) throw new Error(`${description} escapes its pinned worker runtime root`);
  const candidates = [lexical, ...['.js', '.mjs', '.cjs', '.json'].map(extension => `${lexical}${extension}`), ...['index.js', 'index.mjs', 'index.cjs', 'index.json'].map(index => path.join(lexical, index))];
  for (const candidate of candidates) {
    if (!isChildPath(root, candidate) || !fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${description} is not a pinned regular file`);
    return candidate;
  }
  throw new Error(`${description} is unavailable`);
}

function resolvePinnedRuntimeImport(roots, importer, specifier) {
  if (specifier.startsWith('node:')) return null;
  const owner = roots.find(root => isChildPath(root.root, importer));
  if (!owner) throw new Error(`Worker runtime importer is outside the pinned closure: ${importer}`);
  if (specifier.startsWith('.')) return checkedRuntimeFile(owner.root, path.relative(owner.root, path.resolve(path.dirname(importer), specifier)), 'worker runtime relative import');
  const packageName = packageNameFromSpecifier(specifier);
  if (!packageName) return null;
  const dependency = roots.find(root => root.package === packageName);
  if (!dependency) throw new Error(`Undeclared worker runtime package: ${packageName}`);
  const target = packageExportTarget(dependency.packageJson, packageSubpath(specifier, packageName));
  if (typeof target !== 'string' || path.isAbsolute(target) || target.split(/[\\/]/).some(part => part === '..' || !part)) throw new Error(`Invalid worker runtime export target: ${specifier}`);
  return checkedRuntimeFile(dependency.root, target, 'worker runtime package export');
}

function staticModuleSpecifiers(file) {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = [];
  for (const expression of [STATIC_MODULE_IMPORT, STATIC_MODULE_REQUIRE]) {
    expression.lastIndex = 0;
    let match;
    while ((match = expression.exec(source))) specifiers.push(match[1]);
  }
  return specifiers;
}

function verifyModuleClosure(modulePins) {
  const closure = modulePins?.runtimeClosure;
  if (!closure || !Array.isArray(closure.roots) || closure.roots.length < 1 || !Array.isArray(closure.entrypoints) || closure.entrypoints.length < 1) {
    throw new Error('Pinned worker runtime dependency closure is required');
  }
  const roots = closure.roots.map(checkedRuntimeRoot);
  const names = new Set();
  const paths = new Set();
  for (const root of roots) {
    if (names.has(root.package) || paths.has(root.root)) throw new Error(`Duplicate pinned worker runtime root: ${root.package}`);
    names.add(root.package); paths.add(root.root);
  }
  const pending = [];
  for (const entrypoint of closure.entrypoints) {
    if (!entrypoint || typeof entrypoint.package !== 'string' || typeof entrypoint.path !== 'string') throw new Error('Invalid worker runtime closure entrypoint');
    const root = roots.find(item => item.package === entrypoint.package);
    if (!root) throw new Error(`Worker runtime closure entrypoint package is undeclared: ${entrypoint.package}`);
    pending.push(checkedRuntimeFile(root.root, entrypoint.path, 'worker runtime closure entrypoint'));
  }
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of staticModuleSpecifiers(file)) {
      const resolved = resolvePinnedRuntimeImport(roots, file, specifier);
      if (resolved) pending.push(resolved);
    }
  }
  return { roots: roots.map(root => root.root), entrypoints: [...new Set(closure.entrypoints.map(entry => `${entry.package}/${entry.path}`))], files: [...visited] };
}

function verifyManifest(root, manifest, jobName) {
  const job = manifest.jobs.find(entry => entry.name === jobName);
  if (!job) throw new Error(`Sandbox job is not approved: ${jobName}`);
  if (!['test', 'build'].includes(job.kind) || !Array.isArray(job.inputs) || !Array.isArray(job.steps) || job.steps.length < 1 || job.steps.length > 64) throw new Error('Invalid sandbox job');
  if (job.requiresProviderRuntime === true || job.requiresWorkerRuntimeClosure === true || manifest.worker?.bundleRoot) throw Error('Removed worker runtime dependency in sandbox policy; register a fresh host-only job');
  if (job.requiresProviderRuntime !== undefined && typeof job.requiresProviderRuntime !== 'boolean') throw new Error('Sandbox provider runtime option is invalid');
  if (job.requiresWorkerRuntimeClosure !== undefined && typeof job.requiresWorkerRuntimeClosure !== 'boolean') throw new Error('Sandbox worker runtime option is invalid');
  if (job.allowPinnedChildProcesses !== undefined && typeof job.allowPinnedChildProcesses !== 'boolean') throw new Error('Sandbox child-process option is invalid');
  if (job.allowPinnedChildProcesses === true && (jobName !== 'safe-autonomy-regression' || job.kind !== 'test')) throw new Error('Sandbox child-process capability is limited to the canonical regression job');
  verifyRuntimeLibraries(manifest.runtimeLibraries);
  verifyRuntimeConfigInputs(manifest.runtimeConfig);
  const executables = new Map(manifest.executables.map(item => [item.id, item]));
  const verified = [];
  for (const input of job.inputs) verified.push({ ...input, ...verifyPinnedFile(root, input) });
  const steps = job.steps.map(step => {
    const executable = executables.get(step.executable);
    if (!executable || !Array.isArray(step.args) || step.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096)) throw new Error('Invalid sandbox command step');
    return { executable: verifyExecutable(executable), executableId: executable.id, args: step.args };
  });
  if (!Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1000 || job.timeoutMs > 120_000 || !Number.isSafeInteger(job.maxOutputBytes) || job.maxOutputBytes < 1024 || job.maxOutputBytes > 2 * 1024 * 1024) throw new Error('Sandbox resource bounds are invalid');
  if (job.network !== 'disabled' || job.maxConcurrentProcesses !== 1) throw new Error('Sandbox job must disable network and bound process concurrency');
  return { job, inputs: verified, steps };
}

function makeProfile({ readRoots, writeRoots, exactReadFiles = [], protectedRead = [], protectedWrite = [], protectedReadPatterns = [], protectedWritePatterns = [], socketPath = null, allowLoopbackNetwork = false, denyFork = false, allowForkWithExactExec = false, execPaths = [] }) {
  const unique = values => [...new Set(values.map(real))];
  const uniqueExactFiles = values => [...new Set(values.map(value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Invalid exact sandbox read path');
    return path.resolve(value);
  }))];
  const lines = [
    '(version 1)',
    '(deny default)',
    '(import "/System/Library/Sandbox/Profiles/system.sb")',
    '(allow sysctl-read)',
    '(allow file-read-metadata (subpath "/"))'
  ];
  for (const root of unique(readRoots)) lines.push(`(allow file-read* file-test-existence (subpath ${sbplPath(root)}))`);
  for (const file of uniqueExactFiles(exactReadFiles)) lines.push(`(allow file-read* file-test-existence (literal ${sbplPath(file)}))`);
  for (const root of unique(writeRoots)) lines.push(`(allow file-read* file-test-existence file-write* (subpath ${sbplPath(root)}))`);
  for (const item of unique(protectedRead)) lines.push(`(deny file-read* (subpath ${sbplPath(item)}))`);
  for (const item of unique(protectedWrite)) lines.push(`(deny file-write* (subpath ${sbplPath(item)}))`);
  for (const pattern of protectedReadPatterns) lines.push(`(deny file-read* (regex #"${pattern}"))`);
  for (const pattern of protectedWritePatterns) lines.push(`(deny file-write* (regex #"${pattern}"))`);
  if (allowForkWithExactExec) lines.push('(allow process-fork)');
  if (!denyFork && !allowForkWithExactExec) lines.push('(allow process-fork)', '(allow process-exec)');
  else for (const executable of unique(execPaths)) lines.push(`(allow process-exec (literal ${sbplPath(executable)}))`);
  if (socketPath && !allowLoopbackNetwork) {
    const socket = sbplPath(socketPath);
    lines.push(`(deny network* (require-not (remote unix-socket (path-literal ${socket}))))`);
    lines.push(`(allow network-outbound (remote unix-socket (path-literal ${socket})))`);
  } else if (socketPath || allowLoopbackNetwork) {
    // Seatbelt deny rules override matching allows. Keep all exceptions in one
    // require-all: only the authenticated Unix socket and loopback endpoints
    // avoid the network denial; every external address remains denied.
    const exceptions = [];
    if (socketPath) exceptions.push(`(require-not (remote unix-socket (path-literal ${sbplPath(socketPath)})))`);
    if (allowLoopbackNetwork) {
      exceptions.push('(require-not (remote ip "localhost:*"))');
      exceptions.push('(require-not (local ip "localhost:*"))');
    }
    lines.push(`(deny network* (require-all ${exceptions.join(' ')}))`);
    if (socketPath) lines.push(`(allow network-outbound (remote unix-socket (path-literal ${sbplPath(socketPath)})))`);
    // This is deliberately loopback-only. There is no wildcard remote-IP
    // allowance in this mode.
    if (allowLoopbackNetwork) {
      lines.push('(allow network-bind (local ip "localhost:*"))');
      lines.push('(allow network-inbound (local ip "localhost:*"))');
      lines.push('(allow network-outbound (remote ip "localhost:*"))');
    }
  } else lines.push('(deny network*)');
  // This boundary is inherited by every child, independent of caller metadata,
  // trusted developer mode, shell API, PATH and broker decisions.
  const helperDirectory = path.resolve(__dirname, '../.runtime/slack-keychain');
  lines.push(`(deny process-exec (subpath ${sbplPath(helperDirectory)}))`,
    `(deny file-read* file-write* (subpath ${sbplPath(helperDirectory)}))`);

  return `${lines.join('\n')}\n`;
}

function makeWorkerProfile({ task, workspace, sessionDir, readRoots, writeRoots, exactReadFiles = [], protectedRead, protectedWrite, protectedReadPatterns, protectedWritePatterns, socketPath, trustedDeveloperMode = false, executable, nodePath, envPath }) {
  const level1ReadOnly = task?.mission?.capabilityProfile === LEVEL1_PROFILE_ID;
  const activeChatReadOnly = task?.mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID;
  if (level1ReadOnly && (task.mission.level !== 1 || !assertReadOnlyMission(task.mission) || task.workspace !== workspace)) throw new Error('Invalid Level 1 worker isolation scope');
  if (activeChatReadOnly && (!assertActiveChatMission(task.mission) || task.workspace !== workspace || task.localOllamaTransport !== true)) throw new Error('Invalid Active Chat worker isolation scope');
  const restrictedReadOnly = level1ReadOnly || activeChatReadOnly;
  const profile = makeProfile({
    readRoots: restrictedReadOnly ? readRoots.filter(root => path.resolve(root) !== path.resolve(workspace)) : readRoots,
    exactReadFiles,
    writeRoots: restrictedReadOnly ? [sessionDir] : writeRoots,
    protectedRead, protectedWrite, protectedReadPatterns, protectedWritePatterns, socketPath,
    allowLoopbackNetwork: trustedDeveloperMode === true && !restrictedReadOnly,
    denyFork: restrictedReadOnly,
    allowForkWithExactExec: !restrictedReadOnly,
    execPaths: [executable, nodePath, envPath].filter(Boolean)
  });
  if (restrictedReadOnly) return profile;
  // System directories are OS-owned. Arbitrary workspace binaries (including
  // renamed copies of privileged helpers) are never executable by workers.
  const systemExec = ['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/Applications/Xcode.app/Contents/Developer/usr/bin', '/Applications/Xcode.app/Contents/Developer/usr/libexec']
    .map(root => `(allow process-exec (subpath ${sbplPath(root)}))`).join('\n');
  const pinnedWriteDenials = [executable, nodePath, envPath].filter(Boolean)
    .map(file => `(deny file-write* (subpath ${sbplPath(path.dirname(real(file)))}))`).join('\n');
  return `${profile}${systemExec}\n${pinnedWriteDenials}\n`;

}

function isSameOrDescendant(root, target) {
  const canonicalRoot = path.resolve(root);
  const canonicalTarget = path.resolve(target);
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;
  return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(prefix);
}

// Seatbelt combines sibling filters on one operation rule as alternatives.
// Keep this scope in a require-all so the containment deny only applies to
// bridge runtime data outside this task's authorized session/workspace.
function makeRuntimeDeny({ runtimeRoot, sessionDir, workspace }) {
  for (const value of [runtimeRoot, sessionDir, workspace]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Runtime containment paths must be absolute');
  }
  const workspaceUnderRuntime = workspace !== runtimeRoot && workspace.startsWith(`${runtimeRoot}${path.sep}`);
  const filters = [
    `(subpath ${sbplPath(runtimeRoot)})`,
    `(require-not (subpath ${sbplPath(sessionDir)}))`
  ];
  if (workspaceUnderRuntime) filters.push(`(require-not (subpath ${sbplPath(workspace)}))`);
  return `(deny file-read* file-write* (require-all ${filters.join(' ')}))`;
}

function runtimeDenyMatches({ runtimeRoot, sessionDir, workspace }, target) {
  const workspaceUnderRuntime = workspace !== runtimeRoot && workspace.startsWith(`${runtimeRoot}${path.sep}`);
  return isSameOrDescendant(runtimeRoot, target) &&
    !isSameOrDescendant(sessionDir, target) &&
    !(workspaceUnderRuntime && isSameOrDescendant(workspace, target));
}

const PREFLIGHT = String.raw`
const fs=require('node:fs'),net=require('node:net');
const c=JSON.parse(process.argv[1]);
function denied(fn,label){try{const value=fn();if(value!==undefined&&Number.isInteger(value))fs.closeSync(value);throw new Error('sandbox unexpectedly allowed '+label)}catch(e){if(e.message.startsWith('sandbox unexpectedly allowed'))throw e;if(!['EACCES','EPERM'].includes(e.code))throw new Error(label+' check inconclusive: '+e.code)}}
async function main(){
 process.stdout.write('node-reached-javascript\n');
 if(typeof c.writableCanary!=='string'||!c.writableCanary)throw new Error('required writable canary is missing');
 fs.appendFileSync(c.writableCanary,'sandbox probe');fs.unlinkSync(c.writableCanary);
 if(!c.denialCanaries||!Array.isArray(c.denialCanaries.read)||!Array.isArray(c.denialCanaries.write)||!Array.isArray(c.denialCanaries.create)||!c.denialCanaries.read.length||!c.denialCanaries.write.length||!c.denialCanaries.create.length)throw new Error('required disposable denial canaries are missing');
 for(const file of c.denialCanaries.read)denied(()=>fs.openSync(file,'r'),'read access to disposable canary');
 for(const file of c.denialCanaries.write)denied(()=>fs.openSync(file,'r+'),'write access to disposable canary');
 for(const file of c.denialCanaries.create)denied(()=>fs.openSync(file,'wx'),'create access to disposable canary');
 if(c.socketPath){await new Promise((resolve,reject)=>{const s=net.createConnection({path:c.socketPath});const timer=setTimeout(()=>{s.destroy();reject(new Error('sandbox policy socket probe timed out'))},1000);s.once('connect',()=>{clearTimeout(timer);s.destroy();resolve()});s.once('error',e=>{clearTimeout(timer);reject(new Error('sandbox cannot reach policy socket: '+e.code))})})}
 await new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port:9});const timer=setTimeout(()=>{s.destroy();reject(new Error(c.allowLoopback?'loopback connectivity probe timed out':'TCP denial probe timed out'))},1000);s.once('connect',()=>{clearTimeout(timer);s.destroy();if(c.allowLoopback)resolve();else reject(new Error('sandbox unexpectedly allowed TCP'))});s.once('error',e=>{clearTimeout(timer);if(c.allowLoopback){if(e.code==='ECONNREFUSED')resolve();else reject(new Error('loopback connectivity probe inconclusive: '+e.code))}else if(['EPERM','EACCES'].includes(e.code))resolve();else reject(new Error('TCP denial probe inconclusive: '+e.code))})});
 process.stdout.write('seatbelt-probes-passed');
}
main().catch(e=>{process.stderr.write(e.message);process.exitCode=41});
`;

const LEVEL1_PREFLIGHT = String.raw`
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
const c=JSON.parse(process.argv[1]);
function denied(fn,label){try{const value=fn();if(Number.isInteger(value))fs.closeSync(value);throw new Error('sandbox unexpectedly allowed '+label)}catch(e){if(e.message.startsWith('sandbox unexpectedly allowed'))throw e;if(!['EACCES','EPERM'].includes(e.code))throw new Error(label+' check inconclusive: '+e.code)}}
async function main(){
 process.stdout.write('node-reached-javascript\n');
 denied(()=>fs.readFileSync(c.fixturePath),'direct fixture read');
 if(!c.denialCanaries||!Array.isArray(c.denialCanaries.read)||!Array.isArray(c.denialCanaries.write)||!Array.isArray(c.denialCanaries.create)||!c.denialCanaries.read.length||!c.denialCanaries.write.length||!c.denialCanaries.create.length)throw new Error('required disposable denial canaries are missing');
 for(const file of c.denialCanaries.read)denied(()=>fs.openSync(file,'r'),'read access to disposable canary');
 for(const file of c.denialCanaries.write)denied(()=>fs.openSync(file,'r+'),'write access to disposable canary');
 for(const file of c.denialCanaries.create)denied(()=>fs.openSync(file,'wx'),'create access to disposable canary');
 if(typeof c.writableCanary!=='string'||!c.writableCanary)throw new Error('required writable canary is missing');
 fs.appendFileSync(c.writableCanary,'private session scratch');fs.unlinkSync(c.writableCanary);
 const child=cp.spawnSync(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',timeout:1000});
 if(!child.error||!['EACCES','EPERM'].includes(child.error.code))throw new Error('process creation denial check failed: '+(child.error?.code||'child was started'));
 if(c.socketPath)await new Promise((resolve,reject)=>{const s=net.createConnection({path:c.socketPath});const timer=setTimeout(()=>{s.destroy();reject(new Error('policy socket probe timed out'))},1000);s.once('connect',()=>{clearTimeout(timer);s.destroy();resolve()});s.once('error',e=>{clearTimeout(timer);reject(new Error('policy socket probe failed: '+e.code))})});
 await new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port:9});const timer=setTimeout(()=>{s.destroy();reject(new Error('TCP denial probe timed out'))},1000);s.once('connect',()=>{clearTimeout(timer);s.destroy();reject(new Error('sandbox unexpectedly allowed TCP'))});s.once('error',e=>{clearTimeout(timer);if(['EPERM','EACCES'].includes(e.code))resolve();else reject(new Error('TCP denial probe inconclusive: '+e.code))})});
 process.stdout.write('level1-seatbelt-probes-passed');
}
main().catch(e=>{process.stderr.write(e.message);process.exitCode=41});
`;

// Uses the same enforced worker policy as bounded execution. It proves that the
// worker cannot read the currently assigned fixture directly, cannot create
// a subprocess, can use only the broker socket, and cannot open direct TCP.
const ACTIVE_CHAT_PREFLIGHT = LEVEL1_PREFLIGHT
  .replaceAll('level1-seatbelt-probes', 'active-chat-seatbelt-probes')
  .replaceAll('Level 1 fixture', 'Active Chat fixture')
  .replaceAll('direct fixture read', 'direct Active Chat fixture read');

module.exports = { MANIFEST_PATH, TRUSTED_WORKSPACE_PATHS, SECRET_COMPONENT_PATTERN, PROBE_OUTPUT_LIMIT, FORBIDDEN_RUNTIME_SELECTION_ENV, TRUSTED_DEV_MODE_ENV, isTrustedDeveloperModeEnabled, isApprovedTrustedDeveloperWorkspace, readManifest, verifyManifest, verifyExecutable, verifyRuntimeLibrary, verifyRuntimeLibraries, verifyOpenSslConfig, verifyRuntimeConfigInputs, sanitizedRuntimeEnv, verifyModuleClosure, resolvePinnedRuntimeImport, sha256Tree, comparePathNames, makeProfile, makeWorkerProfile, makeRuntimeDeny, runtimeDenyMatches, normalizeProbeText, inspectProbe, assertProbeSuccess, createPreflightCanaries, verifyPreflightCanaries, createWritableSessionCanary, assertCanaryCoverage, PREFLIGHT, LEVEL1_PREFLIGHT, ACTIVE_CHAT_PREFLIGHT };
