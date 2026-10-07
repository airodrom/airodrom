'use strict';
// Sample the canonical even-odd SVG directly. No image protocol, fonts or network.
const fs = require('node:fs'), path = require('node:path');
const geometry = fs.readFileSync(path.join(__dirname, '../public/brand/airodrom-mark.svg'), 'utf8')
  .match(/<path d="([^"]+)"/)[1].split(' M')
  .map(s => [...s.matchAll(/(?:M|L)?\s*(-?\d+\.\d+),(-?\d+\.\d+)/g)].map(m => [+m[1], +m[2]]));
function inPolygon(x, y, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
function inside(x, y) {
  let filled = false;
  for (const poly of geometry) if (inPolygon(x, y, poly)) filled = !filled;
  return filled;
}
function colorMode({ tty = false, env = process.env } = {}) {
  if (!tty || env.NO_COLOR !== undefined || env.TERM === 'dumb') return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return 'truecolor';
  return /256color/.test(env.TERM || '') ? '256' : '16';
}
const blend = (a, b, amount) => a.map((v, i) => Math.round(v + (b[i] - v) * amount));
function pixel(x, y, width, height) {
  const px = 4 + (x + .5) / width * 256, py = 24 + (y + .5) / height * 216;
  const coverage = (dx = 0, dy = 0) => {
    let count = 0;
    // Subpixel sampling retains the narrow signature slots and smooths the face.
    for (const ox of [-.25, .25]) for (const oy of [-.25, .25]) {
      if (inside(px + ox * 256 / width - dx, py + oy * 216 / height - dy)) count++;
    }
    return count / 4;
  };
  const face = coverage();
  if (face >= .5) {
    // Subdued blue face with a directional bevel; signature slots remain open.
    const light = Math.max(0, Math.min(1, (py - 32) / 192));
    let color = blend([88, 140, 204], [62, 93, 157], light);
    const rim = !inside(px - 1.5, py - 2);
    if (rim) color = blend(color, [111, 165, 219], .18);
    else if (!inside(px + 2, py + 2)) color = blend(color, [41, 61, 104], .24);
    return { type: rim ? 'highlight' : 'front', color };
  }
  // Extrude only outside the outer silhouette, so depth never fills the cutouts.
  if (!inPolygon(px, py, geometry[0])) {
    for (const depth of [2, 4, 6, 8]) {
      if (coverage(depth, depth * .75) >= .5) {
        return { type: 'depth', color: blend([42, 45, 96], [28, 33, 62], lightDepth(py)) };
      }
    }
  }
  return null;
}
function lightDepth(y) { return Math.max(0, Math.min(1, (y - 32) / 198)); }
function sgr(value, mode, background = false) {
  if (!value) return `\x1b[${background ? 49 : 39}m`;
  const channel = background ? 48 : 38, c = value.color;
  if (mode === 'truecolor') return `\x1b[${channel};2;${c.join(';')}m`;
  if (mode === '256') return `\x1b[${channel};5;${16 + 36 * Math.round(c[0] / 51) + 6 * Math.round(c[1] / 51) + Math.round(c[2] / 51)}m`;
  const ansi = { front: 34, highlight: 94, depth: 90 }[value.type];
  return `\x1b[${background ? ansi + 10 : ansi}m`;
}
const cache = new Map();
function mark({ mode = 'none', compact = false, small = false, unicode = true } = {}) {
  mode = ['truecolor', '256', '16'].includes(mode) ? mode : 'none';
  compact = !!compact; small = !!small; unicode = !!unicode;
  const key = `${mode}:${compact}:${small}:${unicode}`;
  if (cache.has(key)) return [...cache.get(key)];
  const width = small ? 20 : compact ? 26 : 44, height = small ? 16 : compact ? 22 : 36, lines = [];
  for (let y = 0; y < height; y += 2) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const top = pixel(x, y, width, height), bottom = pixel(x, y + 1, width, height), value = top || bottom;
      if (mode === 'none' || !unicode) {
        const character = !value ? ' ' : !unicode ? value.type === 'depth' ? '+' : '#'
          : mode === 'none' && value.type === 'depth' ? '▓' : top && bottom ? '█' : top ? '▀' : '▄';
        row += (mode === 'none' ? '' : sgr(value, mode)) + character;
      } else if (top) row += sgr(top, mode) + sgr(bottom, mode, true) + '▀';
      else if (bottom) row += sgr(bottom, mode) + sgr(null, mode, true) + '▄';
      else row += sgr(null, mode) + sgr(null, mode, true) + ' ';
    }
    lines.push(row + (mode === 'none' ? '' : '\x1b[0m'));
  }
  cache.set(key, lines);
  return [...lines];
}
function wrap(text, width) {
  const lines = []; let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
function intro({ color = false, mode, unicode = true, columns = 80, rows = 40 } = {}) {
  mode = mode || (color ? 'truecolor' : 'none');
  const compact = columns < 78 || rows < 36, small = rows < 28;
  const version = require('../package.json').version + ' · PRE-RELEASE';
  const title = (mode === 'none' ? 'AIRODROM' : '\x1b[96mAIRODROM\x1b[0m') + '\n'
    + wrap('MANY AGENTS. ONE CONTROL PLANE.', columns) + '\n';
  if (columns < 28) return title + 'PRE-RELEASE\n';
  if (rows < 24) return title + wrap(version, columns) + '\n';
  const art = mark({ mode, compact, small, unicode });
  if (compact) return title + '\n' + art.join('\n') + '\n' + wrap(version, columns) + '\n';
  const info = [version, '', 'Personal assistant.', 'Many agents. One authority.', 'Local. Private. Governed.'];
  const start = Math.floor((art.length - info.length) / 2);
  return title + '\n' + art.map((line, i) => line + '   ' + (info[i - start] || '')).join('\n') + '\n';
}
module.exports = { colorMode, mark, intro, inside };
