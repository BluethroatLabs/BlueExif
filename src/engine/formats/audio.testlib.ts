/** ffmpeg / ffprobe helpers for the audio handler tests (Node only, never imported by the engine). */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MARK = 'SECRET-MARKER-42';

function withFile<T>(bytes: Uint8Array, name: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'blueexif-audio-'));
  const p = join(dir, name);
  writeFileSync(p, bytes);
  try {
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Decode the audio: errors printed by ffmpeg (should be '') and the MD5 of the decoded PCM. */
export function decode(bytes: Uint8Array, name: string): { errors: string; md5: string } {
  return withFile(bytes, name, (p) => {
    const r = run('ffmpeg', ['-nostdin', '-v', 'error', '-i', p, '-map', '0:a', '-f', 'md5', '-']);
    return { errors: r.stderr.trim(), md5: r.stdout.trim() };
  });
}

/** Container + stream tags as reported by ffprobe (keys lower-cased). */
export function ffprobeTags(bytes: Uint8Array, name: string): Record<string, string> {
  return withFile(bytes, name, (p) => {
    const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', p]);
    const j = JSON.parse(r.stdout || '{}') as { format?: { tags?: Record<string, string> }; streams?: Array<{ tags?: Record<string, string> }> };
    const out: Record<string, string> = {};
    for (const t of [j.format?.tags, ...(j.streams ?? []).map((s) => s.tags)]) {
      for (const [k, v] of Object.entries(t ?? {})) out[k.toLowerCase()] ??= v;
    }
    return out;
  });
}

/** Does the byte string contain `s` (Latin-1/UTF-8 or UTF-16LE)? */
export function contains(bytes: Uint8Array, s: string): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return b.includes(Buffer.from(s, 'utf8')) || b.includes(Buffer.from(s, 'utf16le'));
}
