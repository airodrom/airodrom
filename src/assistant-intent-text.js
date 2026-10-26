'use strict';

// Shared lexical cleanup for the host's Gmail, Calendar and local-compose parsers.
// This does not classify intent, authenticate input or authorize any operation.
function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normalize };
