/**
 * AVI (RIFF 'AVI ' + OpenDML 'AVIX' parts): stream headers, RIFF INFO list,
 * IDIT camera date, 'strd' vendor stream data, 'strn' stream names, unknown
 * vendor chunks (_PMX XMP, Nikon ncdt …).
 *
 * The 'movi' list never moves: idx1 may hold absolute offsets and OpenDML
 * indexes always do. Edits happen in place — the INFO list is rewritten in its
 * old slot plus adjacent JUNK, or (when it no longer fits) inserted right after
 * 'movi' in the first RIFF provided no AVIX part follows. Removed chunks become
 * zero-filled JUNK of identical size, so every other offset stays valid.
 */

import { Reader, Writer, encodeLatin1, encodeUtf8, formatBytes, latin1, startsWith, toBlob, utf8OrLatin1 } from '../core/binary';
import { asText, displayDate, formatDuration, makeField, parseDate, rawField, requireDate, spec, toIso, type DateParts } from '../core/fields';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldKind,
  type FieldSpec,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Sensitivity,
  type Source,
  type StripOptions,
} from '../core/types';

/** Chunks larger than this are never loaded into memory. */
const MAX_LOAD = 16 << 20;
/** Lists nested deeper than this (real files use 3) are kept as opaque data: parsing recurses. */
const MAX_LIST_DEPTH = 16;

interface Chunk {
  /** fourcc; 'LIST' / 'RIFF' for lists */
  id: string;
  /** list type for LIST / RIFF chunks, '' otherwise */
  type: string;
  /** absolute offset of the chunk header */
  pos: number;
  /** declared payload size */
  size: number;
  /** absolute end including the pad byte (clamped to the parent) */
  end: number;
  /** payload, when loaded */
  data: Uint8Array | null;
  children: Chunk[];
}

interface Avi {
  /** file-level RIFF chunks; the first is 'AVI ', the rest 'AVIX' */
  riffs: Chunk[];
  /** children of the first RIFF */
  top: Chunk[];
  /** offset of data after the last RIFF */
  trailer: number;
  size: number;
  /** truncated or unreadable structure: only in-place patches are safe */
  damaged: boolean;
  warnings: string[];
}

const isList = (id: string) => id === 'LIST' || id === 'RIFF';

/** Parse chunks of an in-memory buffer (offsets made absolute with `base`). */
function parseMem(b: Uint8Array, start: number, end: number, base: number, depth = 1): Chunk[] {
  const out: Chunk[] = [];
  const r = new Reader(b, true);
  let p = start;
  while (p + 8 <= end) {
    const id = r.fourcc(p);
    const size = r.u32(p + 4);
    const stop = Math.min(end, p + 8 + size);
    const c: Chunk = { id, type: '', pos: base + p, size, end: base + Math.min(end, p + 8 + size + (size & 1)), data: b.subarray(p + 8, stop), children: [] };
    if (isList(id) && size >= 4) {
      c.type = r.fourcc(p + 8);
      if (depth < MAX_LIST_DEPTH) c.children = parseMem(b, p + 12, stop, base, depth + 1);
    }
    out.push(c);
    p += 8 + size + (size & 1);
  }
  return out;
}

/** Walk chunk headers between `start` and `end`, loading small non-media chunks. */
async function walk(src: Source, start: number, end: number, avi: Pick<Avi, 'warnings' | 'damaged'>): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let p = start;
  while (p + 8 <= end) {
    const h = await src.read(p, 12);
    const r = new Reader(h, true);
    const id = r.fourcc(0);
    const size = r.u32(4);
    if (!/^[\x20-\x7e]{4}$/.test(id)) {
      avi.warnings.push(`Unreadable data at offset ${p}; the rest of the file was skipped.`);
      avi.damaged = true;
      break;
    }
    let stop = p + 8 + size;
    if (stop > end) {
      avi.warnings.push(`Chunk “${id.trim()}” at offset ${p} extends past the end of the file.`);
      avi.damaged = true;
      stop = end;
    }
    const c: Chunk = {
      id,
      type: isList(id) && h.length >= 12 ? r.fourcc(8) : '',
      pos: p,
      size,
      end: Math.min(end, stop + (size & 1)),
      data: null,
      children: [],
    };
    const media = c.type === 'movi' || id === 'idx1';
    if (!media && stop - p - 8 <= MAX_LOAD) {
      c.data = await src.read(p + 8, stop - p - 8);
      if (c.type) c.children = parseMem(c.data, 4, c.data.length, p + 8);
    }
    out.push(c);
    p = c.end;
  }
  return out;
}

async function parseAvi(src: Source): Promise<Avi> {
  const head = await src.read(0, 12);
  if (!startsWith(head, 'RIFF') || !startsWith(head, 'AVI ', 8)) throw new MetadataError('Not an AVI file');
  const state = { warnings: [] as string[], damaged: false };
  const riffs: Chunk[] = [];
  let top: Chunk[] = [];
  let p = 0;
  while (p + 12 <= src.size) {
    const h = await src.read(p, 12);
    if (!startsWith(h, 'RIFF')) break;
    const r = new Reader(h, true);
    const size = r.u32(4);
    let end = p + 8 + size;
    if (end > src.size) {
      state.warnings.push('The file appears to be truncated.');
      state.damaged = true;
      end = src.size;
    }
    const riff: Chunk = { id: 'RIFF', type: r.fourcc(8), pos: p, size, end: Math.min(src.size, end + (size & 1)), data: null, children: [] };
    riff.children = await walk(src, p + 12, end, state);
    if (!riffs.length && end < src.size && !riff.children.some((c) => c.type === 'movi')) {
      // Stale RIFF size (interrupted recording): the media follows the declared end.
      state.warnings.push('The RIFF size field is wrong (interrupted recording?).');
      state.damaged = true;
      riff.end = src.size;
      riff.children = await walk(src, p + 12, src.size, state);
    }
    if (!riffs.length) top = riff.children;
    riffs.push(riff);
    p = riff.end;
  }
  const warnings = [...new Set(state.warnings)];
  return { riffs, top, trailer: p, size: src.size, damaged: state.damaged, warnings };
}

const listOf = (cs: Chunk[], type: string) => cs.find((c) => c.id === 'LIST' && c.type === type);
const chunkOf = (cs: Chunk[], id: string) => cs.find((c) => c.id === id);

/** Every chunk at the levels where metadata may live: top of each RIFF, hdrl, strl, odml. */
function allChunks(avi: Avi): Chunk[] {
  const out: Chunk[] = [];
  const visit = (cs: Chunk[]) => {
    for (const c of cs) {
      out.push(c);
      if (c.type === 'hdrl' || c.type === 'strl' || c.type === 'odml') visit(c.children);
    }
  };
  for (const r of avi.riffs) visit(r.children);
  return out;
}

const infoLists = (avi: Avi) => allChunks(avi).filter((c) => c.id === 'LIST' && c.type === 'INFO');

// ------------------------------------------------------------------- labels

type Def = [label: string, sensitivity?: Sensitivity, kind?: FieldKind];

const INFO_DEFS: Record<string, Def> = {
  INAM: ['Title', 'content'],
  IART: ['Artist', 'identity'],
  ICMT: ['Comment', 'content', 'multiline'],
  ICRD: ['Creation date', 'time', 'datetime'],
  ISFT: ['Software', 'software'],
  IGNR: ['Genre', 'content'],
  ICOP: ['Copyright', 'identity'],
  IENG: ['Engineer', 'identity'],
  ITCH: ['Technician', 'identity'],
  ISBJ: ['Subject', 'content'],
  IKEY: ['Keywords', 'content'],
  ISRC: ['Source', 'content'],
  ISRF: ['Source form', 'content'],
  IPRD: ['Product', 'content'],
  ICMS: ['Commissioned by', 'identity'],
  ILNG: ['Language'],
  IARL: ['Archival location', 'location'],
  ICNT: ['Country', 'location'],
  IMED: ['Medium'],
  ICRP: ['Cropped'],
  IDIM: ['Dimensions'],
  IDPI: ['Dots per inch'],
  ILGT: ['Lightness'],
  IPLT: ['Palette setting'],
  ISHP: ['Sharpness'],
  ISMP: ['SMPTE time code', 'time'],
  IDIT: ['Digitization date', 'time'],
  ITRK: ['Track number'],
  IPRT: ['Part'],
  IFRM: ['Total parts'],
  ISGN: ['Secondary genre', 'content'],
  ISTR: ['Starring', 'identity'],
  IWRI: ['Written by', 'identity'],
  IPRO: ['Produced by', 'identity'],
  ICNM: ['Cinematographer', 'identity'],
  IPDS: ['Production designer', 'identity'],
  IEDT: ['Edited by', 'identity'],
  ICDS: ['Costume designer', 'identity'],
  IMUS: ['Music by', 'identity'],
  ISTD: ['Production studio', 'identity'],
  IDST: ['Distributed by', 'identity'],
  IENC: ['Encoded by', 'identity'],
  IRIP: ['Ripped by', 'identity'],
  IBSU: ['Base URL', 'identity'],
  IRTD: ['Rating'],
  TAPE: ['Tape name', 'content'],
  TCOD: ['Start time code', 'time'],
  TCDO: ['End time code', 'time'],
};

const ADDABLE = ['INAM', 'IART', 'ICMT', 'ICRD', 'ICOP', 'IGNR', 'IKEY', 'ISBJ', 'IENG', 'ITCH', 'ISRC', 'IPRD', 'ICMS', 'ISFT'];

const infoDef = (id: string): Def => INFO_DEFS[id] ?? [`INFO ${id.trim()}`, 'content'];

const VCODECS: Record<string, string> = {
  H264: 'H.264',
  X264: 'H.264',
  AVC1: 'H.264',
  HEVC: 'H.265',
  H265: 'H.265',
  HVC1: 'H.265',
  MJPG: 'Motion JPEG',
  AVRN: 'Motion JPEG',
  XVID: 'MPEG-4 Part 2 (Xvid)',
  DIVX: 'MPEG-4 Part 2 (DivX)',
  DX50: 'MPEG-4 Part 2 (DivX)',
  FMP4: 'MPEG-4 Part 2',
  MP4V: 'MPEG-4 Part 2',
  DIV3: 'MS MPEG-4 v3',
  MP43: 'MS MPEG-4 v3',
  MP42: 'MS MPEG-4 v2',
  DVSD: 'DV',
  DV25: 'DV',
  DV50: 'DV50',
  DVHD: 'DV HD',
  CVID: 'Cinepak',
  IV50: 'Indeo 5',
  IV41: 'Indeo 4',
  IV32: 'Indeo 3',
  WMV3: 'WMV9',
  VP80: 'VP8',
  VP90: 'VP9',
  FFV1: 'FFV1',
  HFYU: 'HuffYUV',
  MPG1: 'MPEG-1',
  MPG2: 'MPEG-2',
  MSVC: 'Microsoft Video 1',
};

const ACODECS: Record<number, string> = {
  0x0001: 'PCM',
  0x0002: 'MS ADPCM',
  0x0003: 'PCM (float)',
  0x0006: 'A-law',
  0x0007: 'µ-law',
  0x0011: 'IMA ADPCM',
  0x0050: 'MPEG audio',
  0x0055: 'MP3',
  0x00ff: 'AAC',
  0x0160: 'WMA',
  0x0161: 'WMA',
  0x0162: 'WMA Pro',
  0x1610: 'AAC (ADTS)',
  0x2000: 'AC-3',
  0x2001: 'DTS',
  0x706d: 'AAC',
  0xfffe: 'WAVE extensible',
};

const STRD_VENDORS: Record<string, string> = { AVIF: 'EXIF camera data', CASI: 'Casio camera data', Zora: 'Samsung camera data' };

const UNKNOWN_LABELS: Record<string, [string, Sensitivity]> = {
  _PMX: ['XMP metadata', 'content'],
  'LIST ncdt': ['Nikon camera data', 'device'],
  'LIST Tdat': ['Adobe time code data', 'software'],
  'LIST exif': ['EXIF camera data', 'device'],
  'LIST PENT': ['Pentax camera data', 'device'],
  'LIST hydt': ['Pentax camera data', 'device'],
  'LIST pntx': ['Pentax camera data', 'device'],
  ISMP: ['SMPTE time code', 'time'],
};

/** Chunks needed to play the file; anything else outside 'movi' is metadata. */
const KEEP: Record<string, Set<string>> = {
  top: new Set(['LIST hdrl', 'LIST movi', 'idx1', 'JUNK', 'JUNQ', 'LIST odml']),
  hdrl: new Set(['avih', 'LIST strl', 'LIST odml', 'JUNK']),
  strl: new Set(['strh', 'strf', 'indx', 'vprp', 'JUNK']),
  odml: new Set(['dmlh', 'JUNK']),
};

const tagOf = (c: Chunk) => (c.type ? `${c.id} ${c.type}` : c.id);

// ------------------------------------------------------------------ reading

function zstr(d: Uint8Array): string {
  return utf8OrLatin1(d)
    .replace(/\0[\s\S]*$/, '')
    .trimEnd();
}

interface InfoEntry {
  id: string;
  /** field id suffix (fourcc, plus #n for repeats) */
  key: string;
  data: Uint8Array;
}

function infoEntries(avi: Avi): InfoEntry[] {
  const out: InfoEntry[] = [];
  const seen = new Map<string, number>();
  for (const list of infoLists(avi)) {
    for (const c of list.children) {
      if (!c.data || c.id === 'JUNK') continue;
      const n = (seen.get(c.id) ?? 0) + 1;
      seen.set(c.id, n);
      out.push({ id: c.id, key: n > 1 ? `${c.id}#${n}` : c.id, data: c.data });
    }
  }
  return out;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CTIME = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})/;

/** IDIT value ("Mon Mar 03 09:44:56 2008" or "2008:03:03 09:44:56") as parts. */
function parseIdit(s: string): DateParts | null {
  const m = CTIME.exec(s.trim());
  if (m) {
    const month = MONTHS.indexOf(m[1].toUpperCase()) + 1;
    return month ? { year: +m[6], month, day: +m[2], hour: +m[3], minute: +m[4], second: +m[5] } : null;
  }
  return parseDate(s.trim().replace(/^(\d{4})[/.](\d{2})[/.](\d{2})/, '$1:$2:$3'));
}

function formatIdit(p: DateParts, ctime: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(p.hour ?? 0)}:${pad(p.minute ?? 0)}:${pad(p.second ?? 0)}`;
  if (!ctime) return `${p.year}:${pad(p.month ?? 1)}:${pad(p.day ?? 1)} ${time}`;
  const dow = new Date(Date.UTC(p.year, (p.month ?? 1) - 1, p.day ?? 1)).getUTCDay();
  const mon = MONTHS[(p.month ?? 1) - 1];
  return `${DAYS[dow]} ${mon[0]}${mon.slice(1).toLowerCase()} ${pad(p.day ?? 1)} ${time} ${p.year}\n`;
}

interface Stream {
  index: number;
  list: Chunk;
  type: string;
  handler: string;
  rate: number;
  scale: number;
  length: number;
  strf: Uint8Array | null;
}

function streams(avi: Avi): Stream[] {
  const hdrl = listOf(avi.top, 'hdrl');
  if (!hdrl) return [];
  return hdrl.children
    .filter((c) => c.id === 'LIST' && c.type === 'strl')
    .map((list, index) => {
      const strh = chunkOf(list.children, 'strh')?.data;
      const r = strh && strh.length >= 36 ? new Reader(strh, true) : null;
      return {
        index,
        list,
        type: r ? r.fourcc(0) : '',
        handler: r ? r.fourcc(4).replace(/\0/g, ' ').trim() : '',
        scale: r ? r.u32(20) : 0,
        rate: r ? r.u32(24) : 0,
        length: r ? r.u32(32) : 0,
        strf: chunkOf(list.children, 'strf')?.data ?? null,
      };
    });
}

function videoCodec(s: Stream): string {
  const comp = s.strf && s.strf.length >= 20 ? latin1(s.strf.subarray(16, 20)) : '';
  const cc = (/^[\x20-\x7e]{4}$/.test(comp) ? comp : s.handler).trim();
  if (!cc || comp === '\0\0\0\0') return 'Uncompressed';
  return VCODECS[cc.toUpperCase()] ? `${VCODECS[cc.toUpperCase()]} (${cc})` : cc;
}

function audioCodec(s: Stream): string {
  if (!s.strf || s.strf.length < 16) return 'Audio';
  const r = new Reader(s.strf, true);
  const tag = r.u16(0);
  const parts = [ACODECS[tag] ?? `format 0x${tag.toString(16).padStart(4, '0')}`, `${r.u32(4)} Hz`, `${r.u16(2)} ch`];
  const bits = r.u16(14);
  if (bits && (tag === 1 || tag === 3)) parts.push(`${bits}-bit`);
  return parts.join(' · ');
}

function technicalInfo(avi: Avi, warnings: string[]): InfoItem[] {
  const info: InfoItem[] = [];
  const hdrl = listOf(avi.top, 'hdrl');
  const avih = hdrl && chunkOf(hdrl.children, 'avih')?.data;
  const ss = streams(avi);
  const video = ss.find((s) => s.type === 'vids');
  if (!hdrl || !avih || avih.length < 40) {
    warnings.push('AVI main header (avih) is missing.');
    return info;
  }
  const r = new Reader(avih, true);
  const usPerFrame = r.u32(0);
  let frames = r.u32(16);
  const odml = listOf(hdrl.children, 'odml');
  const dmlh = odml && chunkOf(odml.children, 'dmlh')?.data;
  if (dmlh && dmlh.length >= 4) frames = Math.max(frames, new Reader(dmlh, true).u32(0));
  const width = r.u32(32);
  const height = r.u32(36);
  const fps = video && video.scale && video.rate ? video.rate / video.scale : usPerFrame ? 1e6 / usPerFrame : 0;
  if (width && height) info.push({ label: 'Dimensions', value: `${width} × ${height}` });
  if (fps) info.push({ label: 'Frame rate', value: `${Math.round(fps * 1000) / 1000} fps` });
  if (frames) info.push({ label: 'Frames', value: String(frames) });
  if (frames && fps) info.push({ label: 'Duration', value: formatDuration(frames / fps) });
  for (const s of ss) {
    if (s.type === 'vids') info.push({ label: `Stream ${s.index} (video)`, value: videoCodec(s) });
    else if (s.type === 'auds') info.push({ label: `Stream ${s.index} (audio)`, value: audioCodec(s) });
    else info.push({ label: `Stream ${s.index}`, value: s.type.trim() || 'unknown' });
  }
  if (avi.riffs.length > 1 || odml) info.push({ label: 'OpenDML', value: avi.riffs.length > 1 ? `Yes, ${avi.riffs.length} RIFF parts` : 'Yes' });
  return info;
}

function hdrlIdit(avi: Avi): Chunk | undefined {
  const hdrl = listOf(avi.top, 'hdrl');
  return (hdrl && chunkOf(hdrl.children, 'IDIT')) ?? chunkOf(avi.top, 'IDIT');
}

/** Unknown chunks at the metadata levels (with their parent level). */
function unknownChunks(avi: Avi): Chunk[] {
  const out: Chunk[] = [];
  const handled = new Set(['LIST INFO', 'IDIT', 'strd', 'strn']);
  const visit = (cs: Chunk[], level: string) => {
    for (const c of cs) {
      const t = tagOf(c);
      if (handled.has(t)) continue;
      if (!KEEP[level].has(t)) {
        out.push(c);
        continue;
      }
      if (c.type === 'hdrl' || c.type === 'strl' || c.type === 'odml') visit(c.children, c.type);
    }
  };
  avi.riffs.forEach((r, i) => visit(i ? r.children.filter((c) => c.type !== 'movi') : r.children, 'top'));
  return out;
}

export async function readAvi(src: Source): Promise<Metadata> {
  const avi = await parseAvi(src);
  const warnings = [...avi.warnings];
  const info = technicalInfo(avi, warnings);
  const groups: FieldGroup[] = [];

  // RIFF INFO
  const entries = infoEntries(avi);
  const fields: Field[] = entries.map((e) => {
    const [label, sensitivity, kind0] = infoDef(e.id);
    const text = zstr(e.data);
    let kind: FieldKind = kind0 ?? 'text';
    let value = text;
    if (kind === 'datetime') {
      const p = parseDate(text);
      if (p) value = toIso(p);
      else kind = 'text';
    }
    return makeField(
      { id: `avi:info:${e.key}`, label, kind, sensitivity, tag: `INFO/${e.id}` },
      value,
      kind === 'datetime' ? { display: displayDate(value) } : {},
    );
  });
  const present = new Set(entries.map((e) => e.id));
  const addable: FieldSpec[] = ADDABLE.filter((id) => !present.has(id)).map((id) => {
    const [label, sensitivity, kind] = infoDef(id);
    return spec(`avi:info:${id}`, label, kind ?? 'text', { sensitivity, tag: `INFO/${id}` });
  });
  groups.push({ id: 'avi.info', label: 'RIFF INFO', source: 'RIFF INFO', fields, addable, removable: fields.length > 0 });

  // Camera data: IDIT + strd
  const camera: Field[] = [];
  const idit = hdrlIdit(avi);
  if (idit?.data) {
    const text = zstr(idit.data);
    const p = parseIdit(text);
    const s = spec('avi:idit', 'Date/time original', p ? 'datetime' : 'text', {
      sensitivity: 'time',
      tag: 'IDIT',
      description: 'Recording date written by the camera.',
    });
    const v = p ? toIso(p) : text;
    camera.push(makeField(s, v, p ? { display: displayDate(v) } : {}));
  }
  for (const s of streams(avi)) {
    const strd = chunkOf(s.list.children, 'strd');
    if (!strd) continue;
    const vendor = strd.data && strd.data.length >= 4 ? latin1(strd.data.subarray(0, 4)) : '';
    const what = STRD_VENDORS[vendor] ?? (/^[\x20-\x7e]{4}$/.test(vendor) ? `Vendor data “${vendor}”` : 'Vendor data');
    camera.push(
      rawField(`avi:strd:${s.index}`, `Stream ${s.index} data`, `${what}, ${formatBytes(strd.size)}`, {
        sensitivity: 'device',
        tag: 'strd',
        description: 'Proprietary stream data, usually written by cameras (model, settings, serial numbers).',
      }),
    );
  }
  if (camera.length) groups.push({ id: 'avi.camera', label: 'Camera', source: 'AVI', fields: camera });

  // Stream names, unknown chunks, trailing data
  const other: Field[] = [];
  for (const s of streams(avi)) {
    const strn = chunkOf(s.list.children, 'strn');
    if (strn?.data)
      other.push(rawField(`avi:strn:${s.index}`, `Stream ${s.index} name`, zstr(strn.data) || '(empty)', { sensitivity: 'content', tag: 'strn' }));
  }
  for (const c of unknownChunks(avi)) {
    const [label, sensitivity] = UNKNOWN_LABELS[tagOf(c)] ?? [c.type ? `List “${c.type.trim()}”` : `Chunk “${c.id.trim()}”`, 'content' as Sensitivity];
    other.push(rawField(`avi:chunk:${c.pos}`, label, formatBytes(c.size), { sensitivity, tag: tagOf(c) }));
  }
  if (avi.trailer < avi.size) {
    other.push(
      rawField('avi:trailer', 'Data after end', `${formatBytes(avi.size - avi.trailer)} after the last RIFF chunk`, { sensitivity: 'content', tag: 'Trailer' }),
    );
  }
  if (other.length) groups.push({ id: 'avi.other', label: 'Embedded data', source: 'AVI', fields: other, removable: true });

  return {
    format: { id: 'avi', name: 'AVI video', mime: 'video/x-msvideo', category: 'video' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ------------------------------------------------------------------ writing

interface Patch {
  pos: number;
  /** bytes of the original replaced by `bytes` (0 = pure insertion) */
  length: number;
  bytes: Uint8Array;
}

/** The chunk turned into zero-filled JUNK of identical size. */
function junkOver(c: Chunk): Patch {
  const w = new Writer(true, 8 + c.size);
  w.ascii('JUNK').u32(c.size).zeros(c.size);
  return { pos: c.pos, length: 8 + c.size, bytes: w.finish() };
}

function junk(total: number): Uint8Array {
  const w = new Writer(true, total);
  w.ascii('JUNK')
    .u32(total - 8)
    .zeros(total - 8);
  return w.finish();
}

/** LIST INFO from entries; `extra` NUL bytes (even) are appended to the last value. */
function infoList(entries: Array<{ id: string; data: Uint8Array }>, extra = 0): Uint8Array {
  const w = new Writer(true, 256);
  w.ascii('LIST').u32(0).ascii('INFO');
  entries.forEach((e, i) => {
    const pad = i === entries.length - 1 ? extra : 0;
    w.ascii(e.id)
      .u32(e.data.length + pad)
      .bytes(e.data)
      .zeros(pad);
    if ((e.data.length + pad) & 1) w.u8(0);
  });
  w.patchU32(4, w.length - 8);
  return w.finish();
}

function textData(s: string): Uint8Array {
  const b = encodeUtf8(s);
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  return out;
}

async function apply(src: Source, avi: Avi, patches: Patch[], dropTrailer = false): Promise<Blob> {
  patches.sort((a, b) => a.pos - b.pos || a.length - b.length);
  const parts: Array<Uint8Array | Blob> = [];
  let at = 0;
  for (const p of patches) {
    if (p.pos < at) throw new MetadataError('Internal error: overlapping AVI patches');
    if (p.pos + p.length > avi.size) throw new MetadataError('This AVI file appears to be truncated, so this chunk cannot be rewritten in place.');
    if (p.pos > at) parts.push(src.slice(at, p.pos));
    parts.push(p.bytes);
    at = p.pos + p.length;
  }
  // With an inconsistent RIFF size the "trailer" may be media: never drop it then.
  const end = dropTrailer && !avi.damaged ? avi.trailer : avi.size;
  if (at < end) parts.push(src.slice(at, end));
  return toBlob(parts, 'video/x-msvideo');
}

/** Patches that store `entries` as the file's INFO list (all old INFO lists are replaced). */
function infoPatches(avi: Avi, entries: Array<{ id: string; data: Uint8Array }>): Patch[] {
  const lists = infoLists(avi);
  const patches: Patch[] = [];
  const top = avi.top;
  const first = lists.find((l) => top.includes(l));
  // Slot: the first top-level INFO list (or JUNK run) plus adjacent JUNK.
  let i = first ? top.indexOf(first) : top.findIndex((c) => c.id === 'JUNK');
  let slot: { start: number; end: number } | null = null;
  if (i >= 0) {
    let j = i;
    while (i > 0 && top[i - 1].id === 'JUNK') i--;
    while (j + 1 < top.length && top[j + 1].id === 'JUNK') j++;
    slot = { start: top[i].pos, end: top[j].end };
  }
  const covered = (c: Chunk) => slot !== null && c.pos >= slot.start && c.end <= slot.end;
  for (const l of lists) if (!covered(l)) patches.push(junkOver(l));
  if (!entries.length) {
    // Nothing to store: blank the slot's INFO list only.
    if (first) patches.push(junkOver(first));
    return patches;
  }

  const plain = infoList(entries);
  const room = slot ? slot.end - slot.start : 0;
  const left = room - plain.length;
  // Chunk sizes keep everything even, so `left` is even: fill it with JUNK
  // (>= 8 bytes) or with extra NULs at the end of the last value (2–6 bytes).
  if (slot && left >= 0 && left % 2 === 0) {
    const body = left >= 8 ? [plain, junk(left)] : [infoList(entries, left)];
    const bytes = new Uint8Array(room);
    let o = 0;
    for (const b of body) {
      bytes.set(b, o);
      o += b.length;
    }
    patches.push({ pos: slot.start, length: room, bytes });
    return patches;
  }

  // Does not fit: blank the old list and insert the new one right after 'movi'.
  if (avi.riffs.length > 1) {
    throw new MetadataError('This OpenDML (multi-part) AVI has no room for more metadata here; use shorter values.');
  }
  if (avi.damaged) throw new MetadataError('This AVI file appears to be truncated or damaged; only edits that fit in place are possible.');
  if (first) patches.push(junkOver(first));
  const movi = top.find((c) => c.type === 'movi');
  const riff = avi.riffs[0];
  const at = movi ? movi.end : riff.end;
  if (at % 2) throw new MetadataError('Unexpected AVI layout (odd chunk alignment)');
  const newSize = riff.size + plain.length;
  if (newSize > 0xffffffff) throw new MetadataError('AVI file is too large to add metadata');
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, newSize, true);
  patches.push({ pos: riff.pos + 4, length: 4, bytes: size });
  patches.push({ pos: at, length: 0, bytes: plain });
  return patches;
}

export async function writeAvi(src: Source, edits: Edits): Promise<Blob> {
  const avi = await parseAvi(src);
  const patches: Patch[] = [];
  const byPos = new Map(allChunks(avi).map((c) => [c.pos, c]));

  // RIFF INFO
  const infoEdits = [...edits].filter(([k]) => k.startsWith('avi:info:'));
  const groupRemoved = edits.get(groupKey('avi.info'))?.op === 'remove';
  if (infoEdits.length || groupRemoved) {
    const entries = groupRemoved ? [] : infoEntries(avi);
    const next: Array<{ id: string; data: Uint8Array } | null> = [...entries];
    for (const [k, e] of infoEdits) {
      if (groupRemoved) break;
      const key = k.slice('avi:info:'.length);
      const idx = entries.findIndex((x) => x.key === key);
      if (e.op === 'remove') {
        if (idx >= 0) next[idx] = null;
        continue;
      }
      const id = key.replace(/#\d+$/, '');
      if (!/^[\x20-\x7e]{4}$/.test(id)) throw new MetadataError(`Invalid INFO id “${id}”`);
      const data = textData(asText(e.value, infoDef(id)[0]));
      if (idx >= 0) next[idx] = { id, data };
      else next.push({ id, data });
    }
    patches.push(
      ...infoPatches(
        avi,
        next.filter((x): x is { id: string; data: Uint8Array } => x !== null),
      ),
    );
  }

  // IDIT (in place, same size)
  const iditEdit = edits.get('avi:idit');
  const idit = hdrlIdit(avi);
  if (iditEdit && idit?.data) {
    if (iditEdit.op === 'remove') patches.push(junkOver(idit));
    else {
      const p = requireDate(iditEdit.value, 'Date/time original');
      const text = encodeLatin1(formatIdit(p, CTIME.test(zstr(idit.data)) || !parseDate(zstr(idit.data))));
      if (text.length > idit.size) throw new MetadataError('The new date does not fit into the existing IDIT chunk');
      const bytes = new Uint8Array(idit.size);
      bytes.set(text);
      patches.push({ pos: idit.pos + 8, length: idit.size, bytes });
    }
  }

  // Removable raw chunks
  const ss = streams(avi);
  for (const [k, e] of edits) {
    if (e.op !== 'remove') continue;
    let m = /^avi:(strd|strn):(\d+)$/.exec(k);
    if (m) {
      const c = ss[+m[2]] && chunkOf(ss[+m[2]].list.children, m[1]);
      if (c) patches.push(junkOver(c));
      continue;
    }
    m = /^avi:chunk:(\d+)$/.exec(k);
    const c = m ? byPos.get(+m[1]) : undefined;
    if (c && unknownChunks(avi).includes(c)) patches.push(junkOver(c));
  }
  if (edits.get(groupKey('avi.other'))?.op === 'remove') {
    for (const c of unknownChunks(avi)) patches.push(junkOver(c));
    for (const s of ss) {
      const strn = chunkOf(s.list.children, 'strn');
      if (strn) patches.push(junkOver(strn));
    }
  }
  return apply(src, avi, dedupe(patches), edits.get('avi:trailer')?.op === 'remove' || edits.get(groupKey('avi.other'))?.op === 'remove');
}

/** Drop exact duplicate patches (the same chunk blanked twice). */
function dedupe(patches: Patch[]): Patch[] {
  const seen = new Set<string>();
  return patches.filter((p) => {
    const k = `${p.pos}:${p.length}:${p.bytes.length}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function stripAvi(src: Source, _opts: StripOptions): Promise<Blob> {
  const avi = await parseAvi(src);
  const patches: Patch[] = [];
  const blank = new Set<Chunk>([...infoLists(avi), ...unknownChunks(avi)]);
  const idit = hdrlIdit(avi);
  if (idit) blank.add(idit);
  for (const s of streams(avi)) {
    const strn = chunkOf(s.list.children, 'strn');
    if (strn) blank.add(strn);
    // Vendor-tagged strd ("AVIF", "CASI"…) is camera metadata; untagged binary strd
    // can be codec setup data that decoders need, so strip leaves it alone.
    const strd = chunkOf(s.list.children, 'strd');
    const tag = strd?.data && strd.data.length >= 4 ? latin1(strd.data.subarray(0, 4)) : '';
    if (strd && (STRD_VENDORS[tag] || /^[A-Za-z][\x20-\x7e]{3}$/.test(tag))) blank.add(strd);
  }
  for (const c of allChunks(avi)) {
    if (c.id === 'IDIT') blank.add(c);
    if (c.id === 'JUNK' && c.data && c.data.some((x) => x !== 0)) blank.add(c); // leftovers
  }
  // Never blank a chunk nested in one that is blanked already.
  const list = [...blank].filter((c) => ![...blank].some((o) => o !== c && o.pos < c.pos && c.end <= o.end));
  for (const c of list) patches.push(junkOver(c));
  return apply(src, avi, patches, true);
}

export const aviHandler: FormatHandler = {
  id: 'avi',
  name: 'AVI video',
  category: 'video',
  extensions: ['avi'],
  mime: 'video/x-msvideo',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if (startsWith(h, 'RIFF') && startsWith(h, 'AVI ', 8)) return startsWith(h, 'LIST', 12) ? 3 : 2;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readAvi,
  write: writeAvi,
  strip: stripAvi,
};
