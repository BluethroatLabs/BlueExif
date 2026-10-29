/** Shared test utilities. Only imported from *.test.ts files. */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseMetadata } from '@uswriting/exiftool';
import { DEFAULT_STRIP_OPTIONS, Source, type Edit, type Edits, type Field, type FieldValue, type Metadata, type StripOptions } from '../core/types';

export const FIXTURES = join(__dirname, '../../../fixtures');

export function fixturePath(rel: string): string {
  return join(FIXTURES, rel);
}

export function hasFixture(rel: string): boolean {
  return existsSync(fixturePath(rel));
}

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(rel)));
}

export function fixture(rel: string): Source {
  return Source.fromBytes(fixtureBytes(rel), rel.split('/').pop());
}

export async function bytesOf(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

export const REMOVE = Symbol('remove');

/** edits({ id: value, other: REMOVE }) */
export function edits(obj: Record<string, FieldValue | typeof REMOVE>): Edits {
  const m: Edits = new Map();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, v === REMOVE ? ({ op: 'remove' } as Edit) : ({ op: 'set', value: v } as Edit));
  }
  return m;
}

export function allFields(m: Metadata): Field[] {
  return m.groups.flatMap((g) => g.fields);
}

export function field(m: Metadata, id: string): Field | undefined {
  return allFields(m).find((f) => f.id === id);
}

export function fieldByLabel(m: Metadata, label: string): Field | undefined {
  return allFields(m).find((f) => f.label === label);
}

export function strip(opts: Partial<StripOptions> = {}): StripOptions {
  return { ...DEFAULT_STRIP_OPTIONS, ...opts };
}

export type EtTags = Record<string, unknown>;

/**
 * Run ExifTool (WASM) on bytes and return its JSON tags (grouped by family 1,
 * e.g. "IFD0:Artist", "XMP-dc:Title"). Includes "ExifTool:Validate" and any
 * "ExifTool:Warning"/"ExifTool:Error".
 */
export async function exiftool(bytes: Uint8Array | Blob, name: string, extraArgs: string[] = []): Promise<EtTags> {
  const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  const r = await parseMetadata(
    { name, data },
    {
      args: ['-json', '-G1', '-a', '-u', '-api', 'validate=1', '-all', '-Validate', '-Warning', '-Error', ...extraArgs],
      transform: (s: string) => JSON.parse(s),
    },
  );
  if (!r.success) throw new Error(`exiftool failed: ${r.error}`);
  const tags = (r.data as EtTags[])[0];
  return tags;
}

/**
 * Structural problems reported by ExifTool: errors plus warnings, excluding
 * lint about tags the source file never had ("Missing required …") and
 * other style-only notes that also fire on untouched camera files.
 */
export function etProblems(tags: EtTags): string[] {
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  return [...list(tags['ExifTool:Error']), ...list(tags['ExifTool:Warning'])].filter(
    (w) => !/^Missing required|^\[minor\] |Non-standard|^IFD\d? tag 0x\w+ \w+ is not allowed/i.test(w),
  );
}

/** Tags whose key ends with ":<name>" (any group). */
export function etFind(tags: EtTags, name: string): unknown[] {
  return Object.entries(tags)
    .filter(([k]) => k === name || k.endsWith(`:${name}`))
    .map(([, v]) => v);
}

export function etGroups(tags: EtTags): Set<string> {
  return new Set(Object.keys(tags).map((k) => k.split(':')[0]));
}

/** Keys of tags in metadata-bearing groups (excludes File/System/Composite/ExifTool). */
export function etMetaKeys(tags: EtTags): string[] {
  return Object.keys(tags).filter((k) => !/^(SourceFile|System|File|Composite|ExifTool)(:|$)/.test(k));
}
