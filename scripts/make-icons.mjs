// Builds the PNG app icons in public/ from one SVG glyph, rendered with macOS
// `sips`. Run: npm run icons
//   icon-*.png           purpose "any": the glyph large on a rounded square
//   icon-maskable-*.png  purpose "maskable": full-bleed, the glyph inside the
//                        central safe circle (radius 40%) that every mask keeps
//   apple-touch-icon.png full-bleed (iOS rounds the corners itself)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const tmp = mkdtempSync(join(tmpdir(), 'blueexif-icons-'));

// The favicon's picture-and-fields mark (plus a sun) on a 48-unit canvas, centred on 24,24.
const GLYPH = `<rect x="3.6" y="8.6" width="28.8" height="30.8" stroke-width="2.6"/><path d="M3.6 32.6 L12.4 23.8 L19 30.4 L23.4 26 L32.4 35" stroke-width="2.4"/><circle cx="23" cy="17.4" r="3" stroke-width="2.4"/><g stroke-width="2.6" stroke-linecap="square"><path d="M36.4 14 H44.4"/><path d="M36.4 20 H41.6"/><path d="M36.4 26 H44.4"/></g><rect x="36.4" y="31" width="8" height="8.4" fill="#fafafa" stroke="none"/>`;

function svg(size, { scale, radius }) {
  const shift = 24 * (1 - scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="${radius}" fill="#0a0a0a"/><g transform="translate(${shift} ${shift}) scale(${scale})" stroke="#fafafa">${GLYPH}</g></svg>`;
}

const ANY = { scale: 0.72, radius: 10.5 };
const FULL_BLEED = { scale: 0.6, radius: 0 };
const icons = [
  ['icon-192.png', 192, ANY],
  ['icon-512.png', 512, ANY],
  ['icon-maskable-192.png', 192, FULL_BLEED],
  ['icon-maskable-512.png', 512, FULL_BLEED],
  ['apple-touch-icon.png', 180, FULL_BLEED],
];
try {
  for (const [name, size, look] of icons) {
    const src = join(tmp, name.replace(/\.png$/, '.svg'));
    writeFileSync(src, svg(size, look));
    execFileSync('sips', ['-s', 'format', 'png', src, '--out', join(out, name)], { stdio: 'ignore' });
    console.log(`public/${name}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
