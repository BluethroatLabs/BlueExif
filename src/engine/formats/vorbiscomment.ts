/**
 * Vorbis comments (FLAC VORBIS_COMMENT block; Ogg Vorbis / Opus / FLAC
 * comment packets) and the FLAC PICTURE structure (a native FLAC block, or
 * base64 in a METADATA_BLOCK_PICTURE comment in Ogg). Shared by flac.ts and
 * ogg.ts.
 *
 * Fields: `vorbis:<KEY>` (key upper-cased; repeated keys become list fields),
 * the vendor string `vorbis:vendor` (raw), pictures `vorbis:picture:<n>`
 * (+ `vorbis:picture:new`).
 */

import { Reader, Writer, base64Decode, encodeUtf8, formatBytes, latin1, utf8OrLatin1 } from '../core/binary';
import {
  PICTURE_TYPES,
  asImage,
  asList,
  asText,
  describeImage,
  displayDate,
  imageSize,
  imageValue,
  makeField,
  parseDate,
  rawField,
  requireDate,
  toIso,
} from '../core/fields';
import { MetadataError, type Edits, type Field, type FieldGroup, type FieldSpec, type FieldValue, type Sensitivity } from '../core/types';

export interface VorbisComment {
  key: string;
  value: string;
}

export interface VorbisComments {
  vendor: string;
  comments: VorbisComment[];
}

/** Parse a comment structure at `at` (little-endian lengths). Tolerates truncation. */
export function parseVorbisComment(b: Uint8Array, at = 0): { vc: VorbisComments; end: number; truncated: boolean } {
  const r = new Reader(b, true, at);
  const vc: VorbisComments = { vendor: '', comments: [] };
  try {
    vc.vendor = utf8OrLatin1(r.take(r.u32()));
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const s = utf8OrLatin1(r.take(r.u32()));
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      vc.comments.push({ key: s.slice(0, eq), value: s.slice(eq + 1) });
    }
  } catch {
    return { vc, end: r.pos, truncated: true };
  }
  return { vc, end: r.pos, truncated: false };
}

export function serializeVorbisComment(vc: VorbisComments): Uint8Array {
  const w = new Writer(true, 1024);
  const vendor = encodeUtf8(vc.vendor);
  w.u32(vendor.length).bytes(vendor).u32(vc.comments.length);
  for (const c of vc.comments) {
    const s = encodeUtf8(`${c.key}=${c.value}`);
    w.u32(s.length).bytes(s);
  }
  return w.finish();
}

// --------------------------------------------------------------- pictures

export interface FlacPicture {
  type: number;
  mime: string;
  description: string;
  width: number;
  height: number;
  depth: number;
  colors: number;
  data: Uint8Array;
}

export function parseFlacPicture(b: Uint8Array): FlacPicture {
  const r = new Reader(b);
  const type = r.u32();
  const mime = latin1(r.take(r.u32()));
  const description = utf8OrLatin1(r.take(r.u32()));
  const width = r.u32();
  const height = r.u32();
  const depth = r.u32();
  const colors = r.u32();
  const data = r.take(r.u32());
  return { type, mime, description, width, height, depth, colors, data };
}

export function serializeFlacPicture(p: FlacPicture): Uint8Array {
  const w = new Writer(false, p.data.length + 256);
  const mime = encodeUtf8(p.mime);
  const desc = encodeUtf8(p.description);
  w.u32(p.type).u32(mime.length).bytes(mime).u32(desc.length).bytes(desc);
  w.u32(p.width).u32(p.height).u32(p.depth).u32(p.colors).u32(p.data.length).bytes(p.data);
  return w.finish();
}

/** METADATA_BLOCK_PICTURE comment value -> picture (null if undecodable). */
export function pictureFromBase64(s: string): FlacPicture | null {
  try {
    return parseFlacPicture(base64Decode(s));
  } catch {
    return null;
  }
}

/** Move METADATA_BLOCK_PICTURE comments out of `vc` (Ogg). Undecodable ones stay as comments. */
export function extractPictures(vc: VorbisComments): FlacPicture[] {
  const pics: FlacPicture[] = [];
  vc.comments = vc.comments.filter((c) => {
    if (c.key.toUpperCase() !== 'METADATA_BLOCK_PICTURE') return true;
    const p = pictureFromBase64(c.value);
    if (p) pics.push(p);
    return !p;
  });
  return pics;
}

function pictureFromValue(v: FieldValue, old?: FlacPicture): FlacPicture {
  const img = asImage(v);
  const dims = img.width && img.height ? { width: img.width, height: img.height } : imageSize(img.data);
  return {
    type: img.pictureType ?? old?.type ?? 3,
    mime: img.mime || old?.mime || 'image/jpeg',
    description: img.description ?? old?.description ?? '',
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    depth: img.mime === 'image/png' || img.mime === 'image/jpeg' ? 24 : 0,
    colors: 0,
    data: img.data,
  };
}

/** Apply `vorbis:picture:*` edits; returns the new list (input untouched) and whether anything changed. */
export function applyPictureEdits(pics: FlacPicture[], edits: Edits): { pictures: FlacPicture[]; changed: boolean } {
  const slots: Array<FlacPicture | null> = [...pics];
  const added: FlacPicture[] = [];
  let changed = false;
  for (const [id, e] of edits) {
    const m = /^vorbis:picture:(\d+|new)$/.exec(id);
    if (!m) continue;
    if (m[1] === 'new') {
      if (e.op === 'set') {
        added.push(pictureFromValue(e.value));
        changed = true;
      }
      continue;
    }
    const i = +m[1];
    if (i >= slots.length || !slots[i]) continue;
    slots[i] = e.op === 'remove' ? null : pictureFromValue(e.value, pics[i]);
    changed = true;
  }
  return { pictures: [...slots.filter((p): p is FlacPicture => p !== null), ...added], changed };
}

// ----------------------------------------------------------------- fields

interface KeyDef {
  label: string;
  sens?: Sensitivity;
  addable?: boolean;
  multiline?: boolean;
  date?: boolean;
}

const K = (label: string, sens?: Sensitivity, extra: Partial<KeyDef> = {}): KeyDef => ({ label, sens, ...extra });

const KEYS: Record<string, KeyDef> = {
  TITLE: K('Title', 'content', { addable: true }),
  ARTIST: K('Artist', 'identity', { addable: true }),
  ALBUM: K('Album', 'content', { addable: true }),
  ALBUMARTIST: K('Album artist', 'identity', { addable: true }),
  'ALBUM ARTIST': K('Album artist', 'identity'),
  DATE: K('Date', 'time', { addable: true, date: true }),
  YEAR: K('Year', 'time'),
  ORIGINALDATE: K('Original date', 'time', { date: true }),
  ORIGINALYEAR: K('Original year', 'time'),
  GENRE: K('Genre', 'content', { addable: true }),
  TRACKNUMBER: K('Track', undefined, { addable: true }),
  TRACKTOTAL: K('Total tracks'),
  TOTALTRACKS: K('Total tracks'),
  DISCNUMBER: K('Disc', undefined, { addable: true }),
  DISCTOTAL: K('Total discs'),
  TOTALDISCS: K('Total discs'),
  COMMENT: K('Comment', 'content', { addable: true, multiline: true }),
  DESCRIPTION: K('Description', 'content', { addable: true, multiline: true }),
  LYRICS: K('Lyrics', 'content', { addable: true, multiline: true }),
  UNSYNCEDLYRICS: K('Lyrics', 'content', { multiline: true }),
  COMPOSER: K('Composer', 'identity', { addable: true }),
  PERFORMER: K('Performer', 'identity', { addable: true }),
  LYRICIST: K('Lyricist', 'identity'),
  CONDUCTOR: K('Conductor', 'identity'),
  ARRANGER: K('Arranger', 'identity'),
  REMIXER: K('Remixer', 'identity'),
  PRODUCER: K('Producer', 'identity'),
  ENGINEER: K('Engineer', 'identity'),
  MIXER: K('Mixer', 'identity'),
  COPYRIGHT: K('Copyright', 'identity', { addable: true }),
  LICENSE: K('License', 'content', { addable: true }),
  ORGANIZATION: K('Organization', 'identity', { addable: true }),
  LABEL: K('Label', 'identity'),
  PUBLISHER: K('Publisher', 'identity'),
  LOCATION: K('Location', 'location', { addable: true }),
  CONTACT: K('Contact', 'identity', { addable: true }),
  ISRC: K('ISRC', 'content', { addable: true }),
  ENCODER: K('Encoder', 'software'),
  ENCODER_OPTIONS: K('Encoder options', 'software'),
  ENCODERSETTINGS: K('Encoder settings', 'software'),
  ENCODING: K('Encoding', 'software'),
  'ENCODED-BY': K('Encoded by', 'identity', { addable: true }),
  ENCODEDBY: K('Encoded by', 'identity'),
  VERSION: K('Version', 'content'),
  GROUPING: K('Grouping', 'content'),
  MOOD: K('Mood', 'content'),
  BPM: K('BPM'),
  LANGUAGE: K('Language'),
  COMPILATION: K('Compilation'),
  RATING: K('Rating', 'content'),
  CATALOGNUMBER: K('Catalog number', 'content'),
  BARCODE: K('Barcode', 'content'),
  MEDIA: K('Media'),
  WEBSITE: K('Website', 'content'),
  URL: K('URL', 'content'),
};

const isPictureKey = (k: string) => k === 'METADATA_BLOCK_PICTURE' || k === 'COVERART';

function keySens(key: string): Sensitivity | undefined {
  const d = KEYS[key];
  if (d) return d.sens;
  if (/^(REPLAYGAIN_|R128_)/.test(key)) return undefined;
  return 'content';
}

export interface VorbisGroupOptions {
  /** "Vorbis comment", "Opus tags"… */
  source: string;
  addable?: boolean;
  /** Pictures can be stored (FLAC blocks / Ogg METADATA_BLOCK_PICTURE). */
  pictures?: boolean;
}

export function vorbisGroups(vc: VorbisComments | null, pictures: FlacPicture[], opts: VorbisGroupOptions): FieldGroup[] {
  const groups: FieldGroup[] = [];
  const byKey = new Map<string, VorbisComment[]>();
  for (const c of vc?.comments ?? []) {
    const k = c.key.toUpperCase();
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(c);
  }
  const fields: Field[] = [];
  for (const [key, cs] of byKey) {
    const id = `vorbis:${key}`;
    const def = KEYS[key];
    const label = def?.label ?? key;
    const base = { id, label, sensitivity: keySens(key), tag: cs[0].key };
    if (isPictureKey(key)) {
      const size = cs.reduce((n, c) => n + c.value.length, 0);
      fields.push(
        rawField(id, key === 'COVERART' ? 'Cover art (legacy)' : 'Picture (undecodable)', `${cs.length} × base64, ${formatBytes(size)}`, {
          sensitivity: 'content',
          tag: key,
        }),
      );
      continue;
    }
    const vals = cs.map((c) => c.value);
    if (vals.length > 1) {
      fields.push(makeField({ ...base, kind: 'list' }, vals));
      continue;
    }
    const v = vals[0];
    if (def?.date) {
      const p = parseDate(v);
      if (p) {
        fields.push(makeField({ ...base, kind: 'datetime' }, toIso(p), { display: displayDate(toIso(p)) }));
        continue;
      }
    }
    fields.push(makeField({ ...base, kind: def?.multiline || v.length > 80 || v.includes('\n') ? 'multiline' : 'text' }, v));
  }
  if (vc && vc.vendor) {
    fields.push(rawField('vorbis:vendor', 'Encoder library', vc.vendor, { sensitivity: 'software', tag: 'vendor string' }));
  }
  const addable: FieldSpec[] = [];
  if (opts.addable) {
    for (const [key, def] of Object.entries(KEYS)) {
      if (!def.addable || byKey.has(key)) continue;
      addable.push({
        id: `vorbis:${key}`,
        label: def.label,
        kind: def.date ? 'datetime' : def.multiline ? 'multiline' : 'text',
        sensitivity: def.sens,
        tag: key,
      });
    }
  }
  if (fields.length || addable.length) {
    groups.push({ id: 'vorbis', label: 'Tags', source: opts.source, fields, addable: addable.length ? addable : undefined, removable: !!vc });
  }
  if (opts.pictures && (pictures.length || opts.addable)) {
    const pf = pictures.map((p, i) => {
      const v = imageValue(p.data, p.mime, { description: p.description, pictureType: p.type });
      if (!v.width && p.width) {
        v.width = p.width;
        v.height = p.height;
      }
      const typeName = PICTURE_TYPES[p.type] ?? `Type ${p.type}`;
      return makeField(
        {
          id: `vorbis:picture:${i}`,
          label: p.description ? `${typeName} — ${p.description}` : typeName,
          kind: 'image',
          sensitivity: 'content',
          tag: 'PICTURE',
        },
        v,
        { display: describeImage(v) },
      );
    });
    groups.push({
      id: 'vorbis.pictures',
      label: 'Cover art',
      source: opts.source,
      fields: pf,
      addable: opts.addable ? [{ id: 'vorbis:picture:new', label: 'Picture', kind: 'image', sensitivity: 'content', tag: 'PICTURE' }] : undefined,
    });
  }
  return groups;
}

const VALID_KEY = /^[\x20-\x3c\x3e-\x7d]+$/;

function valuesFor(key: string, v: FieldValue): string[] {
  if (Array.isArray(v)) return asList(v);
  const s = asText(v, key);
  if (s === '') return [];
  if (KEYS[key]?.date) return [toIso(requireDate(s, KEYS[key].label))];
  return [s];
}

/** Has any comment (not picture) edit. */
export function hasVorbisEdits(edits: Edits): boolean {
  for (const k of edits.keys()) if (k.startsWith('vorbis:') && !k.startsWith('vorbis:picture:')) return true;
  return false;
}

/** Apply `vorbis:*` comment edits in place (pictures are handled by applyPictureEdits). */
export function applyVorbisEdits(vc: VorbisComments, edits: Edits): boolean {
  let changed = false;
  for (const [id, e] of edits) {
    if (!id.startsWith('vorbis:') || id.startsWith('vorbis:picture:')) continue;
    if (id === 'vorbis:vendor') {
      if (e.op === 'remove' && vc.vendor) {
        vc.vendor = '';
        changed = true;
      }
      continue;
    }
    const key = id.slice(7).toUpperCase();
    if (!VALID_KEY.test(key)) throw new MetadataError(`"${key}" is not a valid Vorbis comment name`);
    const values = e.op === 'remove' ? [] : valuesFor(key, e.value);
    const first = vc.comments.findIndex((c) => c.key.toUpperCase() === key);
    if (first < 0 && !values.length) continue;
    const spelled = first >= 0 ? vc.comments[first].key : key;
    const fresh = values.map((value) => ({ key: spelled, value }));
    const before = vc.comments.slice(0, Math.max(first, 0)).filter((c) => c.key.toUpperCase() !== key);
    const after = (first >= 0 ? vc.comments.slice(first) : []).filter((c) => c.key.toUpperCase() !== key);
    vc.comments = first >= 0 ? [...before, ...fresh, ...after] : [...vc.comments, ...fresh];
    changed = true;
  }
  return changed;
}
