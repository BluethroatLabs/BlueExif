/**
 * WAV (RIFF/WAVE, plus RF64/BW64): `fmt ` (info), `data` (payload, never
 * loaded), LIST/INFO text, `bext` (Broadcast Wave), `id3 `/`ID3 ` (ID3v2),
 * `_PMX` (XMP), `iXML`, `axml` and unknown chunks.
 *
 * Writing re-emits the chunks in their original order (data and other
 * untouched chunks via `src.slice()`), with correct sizes and odd-size padding.
 * For RF64/BW64 the ds64 RIFF size is updated. Strip keeps only the chunks
 * needed for playback (fmt, fact, data, cue, smpl, inst, acid, plst…).
 */

import { Reader, Writer, concat, encodeLatin1, encodeUtf8, formatBytes, latin1, startsWith, toBlob, utf8OrLatin1 } from '../core/binary';
import { asText, displayDate, formatDuration, makeField, parseDate, rawField, requireDate } from '../core/fields';
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
  type Sensitivity,
  type Source,
  type StripOptions,
} from '../core/types';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';
import { applyId3Edits, coverOnlyId3Bytes, hasId3Edits, id3Groups, parseId3v2, serializeId3v2, type Id3Tag } from './id3';

/** Chunks whose payload is read (everything else is copied by reference). */
const LOAD = new Set(['fmt ', 'fact', 'LIST', 'bext', 'iXML', '_PMX', 'axml', 'id3 ', 'ID3 ', 'ds64', 'cart', 'PEAK', 'DISP']);
/** Chunks needed for playback / editing workflows; kept by strip. */
const FUNCTIONAL = new Set(['fmt ', 'fact', 'data', 'cue ', 'smpl', 'inst', 'acid', 'plst', 'wavl', 'slnt', 'ds64', 'chna']);
const PADDING = new Set(['JUNK', 'junk', 'PAD ', 'FLLR', 'pad ']);
const MAX_META_CHUNK = 64 * 1024 * 1024;

interface Chunk {
  id: string;
  /** offset of the 8-byte header */
  offset: number;
  /** payload size (ds64 value for RF64 data) */
  size: number;
  /** payload bytes actually available (truncated files) */
  avail: number;
  data: Uint8Array | null;
  /** LIST form type */
  listType?: string;
  /** the writer left out the pad byte after this odd-sized chunk */
  unpadded?: boolean;
  /** the declared size was wrong and `size` was recovered: write a corrected header */
  resized?: boolean;
}

interface Riff {
  kind: 'RIFF' | 'RF64' | 'BW64';
  chunks: Chunk[];
  /** end of the RIFF body; bytes after it are trailing data */
  end: number;
  /** the chunk walk stopped at bytes that are not a chunk header */
  unreadable: boolean;
  warnings: string[];
}

const CHUNK_ID = /^[\x20-\x7e]{4}$/;

async function parseRiff(src: Source): Promise<Riff> {
  const head = await src.read(0, 12);
  const kind = latin1(head.subarray(0, 4));
  if ((kind !== 'RIFF' && kind !== 'RF64' && kind !== 'BW64') || !startsWith(head, 'WAVE', 8)) throw new MetadataError('Not a WAV file');
  const warnings: string[] = [];
  const declared = new Reader(head, true).u32(4);
  let end = kind === 'RIFF' ? 8 + declared : src.size;
  if (end > src.size) {
    if (kind === 'RIFF' && declared !== 0xffffffff) warnings.push('The RIFF size is larger than the file (truncated file?)');
    end = src.size;
  }
  const chunks: Chunk[] = [];
  let ds64Data = -1;
  let unreadable = false;
  const known = (id: string) => LOAD.has(id) || FUNCTIONAL.has(id) || PADDING.has(id);
  /** How much a chunk header at `at` looks real: 0 not an id, 1 printable id, 2 its size fits, 3 a known id that fits. */
  const score = (h: Uint8Array, at: number) => {
    const id = latin1(h.subarray(0, 4));
    if (!CHUNK_ID.test(id)) return 0;
    if (at + 8 + new Reader(h, true).u32(4) > end) return 1;
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
    // After the audio, anything but a whole chunk (or a known one cut short by truncation) means the
    // data size is wrong (0, or never updated, after an interrupted recording): the audio runs on.
    const whole = score(h, p) >= 2 || (CHUNK_ID.test(id) && known(id));
    if (prev?.id === 'data' && !whole) {
      prev.size = prev.avail = end - prev.offset - 8;
      prev.resized = true;
      warnings.push('The data chunk size is wrong; the audio was taken to run to the end of the file');
      p = end;
      break;
    }
    if (!CHUNK_ID.test(id)) {
      warnings.push(`Unreadable data at offset ${p} was ignored`);
      unreadable = true;
      break;
    }
    let size = new Reader(h, true).u32(4);
    if (id === 'data' && size === 0xffffffff && ds64Data >= 0) size = ds64Data;
    const avail = Math.max(0, Math.min(size, end - p - 8));
    if (avail < size) warnings.push(`The ${id.trim()} chunk is truncated`);
    let data: Uint8Array | null = null;
    if (LOAD.has(id)) {
      if (avail > MAX_META_CHUNK) throw new MetadataError(`The ${id.trim()} chunk is too large (${formatBytes(avail)})`);
      data = await src.read(p + 8, avail);
    }
    const c: Chunk = { id, offset: p, size, avail, data };
    if (id === 'LIST' && data && data.length >= 4) c.listType = latin1(data.subarray(0, 4));
    if (id === 'ds64' && data && data.length >= 16) ds64Data = new Reader(data, true).u64(8);
    chunks.push(c);
    p += 8 + size + (size & 1);
  }
  if (!chunks.some((c) => c.id === 'fmt ')) throw new MetadataError('WAV file has no fmt chunk');
  // An empty data chunk followed by bytes past the RIFF end: the recording stopped before
  // either size was written, so those bytes are the audio, not trailing metadata.
  const last = chunks[chunks.length - 1];
  if (last.id === 'data' && last.size === 0 && !unreadable && p < src.size) {
    last.size = last.avail = src.size - last.offset - 8;
    last.resized = true;
    warnings.push('The data chunk size is 0; the audio was taken to run to the end of the file');
    p = src.size;
  }
  return { kind: kind as Riff['kind'], chunks, end: Math.min(Math.max(p, 12), src.size), unreadable, warnings };
}

// ------------------------------------------------------------------ fmt

const FORMATS: Record<number, string> = {
  0x0001: 'PCM',
  0x0002: 'Microsoft ADPCM',
  0x0003: 'IEEE float',
  0x0006: 'A-law',
  0x0007: 'µ-law',
  0x0011: 'IMA ADPCM',
  0x0050: 'MPEG',
  0x0055: 'MP3',
  0x00ff: 'AAC',
  0x2000: 'AC-3',
};

function formatInfo(r: Riff): InfoItem[] {
  const fmt = r.chunks.find((c) => c.id === 'fmt ')?.data;
  if (!fmt || fmt.length < 16) return [];
  const f = new Reader(fmt, true);
  let tag = f.u16(0);
  const channels = f.u16(2);
  const rate = f.u32(4);
  const byteRate = f.u32(8);
  const bits = f.u16(14);
  if (tag === 0xfffe && fmt.length >= 26) tag = f.u16(24);
  const info: InfoItem[] = [
    { label: 'Format', value: `${FORMATS[tag] ?? `Format 0x${tag.toString(16).padStart(4, '0')}`}${bits && (tag === 1 || tag === 3) ? `, ${bits}-bit` : ''}` },
    { label: 'Channels', value: channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : String(channels) },
    { label: 'Sample rate', value: `${rate} Hz` },
  ];
  if (byteRate) info.push({ label: 'Bitrate', value: `${Math.round((byteRate * 8) / 1000)} kbps` });
  const data = r.chunks.find((c) => c.id === 'data');
  const fact = r.chunks.find((c) => c.id === 'fact')?.data;
  let secs = 0;
  if (tag !== 1 && tag !== 3 && fact && fact.length >= 4 && rate) secs = new Reader(fact, true).u32(0) / rate;
  else if (data && byteRate) secs = data.size / byteRate;
  if (secs > 0) info.push({ label: 'Duration', value: formatDuration(secs) });
  if (r.kind !== 'RIFF') info.push({ label: 'Container', value: r.kind });
  return info;
}

// ----------------------------------------------------------------- INFO

const I = (label: string, sens?: Sensitivity, addable = false) => ({ label, sens, addable });
const INFO: Record<string, { label: string; sens?: Sensitivity; addable: boolean }> = {
  INAM: I('Title', 'content', true),
  IART: I('Artist', 'identity', true),
  IPRD: I('Album', 'content', true),
  ICMT: I('Comment', 'content', true),
  ICRD: I('Date created', 'time', true),
  IGNR: I('Genre', 'content', true),
  ICOP: I('Copyright', 'identity', true),
  IENG: I('Engineer', 'identity', true),
  ITCH: I('Technician', 'identity'),
  ISFT: I('Software', 'software'),
  ISBJ: I('Subject', 'content', true),
  IKEY: I('Keywords', 'content', true),
  ITRK: I('Track', undefined, true),
  IPRT: I('Track'),
  ISRC: I('Source', 'identity'),
  ISRF: I('Source form', 'content'),
  ICMS: I('Commissioned by', 'identity'),
  IARL: I('Archival location', 'location'),
  ICNT: I('Country', 'location'),
  ILNG: I('Language'),
  IMED: I('Medium', 'content'),
  IWRI: I('Writer', 'identity'),
  IPRO: I('Producer', 'identity'),
  ICNM: I('Cinematographer', 'identity'),
  IEDT: I('Edited by', 'identity'),
  ISTR: I('Starring', 'identity'),
  IENC: I('Encoded by', 'identity'),
  IDIT: I('Digitization date', 'time'),
  ISGN: I('Secondary genre', 'content'),
  IRTD: I('Rating', 'content'),
  ICRP: I('Cropped'),
  IDIM: I('Dimensions'),
  IDPI: I('Dots per inch'),
  ILGT: I('Lightness'),
  IPLT: I('Palette'),
  ISHP: I('Sharpness'),
  ISMP: I('SMPTE time code'),
  TAPE: I('Tape name', 'content'),
  TCOD: I('Start time code'),
  TCDO: I('End time code'),
  TURL: I('URL', 'content'),
};

interface InfoItemRaw {
  id: string;
  value: string;
  /** non-text payload (e.g. ffmpeg's 4-byte IPRT) */
  raw?: Uint8Array;
}

function parseInfo(data: Uint8Array): InfoItemRaw[] {
  const out: InfoItemRaw[] = [];
  const r = new Reader(data, true);
  let p = 4;
  while (p + 8 <= data.length) {
    const id = latin1(data.subarray(p, p + 4));
    const size = r.u32(p + 4);
    const v = data.subarray(p + 8, Math.min(data.length, p + 8 + size));
    out.push({
      id,
      value: utf8OrLatin1(v)
        .replace(/\0[\s\S]*$/, '')
        .trimEnd(),
      raw: v,
    });
    p += 8 + size + (size & 1);
  }
  return out;
}

function serializeInfo(items: InfoItemRaw[]): Uint8Array {
  const w = new Writer(true, 256);
  w.ascii('INFO');
  for (const it of items) {
    const v =
      it.raw &&
      it.value ===
        utf8OrLatin1(it.raw)
          .replace(/\0[\s\S]*$/, '')
          .trimEnd()
        ? it.raw
        : concat([encodeUtf8(it.value), new Uint8Array([0])]);
    w.ascii(it.id).u32(v.length).bytes(v);
    if (v.length & 1) w.u8(0);
  }
  return w.finish();
}

function infoGroup(items: InfoItemRaw[] | null): FieldGroup {
  const present = new Set(items?.map((i) => i.id));
  const fields: Field[] = (items ?? []).map((it) => {
    const def = INFO[it.id];
    const s = { id: `wav:info:${it.id}`, label: def?.label ?? it.id, sensitivity: def ? def.sens : 'content', tag: it.id };
    return makeField({ ...s, kind: it.value.length > 80 || it.value.includes('\n') ? 'multiline' : 'text' }, it.value);
  });
  const addable: FieldSpec[] = Object.entries(INFO)
    .filter(([id, d]) => d.addable && !present.has(id))
    .map(([id, d]) => ({ id: `wav:info:${id}`, label: d.label, kind: id === 'ICMT' ? 'multiline' : 'text', sensitivity: d.sens, tag: id }));
  return { id: 'wav.info', label: 'RIFF INFO', source: 'RIFF INFO', fields, addable, removable: !!items };
}

function applyInfoEdits(items: InfoItemRaw[], edits: Edits): boolean {
  let changed = false;
  for (const [k, e] of edits) {
    if (!k.startsWith('wav:info:')) continue;
    const id = k.slice(9);
    if (!/^[\x20-\x7e]{4}$/.test(id)) continue;
    const v = e.op === 'remove' ? '' : asText(e.value, INFO[id]?.label ?? id);
    const idx = items.findIndex((i) => i.id === id);
    if (!v) {
      if (idx >= 0) {
        items.splice(idx, 1);
        changed = true;
      }
      continue;
    }
    if (idx >= 0) items[idx] = { id, value: v };
    else items.push({ id, value: v });
    changed = true;
  }
  return changed;
}

// ----------------------------------------------------------------- bext

const BEXT_FIXED = 602;
const BEXT_TEXT: Array<{ key: string; label: string; at: number; len: number; sens: Sensitivity }> = [
  { key: 'description', label: 'Description', at: 0, len: 256, sens: 'content' },
  { key: 'originator', label: 'Originator', at: 256, len: 32, sens: 'identity' },
  { key: 'originatorReference', label: 'Originator reference', at: 288, len: 32, sens: 'identity' },
];

const fixedStr = (b: Uint8Array, at: number, len: number) =>
  utf8OrLatin1(b.subarray(at, at + len))
    .replace(/\0[\s\S]*$/, '')
    .trimEnd();

/** UTF-8 bytes of `s`, cut to `max` bytes without splitting a character. */
function fitUtf8(s: string, max: number): Uint8Array {
  let b = encodeUtf8(s);
  while (b.length > max) {
    s = s.slice(0, -1);
    b = encodeUtf8(s);
  }
  return b;
}

function bextDate(b: Uint8Array): string | null {
  const d = fixedStr(b, 320, 10);
  const t = fixedStr(b, 330, 8);
  const dm = /^(\d{4})\D(\d{2})\D(\d{2})$/.exec(d);
  if (!dm) return null;
  const tm = /^(\d{2})\D(\d{2})\D(\d{2})$/.exec(t);
  return `${dm[1]}-${dm[2]}-${dm[3]}${tm ? `T${tm[1]}:${tm[2]}:${tm[3]}` : ''}`;
}

function bextGroup(b: Uint8Array): FieldGroup {
  const fields: Field[] = [];
  for (const t of BEXT_TEXT) {
    const v = fixedStr(b, t.at, t.len);
    if (v)
      fields.push(
        makeField({ id: `wav:bext:${t.key}`, label: t.label, kind: 'text', sensitivity: t.sens, tag: `bext ${t.label}`, placeholder: `max ${t.len} bytes` }, v),
      );
  }
  const date = bextDate(b);
  if (date && parseDate(date))
    fields.push(
      makeField({ id: 'wav:bext:origination', label: 'Origination date', kind: 'datetime', sensitivity: 'time', tag: 'bext OriginationDate/Time' }, date, {
        display: displayDate(date),
      }),
    );
  const r = new Reader(b, true);
  if (b.length >= 346) {
    const ref = r.u32(342) * 0x1_0000_0000 + r.u32(338);
    if (ref)
      fields.push(rawField('wav:bext:timeReference', 'Time reference', `${ref} samples after midnight`, { sensitivity: 'time', tag: 'bext TimeReference' }));
  }
  if (b.length >= 412 && b.subarray(348, 412).some((x) => x !== 0)) {
    fields.push(
      rawField('wav:bext:umid', 'UMID', 'Unique material identifier (may encode device, time and place)', { sensitivity: 'device', tag: 'bext UMID' }),
    );
  }
  const history =
    b.length > BEXT_FIXED
      ? utf8OrLatin1(b.subarray(BEXT_FIXED))
          .replace(/\0[\s\S]*$/, '')
          .trimEnd()
      : '';
  if (history)
    fields.push(
      makeField({ id: 'wav:bext:codingHistory', label: 'Coding history', kind: 'multiline', sensitivity: 'software', tag: 'bext CodingHistory' }, history),
    );
  const present = new Set(fields.map((f) => f.id));
  const specs: FieldSpec[] = [
    ...BEXT_TEXT.map((t): FieldSpec => ({ id: `wav:bext:${t.key}`, label: t.label, kind: 'text', sensitivity: t.sens })),
    { id: 'wav:bext:origination', label: 'Origination date', kind: 'datetime', sensitivity: 'time' },
    { id: 'wav:bext:codingHistory', label: 'Coding history', kind: 'multiline', sensitivity: 'software' },
  ];
  const addable = specs.filter((s) => !present.has(s.id));
  return { id: 'wav.bext', label: 'Broadcast Wave', source: 'BWF bext', fields, addable: addable.length ? addable : undefined, removable: true };
}

function applyBextEdits(src: Uint8Array, edits: Edits): Uint8Array | null {
  let b = src.length >= BEXT_FIXED ? src.slice() : concat([src, new Uint8Array(BEXT_FIXED - src.length)]);
  let changed = false;
  for (const [k, e] of edits) {
    if (!k.startsWith('wav:bext:')) continue;
    const key = k.slice(9);
    const t = BEXT_TEXT.find((x) => x.key === key);
    if (t) {
      b.fill(0, t.at, t.at + t.len);
      if (e.op === 'set') b.set(fitUtf8(asText(e.value, t.label), t.len), t.at);
      changed = true;
    } else if (key === 'origination') {
      b.fill(0, 320, 338);
      if (e.op === 'set' && asText(e.value, 'Origination date').trim()) {
        const p = requireDate(e.value, 'Origination date');
        const two = (n: number) => String(n).padStart(2, '0');
        b.set(encodeLatin1(`${String(p.year).padStart(4, '0')}-${two(p.month ?? 1)}-${two(p.day ?? 1)}`), 320);
        b.set(encodeLatin1(`${two(p.hour ?? 0)}:${two(p.minute ?? 0)}:${two(p.second ?? 0)}`), 330);
      }
      changed = true;
    } else if (key === 'timeReference' || key === 'umid') {
      if (e.op === 'remove') {
        if (key === 'timeReference') b.fill(0, 338, 346);
        else b.fill(0, 348, 412);
        changed = true;
      }
    } else if (key === 'codingHistory') {
      const text = e.op === 'set' ? asText(e.value, 'Coding history') : '';
      b = concat([b.subarray(0, BEXT_FIXED), text ? encodeUtf8(text.replace(/\r?\n/g, '\r\n')) : new Uint8Array(0)]);
      changed = true;
    }
  }
  return changed ? b : null;
}

// ---------------------------------------------------------------- reading

function xmpOf(c: Chunk | undefined): XmpPacket | null {
  if (!c?.data) return null;
  return parseXmp(utf8OrLatin1(c.data).replace(/\0+$/, ''));
}

function id3Of(c: Chunk | undefined): Id3Tag | null {
  if (!c?.data) return null;
  return parseId3v2(c.data);
}

const isInfo = (c: Chunk) => c.id === 'LIST' && c.listType === 'INFO';
const isId3 = (c: Chunk) => c.id === 'id3 ' || c.id === 'ID3 ';

function chunkLabel(c: Chunk): { label: string; sens?: Sensitivity } {
  switch (c.id) {
    case 'iXML':
      return { label: 'iXML production data', sens: 'content' };
    case 'axml':
      return { label: 'EBU Core XML (axml)', sens: 'content' };
    case 'cart':
      return { label: 'Broadcast cart chunk', sens: 'identity' };
    case 'PEAK':
      return { label: 'Peak envelope', sens: 'time' };
    case 'DISP':
      return { label: 'Display data', sens: 'content' };
    case 'LIST':
      return c.listType === 'adtl' ? { label: 'Cue point labels', sens: 'content' } : { label: `List “${c.listType ?? ''}”`, sens: 'content' };
    default:
      return { label: `Chunk “${c.id.trim()}”`, sens: 'content' };
  }
}

export async function readWav(src: Source): Promise<Metadata> {
  const r = await parseRiff(src);
  const warnings = [...r.warnings];
  const groups: FieldGroup[] = [];
  const info = r.chunks.find(isInfo);
  groups.push(infoGroup(info?.data ? parseInfo(info.data) : null));
  const bext = r.chunks.find((c) => c.id === 'bext');
  if (bext?.data) groups.push(bextGroup(bext.data));
  const id3c = r.chunks.find(isId3);
  if (id3c) {
    try {
      const tag = id3Of(id3c)!;
      warnings.push(...tag.warnings);
      groups.push(...id3Groups(tag, { addable: true }));
    } catch (e) {
      warnings.push(`ID3 chunk could not be read: ${(e as Error).message}`);
    }
  }
  const pmx = r.chunks.find((c) => c.id === '_PMX');
  if (pmx) {
    try {
      groups.push(...xmpGroups(xmpOf(pmx)!, { addable: true }));
    } catch (e) {
      warnings.push(`XMP could not be parsed: ${(e as Error).message}`);
    }
  }
  const other: Field[] = [];
  r.chunks.forEach((c, i) => {
    if (FUNCTIONAL.has(c.id) || PADDING.has(c.id) || c.id === 'bext' || c.id === '_PMX' || isId3(c) || c === info) return;
    const l = chunkLabel(c);
    other.push(rawField(`wav:chunk:${i}`, l.label, formatBytes(c.size), { sensitivity: l.sens, tag: c.id }));
  });
  if (r.end < src.size) {
    other.push(rawField('wav:trailer', 'Data after the RIFF chunk', formatBytes(src.size - r.end), { sensitivity: 'content', tag: 'Trailer' }));
  }
  if (other.length) groups.push({ id: 'wav.other', label: 'Other chunks', source: 'RIFF', fields: other, removable: true });
  return {
    format: { id: 'wav', name: 'WAV audio', mime: 'audio/wav', category: 'audio' },
    info: formatInfo(r),
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ---------------------------------------------------------------- writing

/** Per chunk index: undefined = copy, null = drop, bytes = new payload. */
type Replace = Map<number, Uint8Array | null>;

function assemble(src: Source, r: Riff, replace: Replace, added: Array<{ id: string; data: Uint8Array; before: string }>, keepTrailer: boolean): Blob {
  // Rewriting would keep only the chunks before the unreadable bytes, which may hold the audio.
  if (r.unreadable && !r.chunks.some((c) => c.id === 'data')) {
    throw new MetadataError('The audio data could not be located in this file, so it was left unchanged');
  }
  const parts: Array<Uint8Array | Blob> = [];
  let size = 4; // "WAVE"
  const push = (p: Uint8Array | Blob, n: number) => {
    parts.push(p);
    size += n;
  };
  const emit = (id: string, data: Uint8Array) => {
    const h = new Writer(true, 8);
    h.ascii(id).u32(data.length);
    push(h.finish(), 8);
    push(data, data.length);
    if (data.length & 1) push(new Uint8Array(1), 1);
  };
  const ds64Index = r.chunks.findIndex((c) => c.id === 'ds64');
  let ds64Part = -1;
  let dataSize = -1;
  r.chunks.forEach((c, i) => {
    for (const a of added) if (a.before === c.id) emit(a.id, a.data);
    const rep = replace.get(i);
    if (rep === null) return;
    if (rep) return emit(c.id, rep);
    if (i === ds64Index) {
      ds64Part = parts.length;
      return emit(c.id, c.data!.slice());
    }
    if (c.id === 'data') dataSize = c.avail;
    const full = 8 + c.size + (c.size & 1);
    if (c.avail === c.size && !c.resized) {
      // An unpadded chunk is followed directly by the next header: copy it without that byte.
      const have = Math.min(c.unpadded ? full - 1 : full, src.size - c.offset);
      push(src.slice(c.offset, c.offset + have), have);
      if (have < full) push(new Uint8Array(full - have), full - have); // missing pad byte
      return;
    }
    // Truncated or resized chunk: write the bytes that exist with a matching size.
    const h = new Writer(true, 8);
    h.ascii(c.id).u32(c.id === 'data' && r.kind !== 'RIFF' ? 0xffffffff : c.avail);
    push(h.finish(), 8);
    push(src.slice(c.offset + 8, c.offset + 8 + c.avail), c.avail);
    if (c.avail & 1) push(new Uint8Array(1), 1);
  });
  for (const a of added) if (!r.chunks.some((c) => c.id === a.before)) emit(a.id, a.data);
  if (keepTrailer && r.end < src.size) parts.push(src.slice(r.end));
  const head = new Writer(true, 12);
  if (r.kind === 'RIFF') {
    if (size > 0xffffffff) throw new MetadataError('The file would exceed the 4 GB RIFF limit');
    head.ascii('RIFF').u32(size).ascii('WAVE');
  } else {
    head.ascii(r.kind).u32(0xffffffff).ascii('WAVE');
    if (ds64Part >= 0) {
      const d = parts[ds64Part + 1] as Uint8Array;
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      v.setUint32(0, size % 0x1_0000_0000, true);
      v.setUint32(4, Math.floor(size / 0x1_0000_0000), true);
      if (dataSize >= 0 && d.byteLength >= 16) {
        v.setUint32(8, dataSize % 0x1_0000_0000, true);
        v.setUint32(12, Math.floor(dataSize / 0x1_0000_0000), true);
      }
    }
  }
  return toBlob([head.finish(), ...parts], 'audio/wav');
}

export async function writeWav(src: Source, edits: Edits): Promise<Blob> {
  const r = await parseRiff(src);
  const replace: Replace = new Map();
  const added: Array<{ id: string; data: Uint8Array; before: string }> = [];
  const idx = (pred: (c: Chunk) => boolean) => r.chunks.findIndex(pred);

  // LIST/INFO
  const ii = idx(isInfo);
  if (edits.get(groupKey('wav.info'))?.op === 'remove') {
    if (ii >= 0) replace.set(ii, null);
  } else if ([...edits.keys()].some((k) => k.startsWith('wav:info:'))) {
    const items = ii >= 0 ? parseInfo(r.chunks[ii].data!) : [];
    if (applyInfoEdits(items, edits)) {
      const data = items.length ? serializeInfo(items) : null;
      if (ii >= 0) replace.set(ii, data);
      else if (data) added.push({ id: 'LIST', data, before: 'data' });
    }
  }
  // bext
  const bi = idx((c) => c.id === 'bext');
  if (bi >= 0) {
    if (edits.get(groupKey('wav.bext'))?.op === 'remove') replace.set(bi, null);
    else {
      const b = applyBextEdits(r.chunks[bi].data!, edits);
      if (b) replace.set(bi, b);
    }
  }
  // ID3
  const di = idx(isId3);
  if (di >= 0) {
    if (edits.get(groupKey('id3'))?.op === 'remove') replace.set(di, null);
    else if (hasId3Edits(edits)) {
      const tag = id3Of(r.chunks[di])!;
      applyId3Edits(tag, edits);
      replace.set(di, tag.frames.length ? serializeId3v2(tag) : null);
    }
  }
  // XMP
  const xi = idx((c) => c.id === '_PMX');
  if (xi >= 0) {
    if (edits.get(groupKey('xmp'))?.op === 'remove') replace.set(xi, null);
    else if ([...edits.keys()].some((k) => k.startsWith('xmp:'))) {
      const p = xmpOf(r.chunks[xi])!;
      applyXmpEdits(p, edits);
      replace.set(xi, p.props.length ? encodeUtf8(serializeXmp(p, { padding: 0 })) : null);
    }
  }
  // Other chunks
  const dropOther = edits.get(groupKey('wav.other'))?.op === 'remove';
  r.chunks.forEach((c, i) => {
    if (dropOther && !FUNCTIONAL.has(c.id) && !PADDING.has(c.id) && c.id !== 'bext' && c.id !== '_PMX' && !isId3(c) && !isInfo(c)) replace.set(i, null);
    if (edits.get(`wav:chunk:${i}`)?.op === 'remove') replace.set(i, null);
  });
  const keepTrailer = !dropOther && edits.get('wav:trailer')?.op !== 'remove';
  return assemble(src, r, replace, added, keepTrailer);
}

export async function stripWav(src: Source, opts: StripOptions): Promise<Blob> {
  const r = await parseRiff(src);
  const replace: Replace = new Map();
  r.chunks.forEach((c, i) => {
    if (FUNCTIONAL.has(c.id)) return;
    if (isId3(c) && opts.keepCoverArt) {
      replace.set(i, coverOnlyId3Bytes(c.data));
      return;
    }
    replace.set(i, null);
  });
  return assemble(src, r, replace, [], false);
}

export const wavHandler: FormatHandler = {
  id: 'wav',
  name: 'WAV audio',
  category: 'audio',
  extensions: ['wav', 'wave', 'bwf', 'rf64'],
  mime: 'audio/wav',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if ((startsWith(h, 'RIFF') || startsWith(h, 'RF64') || startsWith(h, 'BW64')) && startsWith(h, 'WAVE', 8)) return 3;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readWav,
  write: writeWav,
  strip: stripWav,
};

/** For tests: the raw `data` chunk payload. */
export async function wavData(src: Source): Promise<Uint8Array> {
  const r = await parseRiff(src);
  const d = r.chunks.find((c) => c.id === 'data');
  if (!d) throw new MetadataError('no data chunk');
  return src.read(d.offset + 8, d.avail);
}
