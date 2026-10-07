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
function prepareControlProfile(dataDir, source) {
  const settings=source ? JSON.parse(fs.readFileSync(path.join(source,'settings.json'),'utf8')) : {};
  settings.defaultProvider ||= LOCAL_OLLAMA.provider; settings.defaultModel ||= LOCAL_OLLAMA.model;
  if(typeof settings.defaultProvider!=='string'||typeof settings.defaultModel!=='string')throw Error('Invalid control-plane provider selection');
  return {provider:settings.defaultProvider,model:settings.defaultModel};
}
module.exports = { LOCAL_OLLAMA, atomicJSON, prepareControlProfile };
