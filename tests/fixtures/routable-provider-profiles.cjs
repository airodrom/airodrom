'use strict';
// Gateway mechanics fixtures: the production profiles with DeepSeek's reserve flag
// removed, so routing, retry and circuit behaviour can still be exercised on its
// detailed model metadata. Production DeepSeek is reserve-only (ADR 0032).
const { initialProfiles } = require('../../src/provider-profiles');
module.exports = () => initialProfiles().map(p => p.id === 'deepseek' ? { ...p, reserve: false } : p);
