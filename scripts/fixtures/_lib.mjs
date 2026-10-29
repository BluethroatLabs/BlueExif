// Helpers for fixture scripts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeMetadata, parseMetadata } from '@uswriting/exiftool';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

export function makeCtx(area) {
  const dir = join(root, area);
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), `blueexif-${area}-`));
  let n = 0;
  const ctx = {
    dir,
    tmp,
    path: (name) => join(dir, name),
    tmpPath: (name) => join(tmp, name),
    count: () => n,
    /** Run a command, throwing with stderr on failure. */
    run(cmd, args, opts = {}) {
      return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    },
    /** ffmpeg with quiet defaults */
    ffmpeg(args) {
      return execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    },
    read: (p) => new Uint8Array(readFileSync(p)),
    /** Write a fixture file (relative to the area dir). */
    write(name, data) {
      writeFileSync(join(dir, name), data);
      n++;
      return join(dir, name);
    },
    /**
     * Write tags with ExifTool. `tags` is { 'Group:Tag': value }. Returns bytes.
     * Throws if ExifTool reports an error.
     */
    async exiftoolWrite(bytes, name, tags, args = []) {
      const r = await writeMetadata({ name, data: bytes }, tags, { args });
      if (!r.success) throw new Error(`exiftool write failed for ${name}: ${r.error}`);
      return new Uint8Array(r.data);
    },
    async exiftoolRead(bytes, name, args = []) {
      const r = await parseMetadata({ name, data: bytes }, { args: ['-json', '-G1', '-a', ...args], transform: JSON.parse });
      if (!r.success) throw new Error(r.error);
      return r.data[0];
    },
    cleanup() {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return ctx;
}
