'use strict';

const { createHash } = require('node:crypto');
const { containsSecret } = require('./personal-memory');

class CapabilityInputError extends Error {}

function fail(message) { throw new CapabilityInputError(message); }

function object(input, name = 'input') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${name} must be an object`);
  return input;
}

// Every adapter validator checks its top-level fields with keys() first, so the
// first call made while describing a validator is that capability's input shape.
let shapeRecorder = null;

function keys(input, required = [], optional = [], name = 'capability input') {
  if (shapeRecorder && !shapeRecorder.shape) shapeRecorder.shape = { required: [...required], optional: [...optional] };
  object(input, name);
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(input).filter(key => !allowed.has(key));
  const missing = required.filter(key => input[key] === undefined);
  if (extra.length || missing.length) fail(`Invalid ${name}: ${[...missing.map(key => `missing ${key}`), ...extra.map(key => `unexpected ${key}`)].join(', ')}`);
  return input;
}

function text(value, name, { max = 4_000, min = 1, optional = false, multiline = true } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value) > max || value.includes('\0') || (!multiline && /[\r\n]/.test(value))) fail(`Invalid ${name}`);
  return value;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}

function bool(value, name, { optional = true } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') fail(`Invalid ${name}`);
  return value;
}

function oneOf(value, values, name, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!values.includes(value)) fail(`Invalid ${name}`);
  return value;
}

function list(value, name, { max = 64, item = entry => text(entry, name), optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${name}`);
  return value.map(item);
}

function pattern(value, regex, name, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !regex.test(value)) fail(`Invalid ${name}`);
  return value;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

// Tokens, passwords and keys: patterns shared with Personal Memory plus a
// high-entropy heuristic for bare secrets copied to the clipboard.
function looksSecret(value) {
  if (typeof value !== 'string' || !value) return false;
  if (containsSecret(value)) return true;
  const trimmed = value.trim();
  if (/^(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza|ya29|eyJ)[A-Za-z0-9_\-.=]{12,}$/.test(trimmed)) return true;
  if (/(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{4,}/i.test(value)) return true;
  if (/^[A-Za-z0-9+/_\-=.]{24,}$/.test(trimmed) && /[A-Z]/.test(trimmed) && /[a-z]/.test(trimmed) && /\d/.test(trimmed)) return true;
  return false;
}

// Redact token-like fragments in diagnostic text returned to the model.
function redactText(value, max = 16_000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_\-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\b/g, '[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .slice(0, max);
}

// Field-level schema derived from a validator's own keys() call. Field types are
// not declared by adapters, so only names and required-ness are reported.
function describeInputShape(validate) {
  shapeRecorder = { shape: null };
  try { validate({}); } catch { /* an empty object is expected to fail validation */ }
  const { shape } = shapeRecorder;
  shapeRecorder = null;
  if (!shape) return { type: 'object', shape_known: false };
  return {
    type: 'object',
    properties: Object.fromEntries([...shape.required, ...shape.optional].map(key => [key, {}])),
    required: shape.required,
    additionalProperties: false,
    shape_known: true
  };
}

module.exports = { CapabilityInputError, fail, object, keys, text, integer, bool, oneOf, list, pattern, sha256, looksSecret, redactText, describeInputShape };
