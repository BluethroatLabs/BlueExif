/**
 * AIFF / AIFF-C (big-endian IFF `FORM`): COMM (info), SSND (payload, never
 * loaded), text chunks NAME / AUTH / "(c) " / ANNO, COMT (timestamped
 * comments), `ID3 ` (ID3v2), APPL and unknown chunks.
 *
 * Writing re-emits the chunks in order (untouched ones via `src.slice()`);
 * new text chunks go before SSND. Strip keeps COMM, SSND, FVER, MARK, INST,
 * MIDI, AESD and CHAN.
 */

import { Reader, Writer, encodeUtf8, formatBytes, latin1, startsWith, toBlob, utf8OrLatin1 } from '../core/binary';
import { asText, displayDate, formatDuration, makeField, rawField } from '../core/fields';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldSpec,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Source,
  type StripOptions,
} from '../core/types';
import { applyId3Edits, coverOnlyId3Bytes, hasId3Edits, id3Groups, parseId3v2, serializeId3v2, type Id3Tag } from './id3';

const LOAD = new Set(['COMM', 'NAME', 'AUTH', '(c) ', 'ANNO', 'COMT', 'ID3 ', 'id3 ', 'APPL', 'FVER']);
const FUNCTIONAL = new Set(['COMM', 'SSND', 'FVER', 'MARK', 'INST', 'MIDI', 'AESD', 'CHAN']);
const TEXT: Record<string, { key: string; label: string; sens: 'content' | 'identity' }> = {
  NAME: { key: 'NAME', label: 'Name', sens: 'content' },
  AUTH: { key: 'AUTH', label: 'Author', sens: 'identity' },
  '(c) ': { key: 'COPY', label: 'Copyright', sens: 'identity' },
};
const MAX_META_CHUNK = 64 * 1024 * 1024;
/** Seconds between 1904-01-01 (Mac epoch) and 1970-01-01. */
const MAC_EPOCH = 2082844800;

interface Chunk {
  id: string;
  offset: number;
  size: number;
  avail: number;
  data: Uint8Array | null;
  /** the writer left out the pad byte after this odd-sized chunk */
  unpadded?: boolean;
  /** the declared size was wrong and `size` was recovered: write a corrected header */
  resized?: boolean;
}

interface Aiff {
  aifc: boolean;
  chunks: Chunk[];
  end: number;
  /** the chunk walk stopped at bytes that are not a chunk header */
  unreadable: boolean;
  warnings: string[];
}

const CHUNK_ID = /^[\x20-\x7e]{4}$/;

async function parseAiff(src: Source): Promise<Aiff> {
  const head = await src.read(0, 12);
  const form = latin1(head.subarray(8, 12));
  if (!startsWith(head, 'FORM') || (form !== 'AIFF' && form !== 'AIFC')) throw new MetadataError('Not an AIFF file');
  const warnings: string[] = [];
  let end = 8 + new Reader(head).u32(4);
  if (end > src.size) {
    warnings.push('The FORM size is larger than the file (truncated file?)');
    end = src.size;
  }
  const chunks: Chunk[] = [];
  let unreadable = false;
  const known = (id: string) => LOAD.has(id) || FUNCTIONAL.has(id);
  /** How much a chunk header at `at` looks real: 0 not an id, 1 printable id, 2 its size fits, 3 a known id that fits. */
  const score = (h: Uint8Array, at: number) => {
    const id = latin1(h.subarray(0, 4));
    if (!CHUNK_ID.test(id)) return 0;
    if (at + 8 + new Reader(h).u32(4) > end) return 1;
    return known(id) ? 3 : 2;
  };
  let p = 12;
  while (p + 8 <= end) {
    let h = await src.read(p, 8);
    const prev = chunks[chunks.length - 1];
    // Some writers leave out the pad byte after an odd-sized chunk. (A real pad byte is 0, so
    // in a padded file the header one byte earlier never looks like a chunk.)
    if (prev && prev.size & 1) {
      const h1 = await src.read(p - 1, 8);
      if (score(h1, p - 1) > score(h, p)) {
        prev.unpadded = true;
        h = h1;
        p--;
      }
    }
    const id = latin1(h.subarray(0, 4));
    // After the sound data, anything but a whole chunk (or a known one cut short by truncation)
    // means the SSND size is wrong (e.g. after an interrupted recording): the audio runs on.
    const whole = score(h, p) >= 2 || (CHUNK_ID.test(id) && known(id));
    if (prev?.id === 'SSND' && !whole) {
      prev.size = prev.avail = end - prev.offset - 8;
      prev.resized = true;
      warnings.push('The SSND chunk size is wrong; the audio was taken to run to the end of the file');
      p = end;
      break;
    }
    if (!CHUNK_ID.test(id)) {
      warnings.push(`Unreadable data at offset ${p} was ignored`);
      unreadable = true;
      break;
    }
    const size = new Reader(h).u32(4);
    const avail = Math.max(0, Math.min(size, end - p - 8));
    if (avail < size) warnings.push(`The ${id.trim()} chunk is truncated`);
    let data: Uint8Array | null = null;
    if (LOAD.has(id)) {
      if (avail > MAX_META_CHUNK) throw new MetadataError(`The ${id.trim()} chunk is too large`);
      data = await src.read(p + 8, avail);
    }
    chunks.push({ id, offset: p, size, avail, data });
    p += 8 + size + (size & 1);
  }
  if (!chunks.some((c) => c.id === 'COMM')) throw new MetadataError('AIFF file has no COMM chunk');
  // An SSND chunk holding only its 8-byte header, followed by bytes past the FORM end: the
  // recording stopped before either size was written, so those bytes are the audio.
  const last = chunks[chunks.length - 1];
  if (last.id === 'SSND' && last.size <= 8 && !unreadable && p < src.size) {
    last.size = last.avail = src.size - last.offset - 8;
    last.resized = true;
    warnings.push('The SSND chunk is empty; the audio was taken to run to the end of the file');
    p = src.size;
  }
  return { aifc: form === 'AIFC', chunks, end: Math.min(p, src.size), unreadable, warnings };
}

/** 80-bit IEEE 754 extended precision (big-endian). */
function extended(b: Uint8Array, at: number): number {
  const r = new Reader(b);
  const se = r.u16(at);
  const hi = r.u32(at + 2);
  const lo = r.u32(at + 6);
  const exp = (se & 0x7fff) - 16383 - 63;
  const v = (hi * 0x1_0000_0000 + lo) * 2 ** exp;
  return se & 0x8000 ? -v : v;
}

function formatInfo(a: Aiff): InfoItem[] {
  const c = a.chunks.find((x) => x.id === 'COMM')?.data;
  if (!c || c.length < 18) return [];
  const r = new Reader(c);
  const channels = r.u16(0);
  const frames = r.u32(2);
  const bits = r.u16(6);
  const rate = extended(c, 8);
  let format = a.aifc ? 'AIFF-C' : 'AIFF';
  if (a.aifc && c.length >= 22) {
    const type = latin1(c.subarray(18, 22));
    const name = c.length > 22 ? latin1(c.subarray(23, 23 + c[22])) : '';
    format += ` (${name || type.trim()})`;
  }
  const info: InfoItem[] = [
    { label: 'Format', value: `${format}, ${bits}-bit` },
    { label: 'Channels', value: channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : String(channels) },
    { label: 'Sample rate', value: `${Math.round(rate)} Hz` },
  ];
  if (rate > 0 && frames) info.push({ label: 'Duration', value: formatDuration(frames / rate) });
  return info;
}

// ------------------------------------------------------------------ COMT

interface Comment {
  time: number;
  marker: number;
  text: string;
}

function parseComt(d: Uint8Array): Comment[] {
  const r = new Reader(d);
  const out: Comment[] = [];
  try {
    const n = r.u16();
    for (let i = 0; i < n; i++) {
      const time = r.u32();
      const marker = r.i16();
      const len = r.u16();
      out.push({ time, marker, text: utf8OrLatin1(r.take(len)) });
      if (len & 1) r.skip(Math.min(1, r.remaining));
    }
  } catch {
    /* truncated */
  }
  return out;
}

function serializeComt(cs: Comment[]): Uint8Array {
  const w = new Writer(false, 256);
  w.u16(cs.length);
  for (const c of cs) {
    const t = encodeUtf8(c.text);
    w.u32(c.time)
      .u16(c.marker & 0xffff)
      .u16(t.length)
      .bytes(t);
    if (t.length & 1) w.u8(0);
  }
  return w.finish();
}

function macTime(t: number): string {
  const d = new Date((t - MAC_EPOCH) * 1000);
  return d.toISOString().slice(0, 19);
}

// ------------------------------------------------------------------ read

const isId3 = (c: Chunk) => c.id === 'ID3 ' || c.id === 'id3 ';
const text = (c: Chunk) => utf8OrLatin1(c.data ?? new Uint8Array(0)).replace(/\0+$/, '');

function textGroup(a: Aiff): FieldGroup {
  const fields: Field[] = [];
  const present = new Set<string>();
  let anno = 0;
  let comt = 0;
  for (const c of a.chunks) {
    const t = TEXT[c.id];
    if (t && !present.has(t.key)) {
      present.add(t.key);
      fields.push(makeField({ id: `aiff:${t.key}`, label: t.label, kind: 'text', sensitivity: t.sens, tag: c.id }, text(c)));
    } else if (c.id === 'ANNO') {
      fields.push(makeField({ id: `aiff:ANNO:${anno++}`, label: 'Annotation', kind: 'multiline', sensitivity: 'content', tag: 'ANNO' }, text(c)));
    } else if (c.id === 'COMT' && c.data) {
      for (const cm of parseComt(c.data)) {
        const when = cm.time ? macTime(cm.time) : '';
        fields.push(
          makeField({ id: `aiff:COMT:${comt++}`, label: 'Comment', kind: 'multiline', sensitivity: 'content', tag: 'COMT' }, cm.text, {
            display: when ? `${cm.text} (${displayDate(when)})` : undefined,
          }),
        );
      }
    }
  }
  const addable: FieldSpec[] = Object.entries(TEXT)
    .filter(([, t]) => !present.has(t.key))
    .map(([id, t]) => ({ id: `aiff:${t.key}`, label: t.label, kind: 'text', sensitivity: t.sens, tag: id }));
  addable.push({ id: 'aiff:ANNO:new', label: 'Annotation', kind: 'multiline', sensitivity: 'content', tag: 'ANNO' });
  const removable = fields.length > 0;
  return { id: 'aiff.text', label: 'AIFF text', source: 'AIFF', fields, addable, removable };
}

export async function readAiff(src: Source): Promise<Metadata> {
  const a = await parseAiff(src);
  const warnings = [...a.warnings];
  const groups: FieldGroup[] = [textGroup(a)];
  const id3c = a.chunks.find(isId3);
  if (id3c?.data) {
    try {
      const tag = parseId3v2(id3c.data);
      warnings.push(...tag.warnings);
      groups.push(...id3Groups(tag, { addable: true }));
    } catch (e) {
      warnings.push(`ID3 chunk could not be read: ${(e as Error).message}`);
    }
  }
  const other: Field[] = [];
  a.chunks.forEach((c, i) => {
    if (FUNCTIONAL.has(c.id) || TEXT[c.id] || c.id === 'ANNO' || c.id === 'COMT' || isId3(c)) return;
    if (c.id === 'APPL') {
      const sig = latin1((c.data ?? new Uint8Array(0)).subarray(0, 4));
      other.push(rawField(`aiff:chunk:${i}`, `Application data (${sig})`, formatBytes(c.size), { sensitivity: 'software', tag: 'APPL' }));
    } else other.push(rawField(`aiff:chunk:${i}`, `Chunk “${c.id.trim()}”`, formatBytes(c.size), { sensitivity: 'content', tag: c.id }));
  });
  if (a.end < src.size)
    other.push(rawField('aiff:trailer', 'Data after the FORM chunk', formatBytes(src.size - a.end), { sensitivity: 'content', tag: 'Trailer' }));
  if (other.length) groups.push({ id: 'aiff.other', label: 'Other chunks', source: 'AIFF', fields: other, removable: true });
  return {
    format: { id: 'aiff', name: a.aifc ? 'AIFF-C audio' : 'AIFF audio', mime: 'audio/aiff', category: 'audio' },
    info: formatInfo(a),
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ----------------------------------------------------------------- write

type Replace = Map<number, Uint8Array | null>;

function assemble(src: Source, a: Aiff, replace: Replace, added: Array<{ id: string; data: Uint8Array }>, keepTrailer: boolean): Blob {
  // Rewriting would keep only the chunks before the unreadable bytes, which may hold the audio.
  if (a.unreadable && !a.chunks.some((c) => c.id === 'SSND')) {
    throw new MetadataError('The audio data could not be located in this file, so it was left unchanged');
  }
  const parts: Array<Uint8Array | Blob> = [];
  let size = 4;
  const push = (p: Uint8Array | Blob, n: number) => {
    parts.push(p);
    size += n;
  };
  const emit = (id: string, data: Uint8Array) => {
    const h = new Writer(false, 8);
    h.ascii(id).u32(data.length);
    push(h.finish(), 8);
    push(data, data.length);
    if (data.length & 1) push(new Uint8Array(1), 1);
  };
  let addedDone = false;
  const flushAdded = () => {
    if (!addedDone) for (const x of added) emit(x.id, x.data);
    addedDone = true;
  };
  a.chunks.forEach((c, i) => {
    if (c.id === 'SSND') flushAdded();
    const rep = replace.get(i);
    if (rep === null) return;
    if (rep) return emit(c.id, rep);
    const full = 8 + c.size + (c.size & 1);
    if (c.avail === c.size && !c.resized) {
      // An unpadded chunk is followed directly by the next header: copy it without that byte.
      const have = Math.min(c.unpadded ? full - 1 : full, src.size - c.offset);
      push(src.slice(c.offset, c.offset + have), have);
      if (have < full) push(new Uint8Array(full - have), full - have);
      return;
    }
    const h = new Writer(false, 8);
    h.ascii(c.id).u32(c.avail);
    push(h.finish(), 8);
    push(src.slice(c.offset + 8, c.offset + 8 + c.avail), c.avail);
    if (c.avail & 1) push(new Uint8Array(1), 1);
  });
  flushAdded();
  if (keepTrailer && a.end < src.size) parts.push(src.slice(a.end));
  if (size > 0xffffffff) throw new MetadataError('The file would exceed the 4 GB AIFF limit');
  const head = new Writer(false, 12);
  head
    .ascii('FORM')
    .u32(size)
    .ascii(a.aifc ? 'AIFC' : 'AIFF');
  return toBlob([head.finish(), ...parts], 'audio/aiff');
}

export async function writeAiff(src: Source, edits: Edits): Promise<Blob> {
  const a = await parseAiff(src);
  const replace: Replace = new Map();
  const added: Array<{ id: string; data: Uint8Array }> = [];
  const textRemoved = edits.get(groupKey('aiff.text'))?.op === 'remove';

  // NAME / AUTH / (c)
  for (const [id, t] of Object.entries(TEXT)) {
    const idxs = a.chunks.flatMap((c, i) => (c.id === id ? [i] : []));
    const e = edits.get(`aiff:${t.key}`);
    if (textRemoved) idxs.forEach((i) => replace.set(i, null));
    if (!e || textRemoved) continue;
    const v = e.op === 'remove' ? '' : asText(e.value, t.label);
    idxs.forEach((i, k) => replace.set(i, k === 0 && v ? encodeUtf8(v) : null));
    if (!idxs.length && v) added.push({ id, data: encodeUtf8(v) });
  }
  // ANNO
  let anno = 0;
  a.chunks.forEach((c, i) => {
    if (c.id !== 'ANNO') return;
    const e = edits.get(`aiff:ANNO:${anno++}`);
    if (textRemoved) replace.set(i, null);
    else if (e) {
      const v = e.op === 'remove' ? '' : asText(e.value, 'Annotation');
      replace.set(i, v ? encodeUtf8(v) : null);
    }
  });
  const newAnno = edits.get('aiff:ANNO:new');
  if (!textRemoved && newAnno?.op === 'set') {
    const v = asText(newAnno.value, 'Annotation');
    if (v) added.push({ id: 'ANNO', data: encodeUtf8(v) });
  }
  // COMT
  let comt = 0;
  a.chunks.forEach((c, i) => {
    if (c.id !== 'COMT' || !c.data) return;
    if (textRemoved) return replace.set(i, null);
    const cs = parseComt(c.data);
    let changed = false;
    const next: Comment[] = [];
    for (const cm of cs) {
      const e = edits.get(`aiff:COMT:${comt++}`);
      if (!e) next.push(cm);
      else {
        changed = true;
        const v = e.op === 'remove' ? '' : asText(e.value, 'Comment');
        if (v) next.push({ ...cm, text: v });
      }
    }
    if (changed) replace.set(i, next.length ? serializeComt(next) : null);
  });
  // ID3
  const di = a.chunks.findIndex(isId3);
  if (di >= 0) {
    if (edits.get(groupKey('id3'))?.op === 'remove') replace.set(di, null);
    else if (hasId3Edits(edits)) {
      const tag: Id3Tag = parseId3v2(a.chunks[di].data!);
      applyId3Edits(tag, edits);
      replace.set(di, tag.frames.length ? serializeId3v2(tag) : null);
    }
  }
  // Other chunks
  const dropOther = edits.get(groupKey('aiff.other'))?.op === 'remove';
  a.chunks.forEach((c, i) => {
    const shown = !FUNCTIONAL.has(c.id) && !TEXT[c.id] && c.id !== 'ANNO' && c.id !== 'COMT' && !isId3(c);
    if ((dropOther && shown) || edits.get(`aiff:chunk:${i}`)?.op === 'remove') replace.set(i, null);
  });
  return assemble(src, a, replace, added, !dropOther && edits.get('aiff:trailer')?.op !== 'remove');
}

export async function stripAiff(src: Source, opts: StripOptions): Promise<Blob> {
  const a = await parseAiff(src);
  const replace: Replace = new Map();
  a.chunks.forEach((c, i) => {
    if (FUNCTIONAL.has(c.id)) return;
    if (isId3(c) && opts.keepCoverArt) {
      replace.set(i, coverOnlyId3Bytes(c.data));
      return;
    }
    replace.set(i, null);
  });
  return assemble(src, a, replace, [], false);
}

export const aiffHandler: FormatHandler = {
  id: 'aiff',
  name: 'AIFF audio',
  category: 'audio',
  extensions: ['aif', 'aiff', 'aifc', 'afc'],
  mime: 'audio/aiff',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if (startsWith(h, 'FORM') && (startsWith(h, 'AIFF', 8) || startsWith(h, 'AIFC', 8))) return 3;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readAiff,
  write: writeAiff,
  strip: stripAiff,
};

/** For tests: the SSND chunk payload. */
export async function aiffSound(src: Source): Promise<Uint8Array> {
  const a = await parseAiff(src);
  const s = a.chunks.find((c) => c.id === 'SSND');
  if (!s) throw new MetadataError('no SSND chunk');
  return src.read(s.offset + 8, s.avail);
}
