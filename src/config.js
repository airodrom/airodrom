'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const LOCAL_OLLAMA = Object.freeze({
  provider: 'ollama',
  model: 'qwen3-coder:30b',
  // Privileged native-tool profile. Same installed tag while qwen3-coder:30b is
  // capability-qualified; may diverge to a distinct local tool profile later.
  toolModel: 'qwen3-coder:30b',
  baseUrl: 'http://127.0.0.1:11434/v1'
});
function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}
function prepareProfile(dataDir, source) {
  source ||= process.env.PI_BRIDGE_SOURCE_PROFILE || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/profiles/local-dev');
  const settings = JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'));
  const profile = path.join(dataDir, 'profile'); fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  atomicJSON(path.join(profile, 'settings.json'), { defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel, defaultThinkingLevel: 'off', enableTelemetry: false, packages: [], retry: { enabled: false } });
  const modelFile = path.join(source, 'models.json');
  if (fs.existsSync(modelFile)) atomicJSON(path.join(profile, 'models.json'), JSON.parse(fs.readFileSync(modelFile, 'utf8')));
  // Keep any credentials private and out of the source tree. No credentials are logged or served.
  const auth = path.join(source, 'auth.json');
  if (fs.existsSync(auth) && !fs.existsSync(path.join(profile, 'auth.json'))) fs.copyFileSync(auth, path.join(profile, 'auth.json'));
  if (fs.existsSync(path.join(profile, 'auth.json'))) fs.chmodSync(path.join(profile, 'auth.json'), 0o600);
  return { profile, provider: settings.defaultProvider, model: settings.defaultModel };
}
function prepareWorkerProfile(sourceProfile, destination, { includeModelCatalog = true, localOllamaOnly = false } = {}) {
  // Worker profiles contain only non-secret settings and model metadata. In
  // particular, never copy auth.json or any provider token into the sandbox.
  const settings = JSON.parse(fs.readFileSync(path.join(sourceProfile, 'settings.json'), 'utf8'));
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (localOllamaOnly && (settings.defaultProvider !== LOCAL_OLLAMA.provider || settings.defaultModel !== LOCAL_OLLAMA.model)) {
    throw new Error('Brokered local Ollama worker requires the configured ollama/qwen3-coder:30b selection');
  }
  atomicJSON(path.join(destination, 'settings.json'), {
    defaultProvider: localOllamaOnly ? LOCAL_OLLAMA.provider : settings.defaultProvider,
    defaultModel: localOllamaOnly ? LOCAL_OLLAMA.model : settings.defaultModel,
    defaultThinkingLevel: 'off',
    enableTelemetry: false,
    packages: [],
    retry: { enabled: false }
  });
  const modelFile = path.join(sourceProfile, 'models.json');
  if (localOllamaOnly) {
    const models = [];
    const pushModel = (id, name) => {
      if (models.some(model => model.id === id)) return;
      models.push({
        id, name, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsTools: true, supportsStreaming: true, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: true }
      });
    };
    pushModel(LOCAL_OLLAMA.model, 'Qwen3 Coder 30B (brokered local)');
    pushModel(LOCAL_OLLAMA.toolModel, 'Qwen3 Coder 30B tools (brokered local)');
    atomicJSON(path.join(destination, 'models.json'), { providers: { ollama: {
      baseUrl: LOCAL_OLLAMA.baseUrl, api: 'openai-completions', apiKey: 'bridge-local-ollama',
      models,
      compat: { supportsTools: true, supportsStreaming: true, supportsDeveloperRole: false, supportsReasoningEffort: false }
    } } });
  } else if (includeModelCatalog && fs.existsSync(modelFile)) atomicJSON(path.join(destination, 'models.json'), JSON.parse(fs.readFileSync(modelFile, 'utf8')));
  return destination;
}
module.exports = { LOCAL_OLLAMA, atomicJSON, prepareProfile, prepareWorkerProfile };
