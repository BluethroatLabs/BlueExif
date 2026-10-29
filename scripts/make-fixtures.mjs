// Generates small test fixtures into ./fixtures using ffmpeg, macOS tools and
// ExifTool (WASM). Each area lives in scripts/fixtures/<area>.mjs and exports
// `default async function (ctx)`. Run: npm run fixtures [-- area ...]
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCtx } from './fixtures/_lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const areas = readdirSync(join(here, 'fixtures'))
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
  .map((f) => f.replace(/\.mjs$/, ''));
const unknown = only.filter((a) => !areas.includes(a));
if (unknown.length) {
  console.error(`Unknown fixture area: ${unknown.join(', ')}. Areas: ${areas.join(', ')}`);
  process.exit(1);
}
for (const area of areas.filter((a) => !only.length || only.includes(a))) {
  const ctx = makeCtx(area);
  process.stdout.write(`• ${area} … `);
  const mod = await import(pathToFileURL(join(here, 'fixtures', `${area}.mjs`)).href);
  await mod.default(ctx);
  console.log(`ok (${ctx.count()} files)`);
}
