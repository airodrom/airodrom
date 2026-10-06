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
  'src/worker-sandbox.js', 'src/sandbox-runner.js', 'src/mission-provider.js', 'src/bridge-controller.js',
  'src/control-server.js', 'src/config.js', 'src/safe-diagnostics.js',
  'src/safety-extension.mjs', 'src/rpc-supervisor.js', 'src/mission-supervisor.js',
  'src/mcp-tools.js', 'src/chatgpt-events.js', 'src/chatgpt-event-extension.mjs',
  'src/web-reader.js', 'src/memory-store.js', 'src/task-session-model.js',
  'scripts/run.cjs', 'scripts/macos', 'macos', 'package.json', 'package-lock.json',
  'config/safe-autonomy-manifest.json', 'wire.log'
];
const SECRET_COMPONENT_PATTERN = String.raw`(^|/)(?:\.git|\.pi|\.codex|\.bridge|\.ssh|\.aws|\.gnupg|\.config|\.npmrc|\.netrc|\.pypirc|\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|auth\.json|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx))(/|$)`;
const PROBE_OUTPUT_LIMIT = 4096;
const FORBIDDEN_RUNTIME_SELECTION_ENV = Object.freeze(['NODE_OPTIONS', 'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_MODULES', 'OPENSSL_ENGINES']);
const TRUSTED_DEV_MODE_ENV = 'PI_TRUSTED_DEV_MODE';

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
  const root = fs.mkdtempSync(path.join(parent, 'pi-bridge-sandbox-canary-'));
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

// Provider-runtime pins must not vary with the process locale or ICU data.
// The manifest format orders path names by their UTF-8 bytes.
function compareProviderRuntimeNames(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256Tree(root, label = 'runtime') {
  const canonicalRoot = real(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error(`Pinned ${label} root is not a directory`);
  const digest = crypto.createHash('sha256');
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareProviderRuntimeNames(a.name, b.name))) {
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

function verifyProviderRuntime(providerRuntime) {
  if (!providerRuntime || !path.isAbsolute(providerRuntime.entrypoint) ||
      !Array.isArray(providerRuntime.roots) || providerRuntime.roots.length < 1) {
    throw new Error('Pinned local Ollama provider runtime is required');
  }
  const roots = providerRuntime.roots.map(item => {
    if (!item || !path.isAbsolute(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid pinned provider runtime root');
    const verified = sha256Tree(item.path, 'provider runtime');
    if (verified.sha256 !== item.sha256) throw new Error(`Pinned provider runtime hash mismatch: ${item.path}`);
    return verified.root;
  });
  const entrypoint = real(providerRuntime.entrypoint);
  if (!fs.statSync(entrypoint).isFile() || !roots.some(root => entrypoint.startsWith(`${root}${path.sep}`))) {
    throw new Error('Local Ollama provider entrypoint is outside the pinned runtime');
  }
  if (providerRuntime.entrypointSha256 !== sha256(entrypoint)) throw new Error('Pinned local Ollama provider entrypoint hash mismatch');
  return { roots, entrypoint, entrypointUrl: pathToFileURL(entrypoint).href };
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

function verifyWorkerRuntimeClosure(worker) {
  const closure = worker?.runtimeClosure;
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

function verifyWorkerPackage(worker) {
  if (!worker || !path.isAbsolute(worker.bundleRoot) || !Array.isArray(worker.files) || !worker.files.length) throw new Error('Pinned Pi runtime bundle is required');
  const bundleRoot = real(worker.bundleRoot);
  if (!fs.statSync(bundleRoot).isDirectory()) throw new Error('Pinned Pi runtime bundle is not a directory');
  const expected = new Map();
  for (const item of worker.files) {
    if (!item || typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid pinned Pi runtime file');
    const lexical = path.resolve(bundleRoot, item.path);
    if (!lexical.startsWith(`${bundleRoot}${path.sep}`) || expected.has(item.path)) throw new Error('Pinned Pi runtime file escapes or duplicates the bundle');
    let cursor = lexical;
    while (cursor !== bundleRoot) {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Pinned Pi runtime traverses a symbolic link: ${item.path}`);
      cursor = path.dirname(cursor);
    }
    const stat = fs.lstatSync(lexical);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(lexical) !== item.sha256) throw new Error(`Pinned Pi runtime verification failed: ${item.path}`);
    expected.set(item.path, item.sha256);
  }
  const actual = [];
  const walk = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unpinned symbolic link in Pi runtime bundle: ${name}`);
      if (entry.isDirectory()) walk(file, name);
      else if (entry.isFile()) actual.push(name);
      else throw new Error(`Unsupported file in Pi runtime bundle: ${name}`);
    }
  };
  walk(bundleRoot);
  if (actual.length !== expected.size || actual.some(item => !expected.has(item))) throw new Error('Pi runtime bundle contents differ from the pinned file inventory');
  if (!worker.packageMetadata || !path.isAbsolute(worker.packageMetadata.path) || !/^[a-f0-9]{64}$/.test(worker.packageMetadata.sha256)) throw new Error('Pinned Pi package metadata is required');
  const packageMetadata = real(worker.packageMetadata.path);
  if (!fs.statSync(packageMetadata).isFile() || sha256(packageMetadata) !== worker.packageMetadata.sha256) throw new Error('Pinned Pi package metadata verification failed');
  if (typeof worker.entrypoint !== 'string' || !expected.has(worker.entrypoint) || expected.get(worker.entrypoint) !== worker.entrypointSha256) throw new Error('Pi entrypoint is not covered by the pinned bundle inventory');
  return { bundleRoot, packageMetadata };
}

const PI_BUILTIN_THEME_FILENAMES = Object.freeze(['dark.json', 'light.json']);

// Pi initializes its terminal theme before entering RPC mode. The bundled
// loader resolves these two exact files relative to the verified bundle; do
// not turn the package directory or its theme directory into a read root.
function verifyBuiltinThemeAssets(worker, pinnedPi) {
  if (!worker || !Array.isArray(worker.builtinThemeAssets) || worker.builtinThemeAssets.length !== PI_BUILTIN_THEME_FILENAMES.length) {
    throw new Error('Pinned Pi built-in theme assets are required');
  }
  const bundleRoot = pinnedPi?.bundleRoot;
  const distRoot = typeof bundleRoot === 'string' ? path.dirname(bundleRoot) : null;
  if (!distRoot || path.basename(bundleRoot) !== 'bundle' || path.basename(distRoot) !== 'dist') {
    throw new Error('Pinned Pi bundle has an unsupported layout for built-in themes');
  }
  const themeRoot = path.join(path.dirname(distRoot), 'dist', 'modes', 'interactive', 'theme');
  const expected = new Set(PI_BUILTIN_THEME_FILENAMES.map(name => path.join(themeRoot, name)));
  const verified = [];
  for (const item of worker.builtinThemeAssets) {
    if (item?.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.length !== 0)) {
      throw new Error('Pi built-in theme assets cannot use aliases');
    }
    if (!item || typeof item.path !== 'string' || !expected.delete(path.resolve(item.path))) {
      throw new Error('Pi built-in theme asset is not an approved bundled theme');
    }
    const asset = verifyPinnedRuntimeFile(item, 'Pi built-in theme asset');
    if (asset.paths.length !== 1 || asset.canonical !== path.resolve(item.path)) {
      throw new Error('Pi built-in theme asset must be a canonical regular file');
    }
    verified.push(asset.canonical);
  }
  if (expected.size) throw new Error('Pinned Pi built-in theme asset is missing');
  return { paths: verified.sort((left, right) => left.localeCompare(right)) };
}

function verifyManifest(root, manifest, jobName) {
  const job = manifest.jobs.find(entry => entry.name === jobName);
  if (!job) throw new Error(`Sandbox job is not approved: ${jobName}`);
  if (!['test', 'build'].includes(job.kind) || !Array.isArray(job.inputs) || !Array.isArray(job.steps) || job.steps.length < 1 || job.steps.length > 64) throw new Error('Invalid sandbox job');
  if (job.requiresProviderRuntime !== undefined && typeof job.requiresProviderRuntime !== 'boolean') throw new Error('Sandbox provider runtime option is invalid');
  if (job.requiresWorkerRuntimeClosure !== undefined && typeof job.requiresWorkerRuntimeClosure !== 'boolean') throw new Error('Sandbox worker runtime option is invalid');
  if (job.requiresWorkerRuntimeClosure === true && (jobName !== 'safe-autonomy-regression' || job.kind !== 'test')) throw new Error('Sandbox worker runtime capability is limited to the canonical regression job');
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

// Uses the same enforced worker policy as active Pi. It proves that the
// worker cannot read the currently assigned fixture directly, cannot create
// a subprocess, can use only the broker socket, and cannot open direct TCP.
const ACTIVE_CHAT_PREFLIGHT = LEVEL1_PREFLIGHT
  .replaceAll('level1-seatbelt-probes', 'active-chat-seatbelt-probes')
  .replaceAll('Level 1 fixture', 'Active Chat fixture')
  .replaceAll('direct fixture read', 'direct Active Chat fixture read');

class WorkerSandbox {
  constructor({ repoRoot, dataDir, manifestPath = MANIFEST_PATH, sandboxExec = '/usr/bin/sandbox-exec', trustedDeveloperMode = false, trustedDeveloperRoot = path.join(os.homedir(), 'code') }) {
    this.repoRoot = real(repoRoot); this.dataDir = path.resolve(dataDir); this.manifestPath = manifestPath; this.sandboxExec = sandboxExec;
    this.trustedDeveloperMode = trustedDeveloperMode === true; this.trustedDeveloperRoot = path.resolve(trustedDeveloperRoot);
  }

  /**
   * Isolated fake-pi harness for unit/lifecycle tests only. Never used by the
   * managed daemon path; refuses anything other than tests/fixtures/fake-pi.cjs.
   */
  prepareFixture(task, { executable, socketPath }) {
    const resolved = real(executable);
    const expected = real(path.join(this.repoRoot, 'tests/fixtures/fake-pi.cjs'));
    if (resolved !== expected) throw new Error('Fixture worker requires tests/fixtures/fake-pi.cjs');
    const workspace = real(task.workspace);
    const sessionDir = real(task.sessionDir);
    const workerHome = path.join(sessionDir, 'home');
    const tempDir = path.join(sessionDir, 'tmp');
    fs.mkdirSync(workerHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const reviewEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('BRIDGE_REVIEW_')));
    const nodeDir = path.dirname(real(process.execPath));
    return {
      sandboxExec: null,
      profilePath: null,
      cwd: workspace,
      preflightDiagnostics: { fixture: true },
      trustedDeveloperMode: false,
      env: {
        ...reviewEnv,
        HOME: workerHome,
        PATH: `${nodeDir}:/usr/bin:/bin`,
        TMPDIR: tempDir,
        LANG: 'C',
        TERM: 'dumb',
        BRIDGE_POLICY_SOCKET: socketPath,
        BRIDGE_TASK_TOKEN: task.workerToken
      }
    };
  }

  prepare(task, { executable, socketPath }) {
    if (process.platform !== 'darwin') throw new Error('OS worker sandbox is unavailable on this platform');
    const manifest = readManifest(this.manifestPath);
    const pins = Object.fromEntries(manifest.executables.map(item => [item.id, verifyExecutable(item)]));
    const runtimeLibraries = verifyRuntimeLibraries(manifest.runtimeLibraries);
    const runtimeConfigs = verifyRuntimeConfigInputs(manifest.runtimeConfig);
    let runtimeReadFiles = [...runtimeLibraries, ...runtimeConfigs].flatMap(input => input.paths);
    const sandboxPin = manifest.executables.find(item => item.id === 'sandbox-exec');
    if (!sandboxPin || pins['sandbox-exec'] !== real(this.sandboxExec)) throw new Error('Pinned macOS sandbox executable mismatch');
    const nodePin = manifest.executables.find(item => item.id === 'node');
    if (!nodePin || pins.node !== real(process.execPath)) throw new Error('Pinned Node executable mismatch');
    const envPin = manifest.executables.find(item => item.id === 'env');
    if (!envPin || pins.env !== real('/usr/bin/env')) throw new Error('Pinned env executable mismatch');
    const piPin = manifest.worker;
    const pinnedPi = verifyWorkerPackage(piPin);
    const builtinThemeAssets = verifyBuiltinThemeAssets(piPin, pinnedPi);
    const workerRuntime = verifyWorkerRuntimeClosure(piPin);
    const providerRuntime = task.localOllamaTransport === true ? verifyProviderRuntime(manifest.providerRuntime) : null;
    if (real(executable) !== real(piPin.launcher) || sha256(executable) !== piPin.launcherSha256 || path.dirname(real(executable)) !== pinnedPi.bundleRoot || piPin.entrypointSha256 !== sha256(path.join(pinnedPi.bundleRoot, piPin.entrypoint))) throw new Error('Pinned Pi worker executable mismatch');
    const workspace = real(task.workspace), sessionDir = real(task.sessionDir);
    if (workspace === this.repoRoot && task.mission?.requireGrant) throw new Error('Grant-bound Pi workers must use a disposable task workspace');
    const restrictedProfile = task.mission?.capabilityProfile === LEVEL1_PROFILE_ID || task.mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID;
    const trustedDeveloperMode = this.trustedDeveloperMode && !restrictedProfile && isApprovedTrustedDeveloperWorkspace(workspace, this.trustedDeveloperRoot);
    const workerHome = path.join(sessionDir, 'home');
    const tempDir = path.join(sessionDir, 'tmp');
    fs.mkdirSync(workerHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const profilePath = path.join(this.dataDir, 'sandboxes', `${task.id}-${crypto.randomUUID()}.sb`);
    const preflightProfilePath = `${profilePath}.preflight`;
    fs.mkdirSync(path.dirname(profilePath), { recursive: true, mode: 0o700 });
    const runtimeRoot = real(this.dataDir);
    const piRoot = pinnedPi.bundleRoot;
    const piPackageRoot = real(path.dirname(pinnedPi.packageMetadata));
    const piPackage = JSON.parse(fs.readFileSync(pinnedPi.packageMetadata, 'utf8'));
    if (piPackage.name !== '@earendil-works/pi-coding-agent' || piPackage.version !== '1.0.2') throw new Error('Trusted developer mode requires pinned Pi 1.0.2');
    const nodeRoot = path.dirname(real(process.execPath));
    // Hardened workers receive only the static extension import closure. The
    // explicit development mode instead receives the bridge source tree and
    // the verified Pi package tree so normal package-owned startup assets and
    // local extension dependencies cannot fail one file at a time.
    runtimeReadFiles = [...runtimeReadFiles, pinnedPi.packageMetadata, ...builtinThemeAssets.paths];
    const bridgeRuntimeReads = trustedDeveloperMode ? [this.repoRoot, piPackageRoot] : [
      path.join(this.repoRoot, 'src/safety-extension.mjs'), path.join(this.repoRoot, 'src/chatgpt-event-extension.mjs'), path.join(this.repoRoot, 'src/chatgpt-events.js')
    ];
    const developmentToolReads = trustedDeveloperMode ? ['/opt/homebrew', '/usr/local', '/Library/Developer'] : [];
    const readRoots = [workspace, sessionDir, workerHome, piRoot, ...bridgeRuntimeReads,
      nodeRoot, ...workerRuntime.roots, ...(providerRuntime?.roots || []), ...developmentToolReads, '/System', '/usr/lib', '/usr/share', '/usr/bin/env', '/bin', '/sbin', '/Library/Apple', '/dev'];
    const writeRoots = [workspace, sessionDir];
    const protectedRead = [path.join(os.homedir(), '.pi'), path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), path.join(os.homedir(), '.gnupg'), path.join(os.homedir(), '.config'), path.join(os.homedir(), '.npmrc'), path.join(os.homedir(), '.netrc'), path.join(os.homedir(), '.pypirc'), path.join(os.homedir(), 'Library/Keychains'), path.join(this.repoRoot, 'wire.log')];
    const protectedWrite = [...(trustedDeveloperMode ? [] : TRUSTED_WORKSPACE_PATHS.map(item => path.join(this.repoRoot, item))), path.join(os.homedir(), '.pi'), path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), path.join(os.homedir(), '.gnupg'), path.join(os.homedir(), '.config'), path.join(os.homedir(), '.npmrc'), path.join(os.homedir(), '.netrc'), path.join(os.homedir(), '.pypirc'), path.join(os.homedir(), 'Library/Keychains')];
    // The only carve-outs under private bridge runtime are the selected task's
    // workspace and session directory. A bridge-root workspace does not exempt
    // its nested runtime directory.
    const runtimeDeny = makeRuntimeDeny({ runtimeRoot, sessionDir, workspace });
    const canaries = createPreflightCanaries();
    const writableCanary = createWritableSessionCanary(sessionDir);
    const level1WritableCanary = restrictedProfile ? createWritableSessionCanary(sessionDir) : null;
    const preflightDiagnostics = {};
    try {
      const existingProtectedRead = protectedRead.filter(item => fs.existsSync(item));
      const existingProtectedWrite = protectedWrite.filter(item => fs.existsSync(item));
      const denialCanaries = verifyPreflightCanaries(canaries);
      const protectedCanaryRead = [...existingProtectedRead, denialCanaries.root];
      const protectedCanaryWrite = [...existingProtectedWrite, denialCanaries.root];
      const workerProfile = `${makeWorkerProfile({ task, workspace, sessionDir, readRoots, writeRoots, exactReadFiles: runtimeReadFiles, protectedRead: protectedCanaryRead, protectedWrite: protectedCanaryWrite, protectedReadPatterns: [SECRET_COMPONENT_PATTERN], protectedWritePatterns: [SECRET_COMPONENT_PATTERN], socketPath, trustedDeveloperMode, executable: real(executable), nodePath: pins.node, envPath: pins.env })}${runtimeDeny}\n`;
      const preflightProfile = `${makeProfile({ readRoots, writeRoots, exactReadFiles: runtimeReadFiles, protectedRead: protectedCanaryRead, protectedWrite: protectedCanaryWrite, protectedReadPatterns: [SECRET_COMPONENT_PATTERN], protectedWritePatterns: [SECRET_COMPONENT_PATTERN], socketPath, allowLoopbackNetwork: trustedDeveloperMode })}${runtimeDeny}\n`;
      assertCanaryCoverage(workerProfile, denialCanaries);
      assertCanaryCoverage(preflightProfile, denialCanaries);
      fs.writeFileSync(profilePath, workerProfile, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(preflightProfilePath, preflightProfile, { mode: 0o600, flag: 'wx' });
      const probeConfig = {
        writableCanary, socketPath, allowLoopback: trustedDeveloperMode,
        denialCanaries
      };
      preflightDiagnostics.level1 = { stage: 'level1-seatbelt-probes', childStatus: null, signal: null, errorCode: null, timedOut: false, nodeReachedJavaScript: false, expectedMarker: 'level1-seatbelt-probes-passed', markerPresent: false, stdout: '', stderr: '', success: false, skipped: true, reason: 'not attempted: canonical sandbox probe did not complete' };
      preflightDiagnostics.activeChat = { stage: 'active-chat-seatbelt-probes', childStatus: null, signal: null, errorCode: null, timedOut: false, nodeReachedJavaScript: false, expectedMarker: 'active-chat-seatbelt-probes-passed', markerPresent: false, stdout: '', stderr: '', success: false, skipped: true, reason: 'not attempted: canonical sandbox probe did not complete' };
      const preflightEnv = sanitizedRuntimeEnv({ PATH: trustedDeveloperMode ? `${nodeRoot}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` : `${nodeRoot}:/usr/bin:/bin`, HOME: workerHome, TMPDIR: tempDir, LANG: 'C' });
      const canonicalChild = spawnSync(this.sandboxExec, ['-f', preflightProfilePath, process.execPath, '-e', PREFLIGHT, JSON.stringify(probeConfig)], {
        cwd: sessionDir, env: preflightEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024
      });
      preflightDiagnostics.canonical = inspectProbe('canonical-seatbelt-probes', canonicalChild, 'seatbelt-probes-passed');
      assertProbeSuccess(preflightDiagnostics.canonical, 'Pi OS sandbox verification failed closed', preflightDiagnostics);
      if (restrictedProfile) {
        const activeChat = task.mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID;
        const activePath = activeChat ? task.activeChat?.phase === 'task_a_running' ? task.mission.scope.readOnlyPaths[0] : task.activeChat?.phase === 'task_b_running' ? task.mission.scope.readOnlyPaths[1] : null : task.mission.readOnlyPaths[0];
        const stage = activeChat ? 'active-chat-seatbelt-probes' : 'level1-seatbelt-probes';
        const marker = activeChat ? 'active-chat-seatbelt-probes-passed' : 'level1-seatbelt-probes-passed';
        const profileName = activeChat ? 'Active Chat' : 'Level 1';
        const diagnosticsKey = activeChat ? 'activeChat' : 'level1';
        const fixturePath = typeof activePath === 'string' ? path.join(workspace, activePath) : null;
        let fixture;
        try { fixture = fs.lstatSync(fixturePath); } catch (error) {
          preflightDiagnostics[diagnosticsKey] = { stage, childStatus: null, signal: null, errorCode: error.code || null, timedOut: false, nodeReachedJavaScript: false, expectedMarker: marker, markerPresent: false, stdout: '', stderr: '', success: false, skipped: false, reason: `inconclusive: ${profileName} fixture preflight target is unavailable (${error.code || 'unknown error'})` };
          const failure = new Error(preflightDiagnostics[diagnosticsKey].reason); failure.probeDiagnostics = preflightDiagnostics; throw failure;
        }
        if (!fixture.isFile() || fixture.isSymbolicLink()) {
          preflightDiagnostics[diagnosticsKey] = { stage, childStatus: null, signal: null, errorCode: null, timedOut: false, nodeReachedJavaScript: false, expectedMarker: marker, markerPresent: false, stdout: '', stderr: '', success: false, skipped: false, reason: `inconclusive: ${profileName} fixture preflight target is invalid` };
          const failure = new Error(preflightDiagnostics[diagnosticsKey].reason); failure.probeDiagnostics = preflightDiagnostics; throw failure;
        }
        const level1ProbeConfig = {
          fixturePath,
          writableCanary: level1WritableCanary,
          socketPath,
          denialCanaries
        };
        const level1Child = spawnSync(this.sandboxExec, ['-f', profilePath, process.execPath, '-e', activeChat ? ACTIVE_CHAT_PREFLIGHT : LEVEL1_PREFLIGHT, JSON.stringify(level1ProbeConfig)], {
          cwd: sessionDir, env: preflightEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024
        });
        preflightDiagnostics[diagnosticsKey] = inspectProbe(stage, level1Child, marker);
        assertProbeSuccess(preflightDiagnostics[diagnosticsKey], `${profileName} read-only process sandbox verification failed closed`, preflightDiagnostics);
      } else {
        preflightDiagnostics.level1 = { stage: 'level1-seatbelt-probes', childStatus: null, signal: null, errorCode: null, timedOut: false, nodeReachedJavaScript: false, expectedMarker: 'level1-seatbelt-probes-passed', markerPresent: false, stdout: '', stderr: '', success: false, skipped: true, reason: 'not attempted: task is not a Level 1 mission' };
        preflightDiagnostics.activeChat = { stage: 'active-chat-seatbelt-probes', childStatus: null, signal: null, errorCode: null, timedOut: false, nodeReachedJavaScript: false, expectedMarker: 'active-chat-seatbelt-probes-passed', markerPresent: false, stdout: '', stderr: '', success: false, skipped: true, reason: 'not attempted: task is not an Active Chat mission' };
      }
    } finally {
      for (const file of [preflightProfilePath]) try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const file of [writableCanary, level1WritableCanary]) if (file) try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.rmSync(canaries.root, { recursive: true, force: true });
    }
    return {
      sandboxExec: this.sandboxExec,
      profilePath,
      cwd: workspace,
      preflightDiagnostics,
      trustedDeveloperMode,
      env: sanitizedRuntimeEnv({ HOME: workerHome, PATH: trustedDeveloperMode ? `${nodeRoot}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` : `${nodeRoot}:/usr/bin:/bin`, TMPDIR: tempDir, LANG: 'C', TERM: 'dumb', PI_CODING_AGENT_DIR: task.workerProfile, PI_OFFLINE: '1', PI_TELEMETRY: '0', BRIDGE_POLICY_SOCKET: socketPath, BRIDGE_TASK_TOKEN: task.workerToken,
        ...(trustedDeveloperMode ? { BRIDGE_TRUSTED_DEV_MODE: '1', npm_config_cache: path.join(tempDir, 'npm-cache') } : {}),
        ...(providerRuntime ? { BRIDGE_LOCAL_OLLAMA_TRANSPORT: '1', BRIDGE_PI_OPENAI_COMPLETIONS_MODULE: providerRuntime.entrypointUrl } : {}),
        ...(task.mission?.capabilityProfile === 'safe-autonomy-level1-read-only-v1' ? { BRIDGE_CAPABILITY_PROFILE: 'safe-autonomy-level1-read-only-v1' } : {}),
        ...(task.mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID ? { BRIDGE_CAPABILITY_PROFILE: ACTIVE_CHAT_PROFILE_ID } : {}) })
    };
  }
}

module.exports = { WorkerSandbox, MANIFEST_PATH, TRUSTED_WORKSPACE_PATHS, SECRET_COMPONENT_PATTERN, PROBE_OUTPUT_LIMIT, FORBIDDEN_RUNTIME_SELECTION_ENV, TRUSTED_DEV_MODE_ENV, isTrustedDeveloperModeEnabled, isApprovedTrustedDeveloperWorkspace, readManifest, verifyManifest, verifyExecutable, verifyRuntimeLibrary, verifyRuntimeLibraries, verifyOpenSslConfig, verifyRuntimeConfigInputs, sanitizedRuntimeEnv, verifyWorkerPackage, verifyBuiltinThemeAssets, verifyWorkerRuntimeClosure, resolvePinnedRuntimeImport, verifyProviderRuntime, sha256Tree, compareProviderRuntimeNames, makeProfile, makeWorkerProfile, makeRuntimeDeny, runtimeDenyMatches, normalizeProbeText, inspectProbe, assertProbeSuccess, createPreflightCanaries, verifyPreflightCanaries, createWritableSessionCanary, assertCanaryCoverage, PREFLIGHT, LEVEL1_PREFLIGHT, ACTIVE_CHAT_PREFLIGHT };
