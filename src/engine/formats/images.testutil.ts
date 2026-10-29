/** Test-only helpers shared by the PNG/WebP/GIF/TIFF tests (not a test file itself). */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMetadata } from '@uswriting/exiftool';
import type { FormatHandler } from '../core/types';
import { etProblems } from '../test/helpers';

export const MARKER = 'SECRET-MARKER-42';

export function hasTool(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run a tool on the bytes (written to a temp file) and return stderr + exit status. */
export function runOn(bytes: Uint8Array, ext: string, cmd: string, args: (file: string) => string[]): { out: string; err: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'blueexif-img-'));
  try {
    const file = join(dir, `x.${ext}`);
    writeFileSync(file, bytes);
    const r = spawnSync(cmd, args(file), { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, encoding: 'utf8' });
    return { out: r.stdout ?? '', err: (r.stderr ?? '').trim(), status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ffmpeg's complaints when decoding every frame ('' = decodes cleanly). */
export function decodeErrors(bytes: Uint8Array, ext: string): string {
  const r = runOn(bytes, ext, 'ffmpeg', (f) => ['-v', 'error', '-nostdin', '-i', f, '-f', 'null', '-']);
  return r.status === 0 ? r.err : r.err || `ffmpeg exited with ${r.status}`;
}

/** Number of decoded video frames according to ffprobe. */
export function frameCount(bytes: Uint8Array, ext: string): number {
  const r = runOn(bytes, ext, 'ffprobe', (f) => ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f]);
  return parseInt(r.out.trim(), 10);
}

/**
 * Every ExifTool warning/error (the JSON oracle keeps only the last duplicate
 * key), filtered like etProblems().
 */
export async function etAllProblems(bytes: Uint8Array | Blob, name: string): Promise<string[]> {
  const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  const r = await parseMetadata({ name, data }, { args: ['-a', '-s', '-G1', '-api', 'validate=1', '-Validate', '-Warning', '-Error'] });
  if (!r.success) throw new Error(`exiftool failed: ${r.error}`);
  const text = String(r.data);
  const list = text
    .split('\n')
    .map((l) => /^\[ExifTool\]\s+(Warning|Error)\s*:\s*(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[2]);
  return etProblems({ 'ExifTool:Warning': list });
}

export function containsText(bytes: Uint8Array, s: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(s, 'latin1')) || Buffer.from(bytes).includes(Buffer.from(s, 'utf8'));
}

/** Detection score of a handler for raw bytes and a file name. */
export function detectScore(h: FormatHandler, bytes: Uint8Array, name: string): number {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return h.detect({ head: bytes.subarray(0, 64 * 1024), name: lower, ext: dot >= 0 ? lower.slice(dot + 1) : '', size: bytes.length });
}

/** All values ExifTool reports for a tag (duplicates included), e.g. etValues(b, 'x.gif', 'Comment'). */
export async function etValues(bytes: Uint8Array | Blob, name: string, tag: string): Promise<string[]> {
  const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  const r = await parseMetadata({ name, data }, { args: ['-a', '-s', '-G1', `-${tag}`] });
  if (!r.success) throw new Error(`exiftool failed: ${r.error}`);
  return String(r.data)
    .split('\n')
    .map((l) => /^\[[^\]]+\]\s+\S+\s*:\s?(.*)$/.exec(l.trim())?.[1])
    .filter((v): v is string => v !== undefined);
}

/** MD5 of the decoded pixels of every frame (ffmpeg), to prove image data is untouched. */
export function pixelHash(bytes: Uint8Array, ext: string): string {
  const r = runOn(bytes, ext, 'ffmpeg', (f) => ['-v', 'error', '-nostdin', '-noautorotate', '-i', f, '-f', 'md5', '-']);
  return r.out.trim();
}
