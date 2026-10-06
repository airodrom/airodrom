'use strict';
// New execution identities only. Persisted identities and typed Pi plans do not migrate.
const DEFAULT_RUNTIME = 'opencode';
function defaultRuntime(value = DEFAULT_RUNTIME) {
  if (!['opencode', 'pi'].includes(value)) throw Error('Invalid default execution runtime');
  return value;
}
const OPENCODE_DEFAULTS = Object.freeze({ enabled: true, model: 'ollama/qwen3-coder:30b' });
const LOCAL_POLICY = Object.freeze({ privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'focused_coding' });
module.exports = { DEFAULT_RUNTIME, defaultRuntime, OPENCODE_DEFAULTS, LOCAL_POLICY };
