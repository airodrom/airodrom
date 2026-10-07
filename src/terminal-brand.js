'use strict';
// Canonical SVG artwork: bundled image when supported, sampled text otherwise.
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
function imageProtocol({ tty = false, env = process.env } = {}) {
  if (!tty || env.NO_COLOR !== undefined || env.TERM === 'dumb' || env.TMUX || env.STY
    || /^(?:screen|tmux)/.test(env.TERM || '') || env.AIRODROM_INTRO_GRAPHICS === 'off') return '';
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm') return 'iterm2';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  return '';
}
let png;
function inlineImage(protocol, columns, rows) {
  if (!['kitty', 'iterm2'].includes(protocol)) return '';
  try {
    if (!png) {
      const file = path.join(__dirname, '../public/brand/airodrom-terminal-mark.png');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return '';
      const data = fs.readFileSync(file);
      if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '';
      png = data;
    }
    const payload = png.toString('base64');
    if (protocol === 'iterm2') {
      // Keep the cursor at the logo origin; subsequent lines reserve its space.
      return `\x1b7\x1b]1337;File=inline=1;size=${png.length};width=${columns};height=${rows};preserveAspectRatio=1:${payload}\x07\x1b8`;
    }
    let result = '';
    for (let i = 0; i < payload.length; i += 4096) {
      const metadata = i === 0 ? `a=T,f=100,c=${columns},r=${rows},C=1,` : '';
      // Quiet mode prevents terminal replies from entering the conversation input.
      result += `\x1b_G${metadata}q=2,m=${i + 4096 < payload.length ? 1 : 0};${payload.slice(i, i + 4096)}\x1b\\`;
    }
    return result;
  } catch { return ''; }
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
    // Muted teal-to-blue-to-violet face; signature slots remain open.
    const light = Math.max(0, Math.min(1, (px * .6 + py * .4 - 32) / 192));
    let color = light < .5 ? blend([46, 140, 145], [69, 111, 187], light * 2)
      : blend([69, 111, 187], [123, 78, 162], (light - .5) * 2);
    const rim = !inside(px - 1.5, py - 2);
    if (rim) color = blend(color, [134, 155, 193], .08);
    else if (!inside(px + 2, py + 2)) color = blend(color, [35, 49, 82], .25);
    return { type: rim ? 'highlight' : 'front', color, ansi: light < .3 ? 36 : light > .7 ? 35 : 34 };
  }
  // Extrude only outside the outer silhouette, so depth never fills the cutouts.
  if (!inPolygon(px, py, geometry[0])) {
    for (const depth of [2, 4, 6]) {
      if (coverage(depth, depth * .75) >= .5) {
        return { type: 'depth', color: blend([40, 44, 81], [25, 30, 55], lightDepth(py)) };
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
  const ansi = value.ansi || { front: 34, highlight: 94, depth: 90 }[value.type];
  return `\x1b[${background ? ansi + 10 : ansi}m`;
}
const cache = new Map();
function mark({ mode = 'none', compact = false, small = false, unicode = true } = {}) {
  mode = ['truecolor', '256', '16'].includes(mode) ? mode : 'none';
  compact = !!compact; small = !!small; unicode = !!unicode;
  const key = `${mode}:${compact}:${small}:${unicode}`;
  if (cache.has(key)) return [...cache.get(key)];
  const width = small ? 16 : compact ? 18 : 20, height = small ? 12 : compact ? 14 : 16, lines = [];
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
function intro({ color = false, mode, unicode = true, columns = 80, rows = 40, graphics = '' } = {}) {
  mode = mode || (color ? 'truecolor' : 'none');
  const compact = columns < 64 || rows < 28, small = rows < 28;
  const version = require('../package.json').version + ' · PRE-RELEASE';
  const title = (mode === 'none' ? 'AIRODROM' : sgr({type:'highlight',color:[100,140,196]},mode)+'AIRODROM\x1b[0m') + '\n'
    + wrap('MANY AGENTS. ONE CONTROL PLANE.', columns) + '\n';
  if (columns < 28) return title + 'PRE-RELEASE\n';
  if (rows < 24) return title + wrap(version, columns) + '\n';
  const width = small ? 16 : compact ? 18 : 20, height = small ? 6 : compact ? 7 : 8;
  const graphic = mode !== 'none' && unicode ? inlineImage(graphics, width, height) : '';
  const info = [version, '', 'Personal assistant.', 'Local. Private. Governed.'];
  if (graphic) {
    // Reserve rows first, including when the shell prompt starts near the bottom.
    const placement = '\r\n'.repeat(height) + `\x1b[${height}A\r` + graphic;
    if (compact) return title + '\r\n' + placement + '\r\n'.repeat(height) + wrap(version, columns) + '\n';
    const start = Math.floor((height - info.length) / 2);
    // Move across the image without writing spaces over its anchor cell.
    return title + '\r\n' + placement + Array.from({length:height}, (_, i) =>
      `\x1b[${width + 3}C${info[i - start] || ''}\r\n`).join('');
  }
  const art = mark({ mode, compact, small, unicode });
  if (compact) return title + '\n' + art.join('\n') + '\n' + wrap(version, columns) + '\n';
  const start = Math.floor((art.length - info.length) / 2);
  return title + '\n' + art.map((line, i) => line + '   ' + (info[i - start] || '')).join('\n') + '\n';
}
module.exports = { colorMode, imageProtocol, mark, intro, inside };
