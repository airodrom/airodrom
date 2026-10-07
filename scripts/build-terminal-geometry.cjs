'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const geometry = fs.readFileSync(path.join(root, 'public/brand/airodrom-mark.svg'), 'utf8')
  .match(/<path d="([^"]+)"/)[1].split(' M')
  .map(s => [...s.matchAll(/(?:M|L)?\s*(-?\d+\.\d+),(-?\d+\.\d+)/g)].map(m => [+m[1], +m[2]]));
fs.writeFileSync(path.join(root, 'src/terminal-logo-geometry.js'),
  "'use strict';\n// Bundled from public/brand/airodrom-mark.svg; no runtime logo file access.\n// Regenerate with node scripts/build-terminal-geometry.cjs after SVG changes.\nmodule.exports = [\n"
  + geometry.map(poly => '  ' + JSON.stringify(poly)).join(',\n') + '\n];\n');
console.log('Canonical terminal geometry bundled.');
