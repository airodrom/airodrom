'use strict';
// Canonical SVG artwork: bundled image when supported, sampled text otherwise.
const fs = require('node:fs'), path = require('node:path');
const geometry = require('./terminal-logo-geometry');
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
    || /^(?:screen|tmux)/.test(env.TERM || '') || env.AIRODROM_INTRO_GRAPHICS !== 'image') return '';
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
function faceColor(x, y) {
  const t = Math.max(0, Math.min(1, (x * .55 + y * .45 - 28) / 200));
  const color = t < .5 ? blend([69, 200, 220], [80, 145, 255], t * 2)
    : blend([80, 145, 255], [110, 105, 220], (t - .5) * 2);
  const rim = !inside(x - 2, y - 2);
  return {type: rim ? 'highlight' : 'front', color: rim ? blend(color, [85, 210, 175], .25) : color, ansi: t < .25 ? 36 : t > .75 ? 35 : 34};
}
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
  const key = `${mode}:${!!compact}:${!!small}:${!!unicode}`;
  if (cache.has(key)) return [...cache.get(key)];
  const width = small ? 10 : compact ? 12 : 16, height = small ? 4 : compact ? 5 : 7;
  const lines = [], dots = [[0,0,1],[0,1,2],[0,2,4],[1,0,8],[1,1,16],[1,2,32],[0,3,64],[1,3,128]];
  // Each terminal cell resolves eight canonical SVG samples. Signature gaps stay open;
  // luminous depth comes from face shading rather than expanding the silhouette.
  for (let row = 0; row < height; row++) {
    let line = '';
    for (let col = 0; col < width; col++) {
      let mask = 0, value = null;
      for (const [dx,dy,bit] of dots) {
        const x = 8 + (col * 2 + dx + .5) / (width * 2) * 240;
        const y = 28 + (row * 4 + dy + .5) / (height * 4) * 200;
        if (inside(x,y)) { mask |= bit; value ||= faceColor(x,y); }
      }
      const glyph = !mask ? ' ' : unicode ? String.fromCharCode(0x2800 + mask) : '#';
      line += (mode === 'none' ? '' : sgr(value, mode)) + glyph;
    }
    lines.push(line + (mode === 'none' ? '' : '\x1b[0m'));
  }
  cache.set(key, lines);
  return [...lines];
}
function wrap(text, width) {
  const lines = []; let line = '';
  for (const word of text.split(' ').flatMap(word => word.match(new RegExp('.{1,' + Math.max(1, width) + '}', 'g')) || [])) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
function intro({ color = false, mode, unicode = true, columns = 80, rows = 40, graphics = '' } = {}) {
  mode = mode || (color ? 'truecolor' : 'none');
  columns = Math.max(1, Math.floor(columns));
  const compact = columns < 64 || rows < 28, small = rows < 24;
  const version = require('../package.json').version + ' · PRE-RELEASE';
  const title = (mode === 'none' ? 'AIRODROM'.slice(0, columns) : sgr({type:'highlight',color:[69,200,220]},mode)+'AIRODROM'.slice(0, columns)+'\x1b[0m') + '\n';
  if (columns < 28) return title + wrap('PRE-RELEASE', columns) + '\n';
  if (rows < 24 || !unicode) return title + wrap(version, columns) + '\n';
  const width = small ? 10 : compact ? 12 : 16, height = small ? 4 : compact ? 5 : 7;
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
