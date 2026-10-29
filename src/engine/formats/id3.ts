/**
 * ID3 tags shared by the MP3, WAV and AIFF handlers:
 * - ID3v2.2 / 2.3 / 2.4: unsynchronisation (tag- and frame-level), extended
 *   header, footer, compressed (zlib) frames, data-length indicators;
 *   encrypted frames are kept verbatim. v2.2 frames are mapped to v2.3 ids and
 *   written back as v2.3; v2.3 / v2.4 tags keep their version.
 * - ID3v1 / v1.1 (+ Enhanced "TAG+")
 * - APEv2 (items read, edited and serialised)
 *
 * Frames become fields: text frames `id3:TIT2`, user text `id3:TXXX:<desc>`,
 * comments/lyrics `id3:COMM[:<desc>]`, URLs `id3:WOAR` / `id3:WXXX:<desc>`,
 * pictures `id3:APIC:<n>` (+ `id3:APIC:new`), everything else raw
 * `id3:<ID>:<n>`. The recording date (TDRC, or TYER/TDAT/TIME in v2.3) is one
 * field `id3:TDRC`.
 */

import {
  MAX_INFLATED,
  Reader,
  Writer,
  concat,
  encodeLatin1,
  encodeUtf16,
  encodeUtf8,
  equalBytes,
  formatBytes,
  inflateLimited,
  isLatin1,
  latin1,
  startsWith,
  utf16,
  utf8OrLatin1,
} from '../core/binary';
import {
  PICTURE_TYPES,
  asImage,
  asList,
  asText,
  describeImage,
  displayDate,
  formatDuration,
  imageValue,
  makeField,
  parseDate,
  rawField,
  requireDate,
  type DateParts,
} from '../core/fields';
import {
  MetadataError,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldSpec,
  type FieldValue,
  type ImageValue,
  type Sensitivity,
} from '../core/types';

// ------------------------------------------------------------- structures

export interface Id3Frame {
  /** 4-character frame id (v2.2 ids are mapped to their v2.3 equivalent). */
  id: string;
  /** Frame body with unsynchronisation / compression undone. */
  data: Uint8Array;
  /** Encrypted or undecodable frame: `data` is the stored body, written back verbatim with these flags. */
  opaque?: { flags: number };
}

export interface Id3Tag {
  /** Major version as read (2, 3 or 4). Serialised as 3 (for 2 and 3) or 4. */
  version: number;
  frames: Id3Frame[];
  /** Bytes the tag occupies in the file (header + body + footer). */
  size: number;
  warnings: string[];
}

const syncsafe = (b: Uint8Array, p: number) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

function syncsafeBytes(n: number): Uint8Array {
  if (n > 0x0fffffff) throw new MetadataError('ID3 tag is too large (over 256 MB)');
  return new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/** Total size (header + body + footer) of an ID3v2 tag starting at `at`, or 0 when there is none. */
export function id3v2Size(b: Uint8Array, at = 0): number {
  if (b.length < at + 10 || !startsWith(b, 'ID3', at)) return 0;
  const v = b[at + 3];
  if (v < 2 || v > 4 || b[at + 4] === 0xff) return 0;
  for (let i = 6; i < 10; i++) if (b[at + i] & 0x80) return 0;
  return 10 + syncsafe(b, at + 6) + (v === 4 && b[at + 5] & 0x10 ? 10 : 0);
}

/** Size of an appended ID3v2.4 tag given its 10-byte "3DI" footer, or 0. */
export function id3v2SizeFromFooter(f: Uint8Array): number {
  if (f.length < 10 || !startsWith(f, '3DI') || f[3] !== 4) return 0;
  for (let i = 6; i < 10; i++) if (f[i] & 0x80) return 0;
  return 20 + syncsafe(f, 6);
}

/** Undo unsynchronisation: every 0xFF 0x00 becomes 0xFF. */
export function deunsync(b: Uint8Array): Uint8Array {
  let n = 0;
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0) n++;
  if (!n) return b;
  const out = new Uint8Array(b.length - n);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    out[o++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return out;
}

// v2.2 three-character ids -> v2.3/2.4 ids
const V22: Record<string, string> = {
  TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4', TCM: 'TCOM',
  TXT: 'TEXT', TLA: 'TLAN', TCO: 'TCON', TAL: 'TALB', TPA: 'TPOS', TRK: 'TRCK', TRC: 'TSRC', TYE: 'TYER',
  TDA: 'TDAT', TIM: 'TIME', TRD: 'TRDA', TMT: 'TMED', TFT: 'TFLT', TBP: 'TBPM', TCR: 'TCOP', TPB: 'TPUB',
  TEN: 'TENC', TSS: 'TSSE', TOF: 'TOFN', TLE: 'TLEN', TSI: 'TSIZ', TDY: 'TDLY', TKE: 'TKEY', TOT: 'TOAL',
  TOA: 'TOPE', TOL: 'TOLY', TOR: 'TORY', TXX: 'TXXX', TCP: 'TCMP', TST: 'TSOT', TSP: 'TSOP', TSA: 'TSOA',
  TS2: 'TSO2', TSC: 'TSOC', WAF: 'WOAF', WAR: 'WOAR', WAS: 'WOAS', WCM: 'WCOM', WCP: 'WCOP', WPB: 'WPUB',
  WXX: 'WXXX', IPL: 'IPLS', MCI: 'MCDI', ETC: 'ETCO', MLL: 'MLLT', STC: 'SYTC', ULT: 'USLT', SLT: 'SYLT',
  COM: 'COMM', RVA: 'RVAD', EQU: 'EQUA', REV: 'RVRB', PIC: 'APIC', GEO: 'GEOB', CNT: 'PCNT', POP: 'POPM',
  BUF: 'RBUF', CRA: 'AENC', UFI: 'UFID', GP1: 'GRP1', MVN: 'MVNM', MVI: 'MVIN',
};

const IMAGE_FORMATS: Record<string, string> = { JPG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', BMP: 'image/bmp' };

/** v2.2 PIC (3-char image format) -> APIC (MIME type) body. */
function picToApic(b: Uint8Array): Uint8Array {
  if (b.length < 5) return b;
  const fmt = latin1(b.subarray(1, 4)).toUpperCase();
  const mime = IMAGE_FORMATS[fmt] ?? `image/${fmt.toLowerCase().trim()}`;
  return concat([b.subarray(0, 1), encodeLatin1(mime), new Uint8Array([0]), b.subarray(4)]);
}

// ---------------------------------------------------------------- parsing

interface RawFrame {
  id: string;
  flags: number;
  body: Uint8Array;
}

function scanFrames(body: Uint8Array, start: number, version: number, syncsafeSizes: boolean): { frames: RawFrame[]; ok: boolean } {
  const frames: RawFrame[] = [];
  const hdr = version === 2 ? 6 : 10;
  const idLen = version === 2 ? 3 : 4;
  let p = start;
  while (p + hdr <= body.length) {
    if (body[p] === 0) return { frames, ok: true }; // padding
    const id = latin1(body.subarray(p, p + idLen));
    if (!/^[A-Z0-9][A-Z0-9 ]+$/.test(id)) return { frames, ok: false };
    let size: number;
    if (version === 2) size = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5];
    else if (syncsafeSizes) {
      if ((body[p + 4] | body[p + 5] | body[p + 6] | body[p + 7]) & 0x80) return { frames, ok: false };
      size = syncsafe(body, p + 4);
    } else size = new Reader(body).u32(p + 4);
    if (p + hdr + size > body.length) return { frames, ok: false };
    const flags = version === 2 ? 0 : (body[p + 8] << 8) | body[p + 9];
    frames.push({ id, flags, body: body.subarray(p + hdr, p + hdr + size) });
    p += hdr + size;
  }
  // Trailing bytes shorter than a frame header must be padding.
  return { frames, ok: body.subarray(p).every((x) => x === 0) };
}

function decodeFrame(f: RawFrame, version: number, tagUnsync: boolean, warnings: string[], budget: { left: number }): Id3Frame | null {
  let id = f.id;
  if (version === 2) {
    const mapped = V22[id];
    if (!mapped) {
      warnings.push(`ID3v2.2 frame ${id} has no modern equivalent and is ignored`);
      return null;
    }
    return { id: mapped, data: mapped === 'APIC' ? picToApic(f.body) : f.body };
  }
  if (id.endsWith(' ')) id = V22[id.trim()] ?? id; // v2.2 ids padded into a v2.3 tag (old iTunes)
  const fl = f.flags;
  let d = f.body;
  if (version === 3) {
    let off = 0;
    const compressed = (fl & 0x0080) !== 0;
    if (compressed) off += 4;
    if (fl & 0x0040) return { id, data: f.body, opaque: { flags: fl } };
    if (fl & 0x0020) off += 1;
    d = d.subarray(Math.min(off, d.length));
    if (compressed) {
      const inflated = inflate(d, id, warnings, budget);
      if (!inflated) return { id, data: f.body, opaque: { flags: fl } };
      d = inflated;
    }
    return { id, data: d };
  }
  // v2.4
  let off = 0;
  if (fl & 0x0040) off += 1; // group id
  if (fl & 0x0004) return { id, data: f.body, opaque: { flags: fl | (tagUnsync ? 0x0002 : 0) } };
  if (fl & 0x0001) off += 4; // data length indicator
  d = d.subarray(Math.min(off, d.length));
  if (fl & 0x0002 || tagUnsync) d = deunsync(d);
  if (fl & 0x0008) {
    const inflated = inflate(d, id, warnings, budget);
    if (!inflated) return { id, data: f.body, opaque: { flags: fl } };
    d = inflated;
  }
  return { id, data: d };
}

/** Inflate a compressed frame within the tag's budget (left compressed, as raw data, when that fails). */
function inflate(d: Uint8Array, id: string, warnings: string[], budget: { left: number }): Uint8Array | null {
  try {
    const out = inflateLimited(d, 'zlib', budget.left);
    budget.left -= out.length;
    return out;
  } catch (e) {
    warnings.push(`Compressed ID3 frame ${id} could not be decompressed: ${(e as Error).message}`);
    return null;
  }
}

/** Parse an ID3v2 tag that starts at offset 0 of `b`. */
export function parseId3v2(b: Uint8Array): Id3Tag {
  const total = id3v2Size(b);
  if (!total) throw new MetadataError('Invalid ID3v2 tag header');
  const version = b[3];
  const flags = b[5];
  const warnings: string[] = [];
  const declared = syncsafe(b, 6);
  let body = b.subarray(10, Math.min(b.length, 10 + declared));
  if (body.length < declared) warnings.push('ID3v2 tag is truncated');
  if (version === 2 && flags & 0x40) {
    warnings.push('Compressed ID3v2.2 tags are not supported; the tag was ignored');
    return { version, frames: [], size: total, warnings };
  }
  const tagUnsync = (flags & 0x80) !== 0;
  if (tagUnsync && version < 4) body = deunsync(body);
  let start = 0;
  if (version >= 3 && flags & 0x40 && body.length >= 4) {
    start = version === 3 ? 4 + new Reader(body).u32(0) : syncsafe(body, 0);
    if (start > body.length) start = body.length;
  }
  let scan = scanFrames(body, start, version, version === 4);
  if (version === 4 && !scan.ok) {
    // iTunes once wrote plain (non-syncsafe) frame sizes in v2.4 tags.
    const alt = scanFrames(body, start, version, false);
    if (alt.ok || alt.frames.length > scan.frames.length) scan = alt;
  }
  if (!scan.ok) warnings.push('ID3v2 tag contains invalid frame data; the remainder was ignored');
  const frames: Id3Frame[] = [];
  // Shared by every compressed frame, so many small bombs cannot add up.
  const budget = { left: MAX_INFLATED };
  for (const f of scan.frames) {
    const d = decodeFrame(f, version, tagUnsync, warnings, budget);
    if (d) frames.push(d);
  }
  return { version, frames, size: total, warnings };
}

/** Serialise as ID3v2.3 or v2.4 (v2.2 tags become v2.3). No unsynchronisation, no extended header. */
export function serializeId3v2(tag: Id3Tag, padding = 0): Uint8Array {
  const version = tag.version === 4 ? 4 : 3;
  const w = new Writer(false, 4096);
  w.ascii('ID3').u8(version).u8(0).u8(0).u32(0);
  for (const f of tag.frames) {
    if (!/^[A-Z0-9]{4}$/.test(f.id)) continue;
    w.ascii(f.id);
    if (version === 4) w.bytes(syncsafeBytes(f.data.length));
    else w.u32(f.data.length);
    w.u16(f.opaque?.flags ?? 0);
    w.bytes(f.data);
  }
  w.zeros(padding);
  const out = w.finish();
  out.set(syncsafeBytes(out.length - 10), 6);
  return out;
}

export function equalFrames(a: Id3Frame, b: Id3Frame): boolean {
  return a.id === b.id && equalBytes(a.data, b.data);
}

export function emptyId3(version = 3): Id3Tag {
  return { version, frames: [], size: 0, warnings: [] };
}

// ----------------------------------------------------------- text coding

const termLen = (enc: number) => (enc === 1 || enc === 2 ? 2 : 1);

function findTerm(b: Uint8Array, p: number, enc: number): number {
  if (termLen(enc) === 1) {
    const i = b.indexOf(0, p);
    return i < 0 ? b.length : i;
  }
  for (let i = p; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  return b.length;
}

function decodeStr(b: Uint8Array, enc: number, state: { le: boolean }): string {
  switch (enc) {
    case 1:
      if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
        state.le = true;
        return utf16(b.subarray(2), true);
      }
      if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
        state.le = false;
        return utf16(b.subarray(2), false);
      }
      return utf16(b, state.le);
    case 2:
      return utf16(b, false);
    case 3:
      return utf8OrLatin1(b);
    default:
      return latin1(b);
  }
}

/** Read one terminated string at `p`: [string, position after terminator]. */
function readStr(b: Uint8Array, p: number, enc: number, state = { le: true }): [string, number] {
  const e = findTerm(b, p, enc);
  return [decodeStr(b.subarray(p, e), enc, state), Math.min(b.length, e + termLen(enc))];
}

function readStrings(b: Uint8Array, enc: number): string[] {
  const out: string[] = [];
  const state = { le: true };
  let p = 0;
  while (p < b.length) {
    const [s, n] = readStr(b, p, enc, state);
    out.push(s);
    p = n;
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Text encoding byte for new frames: Latin-1 when possible, else UTF-16 (v2.3) or UTF-8 (v2.4). */
function pickEnc(values: string[], version: number): number {
  if (values.every(isLatin1)) return 0;
  return version === 4 ? 3 : 1;
}

function encStr(s: string, enc: number, terminate: boolean): Uint8Array {
  const body = enc === 0 ? encodeLatin1(s) : enc === 3 ? encodeUtf8(s) : enc === 1 ? encodeUtf16(s, true, true) : encodeUtf16(s, false);
  return terminate ? concat([body, new Uint8Array(termLen(enc))]) : body;
}

const enc1 = (n: number) => new Uint8Array([n]);

function textBody(values: string[], version: number): Uint8Array {
  const enc = pickEnc(values, version);
  return concat([enc1(enc), ...values.map((v, i) => encStr(v, enc, i < values.length - 1))]);
}

/** Values of a text frame (multi-value frames are NUL-separated). */
export function textValues(f: Id3Frame): string[] {
  if (!f.data.length) return [];
  return readStrings(f.data.subarray(1), f.data[0]).map((s) => s.replace(/\0+$/, ''));
}

/** TXXX / WXXX description. */
function userDesc(f: Id3Frame): string {
  if (!f.data.length) return '';
  return readStr(f.data, 1, f.data[0])[0];
}

function txxxValues(f: Id3Frame): string[] {
  if (!f.data.length) return [];
  const enc = f.data[0];
  const [, p] = readStr(f.data, 1, enc);
  return readStrings(f.data.subarray(p), enc);
}

function wxxxUrl(f: Id3Frame): string {
  if (!f.data.length) return '';
  const [, p] = readStr(f.data, 1, f.data[0]);
  return latin1(f.data.subarray(p)).replace(/\0.*$/s, '');
}

interface LangText {
  lang: string;
  desc: string;
  text: string;
}

/** COMM / USLT */
function parseLangText(f: Id3Frame): LangText {
  const d = f.data;
  if (d.length < 4) return { lang: 'eng', desc: '', text: '' };
  const enc = d[0];
  const lang = latin1(d.subarray(1, 4)).replace(/\0/g, '');
  const state = { le: true };
  const [desc, p] = readStr(d, 4, enc, state);
  const text = decodeStr(d.subarray(p, findTerm(d, p, enc)), enc, state);
  return { lang, desc, text };
}

function langTextBody(t: LangText, version: number): Uint8Array {
  const enc = pickEnc([t.desc, t.text], version);
  const lang = encodeLatin1((t.lang || 'eng').padEnd(3, ' ').slice(0, 3));
  return concat([enc1(enc), lang, encStr(t.desc, enc, true), encStr(t.text, enc, false)]);
}

interface Apic {
  mime: string;
  type: number;
  desc: string;
  data: Uint8Array;
}

function parseApic(f: Id3Frame): Apic | null {
  const d = f.data;
  if (d.length < 4) return null;
  const enc = d[0];
  const z = d.indexOf(0, 1);
  if (z < 0 || z + 2 > d.length) return null;
  const mime = latin1(d.subarray(1, z)).trim().toLowerCase();
  const type = d[z + 1];
  const [desc, p] = readStr(d, z + 2, enc);
  return { mime, type, desc, data: d.subarray(p) };
}

function apicBody(a: Apic, version: number): Uint8Array {
  const enc = pickEnc([a.desc], version);
  return concat([enc1(enc), encodeLatin1(a.mime || 'image/jpeg'), enc1(0), enc1(a.type & 0xff), encStr(a.desc, enc, true), a.data]);
}

// ----------------------------------------------------------------- genres

/** ID3v1 genre list (incl. Winamp extensions). */
export const GENRES: string[] = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age',
  'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion',
  'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock',
  'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy',
  'Cult', 'Gangsta Rap', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret',
  'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz',
  'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing',
  'Fast-Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock',
  'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening',
  'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass',
  'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad',
  'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House',
  'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore', 'Terror', 'Indie', 'BritPop', 'Afro-Punk',
  'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop',
  'Abstract', 'Art Rock', 'Baroque', 'Bhangra', 'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo', 'Dub', 'EBM',
  'Eclectic', 'Electro', 'Electroclash', 'Emo', 'Experimental', 'Garage', 'Global', 'IDM', 'Illbient',
  'Industro-Goth', 'Jam Band', 'Krautrock', 'Leftfield', 'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz',
  'Post-Punk', 'Post-Rock', 'Psytrance', 'Shoegaze', 'Space Rock', 'Trop Rock', 'World Music', 'Neoclassical',
  'Audiobook', 'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock', 'G-Funk', 'Dubstep',
  'Garage Rock', 'Psybient',
];

export function genreIndex(name: string): number {
  const n = name.trim().toLowerCase();
  return GENRES.findIndex((g) => g.toLowerCase() === n);
}

/** Decode TCON values: "(13)", "(13)Pop", "13", "(RX)", "((text"… -> names. */
export function decodeGenres(values: string[]): string[] {
  const out: string[] = [];
  const ref = (r: string) => (r === 'RX' ? 'Remix' : r === 'CR' ? 'Cover' : (GENRES[+r] ?? r));
  for (const v of values) {
    if (/^\d+$/.test(v.trim()) || v === 'RX' || v === 'CR') {
      out.push(ref(v.trim()));
      continue;
    }
    let s = v;
    const refs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = /^\((\d+|RX|CR)\)/.exec(s))) {
      refs.push(ref(m[1]));
      s = s.slice(m[0].length);
    }
    s = s.replace(/^\(\(/, '(');
    // "(17)Rock" repeats the referenced name as refinement: keep just one.
    if (s && !refs.includes(s)) refs.push(s);
    out.push(...refs);
  }
  return out.filter((g) => g !== '');
}

// --------------------------------------------------------- field mapping

interface Def {
  label: string;
  sens?: Sensitivity;
  multiline?: boolean;
  addable?: boolean;
}

const D = (label: string, sens?: Sensitivity, extra: Partial<Def> = {}): Def => ({ label, sens, ...extra });

/** Text-format frames (T*** plus iTunes' GRP1/MVNM/MVIN). */
const TEXT: Record<string, Def> = {
  TIT2: D('Title', 'content', { addable: true }),
  TPE1: D('Artist', 'identity', { addable: true }),
  TALB: D('Album', 'content', { addable: true }),
  TPE2: D('Album artist', 'identity', { addable: true }),
  TDRC: D('Date', 'time', { addable: true }),
  TCON: D('Genre', 'content', { addable: true }),
  TRCK: D('Track', undefined, { addable: true }),
  TPOS: D('Disc', undefined, { addable: true }),
  TCOM: D('Composer', 'identity', { addable: true }),
  TIT1: D('Grouping', 'content'),
  TIT3: D('Subtitle', 'content'),
  TOAL: D('Original album', 'content'),
  TPE3: D('Conductor', 'identity'),
  TPE4: D('Remixed by', 'identity'),
  TEXT: D('Lyricist', 'identity'),
  TOLY: D('Original lyricist', 'identity'),
  TOPE: D('Original artist', 'identity'),
  TIPL: D('Involved people', 'identity'),
  TMCL: D('Musician credits', 'identity'),
  IPLS: D('Involved people', 'identity'),
  TCOP: D('Copyright', 'identity', { addable: true }),
  TPUB: D('Publisher', 'identity', { addable: true }),
  TPRO: D('Produced notice', 'identity'),
  TENC: D('Encoded by', 'identity', { addable: true }),
  TSSE: D('Encoder settings', 'software'),
  TOWN: D('File owner', 'identity'),
  TRSN: D('Internet radio station', 'identity'),
  TRSO: D('Radio station owner', 'identity'),
  TBPM: D('BPM', undefined, { addable: true }),
  TKEY: D('Initial key'),
  TLAN: D('Language'),
  TLEN: D('Length'),
  TMED: D('Media type'),
  TFLT: D('File type'),
  TMOO: D('Mood', 'content'),
  TSRC: D('ISRC', 'content', { addable: true }),
  TOFN: D('Original filename', 'content'),
  TDLY: D('Playlist delay'),
  TSIZ: D('Size'),
  TSST: D('Set subtitle', 'content'),
  TCMP: D('Compilation'),
  TSOA: D('Album sort order'),
  TSOP: D('Artist sort order', 'identity'),
  TSOT: D('Title sort order'),
  TSO2: D('Album artist sort order', 'identity'),
  TSOC: D('Composer sort order', 'identity'),
  TDOR: D('Original release date', 'time'),
  TORY: D('Original release year', 'time'),
  TDRL: D('Release date', 'time'),
  TDEN: D('Encoding time', 'time'),
  TDTG: D('Tagging time', 'time'),
  TRDA: D('Recording dates', 'time'),
  TCAT: D('Podcast category', 'content'),
  TDES: D('Podcast description', 'content', { multiline: true }),
  TGID: D('Podcast ID', 'content'),
  TKWD: D('Podcast keywords', 'content'),
  GRP1: D('Grouping', 'content'),
  MVNM: D('Movement name', 'content'),
  MVIN: D('Movement number'),
};

const URLS: Record<string, Def> = {
  WCOM: D('Commercial information URL', 'content'),
  WCOP: D('Copyright URL', 'identity'),
  WOAF: D('Audio file webpage', 'content'),
  WOAR: D('Artist webpage', 'identity'),
  WOAS: D('Audio source webpage', 'content'),
  WORS: D('Radio station webpage', 'identity'),
  WPAY: D('Payment URL', 'content'),
  WPUB: D('Publisher webpage', 'identity'),
  WFED: D('Podcast feed URL', 'content'),
};

const RAW: Record<string, Def> = {
  PRIV: D('Private data', 'identity'),
  UFID: D('Unique file identifier', 'content'),
  GEOB: D('Embedded object', 'content'),
  MCDI: D('CD table of contents', 'content'),
  RVA2: D('Volume adjustment'),
  RVAD: D('Volume adjustment'),
  EQU2: D('Equalisation'),
  EQUA: D('Equalisation'),
  RVRB: D('Reverb'),
  PCNT: D('Play counter', 'content'),
  POPM: D('Rating', 'identity'),
  SYLT: D('Synchronised lyrics', 'content'),
  ETCO: D('Event timing codes'),
  MLLT: D('MPEG location lookup table'),
  SYTC: D('Synchronised tempo codes'),
  AENC: D('Audio encryption'),
  ENCR: D('Encryption method registration'),
  GRID: D('Group registration'),
  LINK: D('Linked information', 'content'),
  OWNE: D('Ownership', 'identity'),
  COMR: D('Commercial frame', 'identity'),
  USER: D('Terms of use', 'content'),
  POSS: D('Position synchronisation'),
  SIGN: D('Signature', 'identity'),
  SEEK: D('Seek frame'),
  ASPI: D('Audio seek point index'),
  CHAP: D('Chapter', 'content'),
  CTOC: D('Table of contents', 'content'),
  NCON: D('MusicMatch data', 'software'),
  PCST: D('Podcast flag'),
  RBUF: D('Recommended buffer size'),
};

const DATE_PARTS = new Set(['TDRC', 'TYER', 'TDAT', 'TIME']);
const TIMESTAMPS = new Set(['TDOR', 'TDRL', 'TDEN', 'TDTG']);

const isText = (id: string) => id !== 'TXXX' && (id[0] === 'T' || id in TEXT);
const isUrl = (id: string) => id !== 'WXXX' && id[0] === 'W';

/** Field id of every frame (parallel to `frames`). Frames sharing an id form one field. */
function frameKeys(frames: Id3Frame[]): string[] {
  const nth = new Map<string, number>();
  const used = new Set<string>();
  const next = (id: string) => {
    const n = nth.get(id) ?? 0;
    nth.set(id, n + 1);
    return n;
  };
  return frames.map((f) => {
    const id = f.id;
    if (f.opaque) return `id3:${id}:${next(id)}`;
    if (DATE_PARTS.has(id)) return 'id3:TDRC';
    if (id === 'TXXX') return `id3:TXXX:${userDesc(f)}`;
    if (isText(id)) return `id3:${id}`;
    if (id === 'WXXX') return `id3:WXXX:${userDesc(f)}`;
    if (isUrl(id)) return `id3:${id}`;
    if (id === 'COMM' || id === 'USLT') {
      const t = parseLangText(f);
      let k = t.desc ? `id3:${id}:${t.desc}` : `id3:${id}`;
      if (used.has(k)) k = `${k}:${t.lang || next(`${id}:dup`)}`;
      while (used.has(k)) k = `${k}~`;
      used.add(k);
      return k;
    }
    if (id === 'APIC') return `id3:APIC:${next(id)}`;
    return `id3:${id}:${next(id)}`;
  });
}

/** v2.3 date parts (TYER YYYY, TDAT DDMM, TIME HHMM) or TDRC -> DateParts. */
function readDate(frames: Id3Frame[]): { parts: DateParts | null; text: string } {
  const val = (id: string) => {
    const f = frames.find((x) => x.id === id);
    return f ? (textValues(f)[0] ?? '').trim() : '';
  };
  const tdrc = val('TDRC');
  if (tdrc) return { parts: parseDate(tdrc), text: tdrc };
  const year = val('TYER');
  if (!/^\d{4}$/.test(year)) return { parts: year ? parseDate(year) : null, text: year };
  const p: DateParts = { year: +year };
  const dat = val('TDAT');
  if (/^\d{4}$/.test(dat) && +dat.slice(2) >= 1 && +dat.slice(2) <= 12 && +dat.slice(0, 2) >= 1) {
    p.day = +dat.slice(0, 2);
    p.month = +dat.slice(2);
    const time = val('TIME');
    if (/^\d{4}$/.test(time) && +time.slice(0, 2) < 24 && +time.slice(2) < 60) {
      p.hour = +time.slice(0, 2);
      p.minute = +time.slice(2);
    }
  }
  return { parts: p, text: year };
}

/** ID3v2.4 timestamp ("yyyy-MM-ddTHH:mm:ss", no zone) as precise as the parts. */
function id3Timestamp(p: DateParts): string {
  const two = (n: number) => String(n).padStart(2, '0');
  let s = String(p.year).padStart(4, '0');
  if (p.month === undefined) return s;
  s += `-${two(p.month)}`;
  if (p.day === undefined) return s;
  s += `-${two(p.day)}`;
  if (p.hour === undefined) return s;
  s += `T${two(p.hour)}:${two(p.minute ?? 0)}`;
  if (p.second !== undefined) s += `:${two(p.second)}`;
  return s;
}

function sensForDesc(desc: string): Sensitivity | undefined {
  const d = desc.toLowerCase();
  if (/replaygain|itunnorm|itunsmpb|itunpgap|mp3gain|r128/.test(d)) return undefined;
  if (/encod|software|tool|vendor/.test(d)) return 'software';
  if (/date|time|year/.test(d)) return 'time';
  if (/location|place|city|country|gps/.test(d)) return 'location';
  if (/artist|author|composer|owner|email|user|performer|copyright|publisher|label|contact|creator/.test(d)) return 'identity';
  return 'content';
}

function printable(b: Uint8Array): string | null {
  const s = latin1(b);
  return /^[\x20-\x7e]*$/.test(s) ? s : null;
}

function rawDisplay(f: Id3Frame): { label: string; display: string; sens?: Sensitivity } {
  const def = RAW[f.id];
  const label = def?.label ?? `Frame ${f.id}`;
  let sens = def?.sens ?? 'content';
  const size = formatBytes(f.data.length);
  if (f.opaque) return { label, display: `Encrypted frame, ${size}`, sens };
  const d = f.data;
  try {
    switch (f.id) {
      case 'PRIV': {
        const z = d.indexOf(0);
        const owner = latin1(d.subarray(0, z < 0 ? d.length : z));
        if (/^(AverageLevel|PeakValue)$/.test(owner)) sens = 'software';
        return { label: `${label} (${owner})`, display: `${formatBytes(d.length - owner.length - 1)} of private data`, sens };
      }
      case 'UFID': {
        const z = d.indexOf(0);
        const owner = latin1(d.subarray(0, z));
        const ident = printable(d.subarray(z + 1));
        return { label, display: `${owner}${ident ? `: ${ident}` : ` (${formatBytes(d.length - z - 1)})`}`, sens };
      }
      case 'POPM': {
        const z = d.indexOf(0);
        const email = latin1(d.subarray(0, z));
        const rating = d[z + 1] ?? 0;
        let count = 0;
        for (let i = z + 2; i < d.length; i++) count = count * 256 + d[i];
        const stars = rating ? Math.max(1, Math.round((rating / 255) * 5)) : 0;
        return {
          label,
          display: `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} (${rating}/255)${email ? ` — ${email}` : ''}${count ? `, played ${count}×` : ''}`,
          sens,
        };
      }
      case 'PCNT': {
        let count = 0;
        for (const x of d) count = count * 256 + x;
        return { label, display: `${count} plays`, sens };
      }
      case 'GEOB': {
        const enc = d[0];
        const z = d.indexOf(0, 1);
        const mime = latin1(d.subarray(1, z));
        const [file, p] = readStr(d, z + 1, enc);
        const [desc, q] = readStr(d, p, enc);
        return { label, display: `${[desc, file, mime].filter(Boolean).join(' · ')} — ${formatBytes(d.length - q)}`, sens };
      }
      case 'CHAP':
      case 'CTOC': {
        const z = d.indexOf(0);
        return { label: `${label} “${latin1(d.subarray(0, z))}”`, display: size, sens };
      }
    }
  } catch {
    /* fall through */
  }
  return { label, display: size, sens };
}

export interface Id3GroupOptions {
  /** Offer fields that are not present (and "add picture"). */
  addable?: boolean;
}

function versionLabel(tag: Id3Tag | null): string {
  return tag ? `ID3v2.${tag.version}` : 'ID3v2.3';
}

/** Fields for an ID3v2 tag (or, with `addable`, empty groups that create one). */
export function id3Groups(tag: Id3Tag | null, opts: Id3GroupOptions = {}): FieldGroup[] {
  const frames = tag?.frames ?? [];
  const keys = frameKeys(frames);
  const byKey = new Map<string, Id3Frame[]>();
  keys.forEach((k, i) => {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(frames[i]);
  });
  const source = versionLabel(tag);
  const main: Field[] = [];
  const pics: Field[] = [];
  const other: Field[] = [];
  for (const [key, fs] of byKey) {
    const f = fs[0];
    const id = f.id;
    const tagHint = fs.length > 1 && key === 'id3:TDRC' ? fs.map((x) => x.id).join('+') : id;
    if (f.opaque) {
      const r = rawDisplay(f);
      other.push(rawField(key, r.label, r.display, { sensitivity: r.sens, tag: id }));
      continue;
    }
    if (key === 'id3:TDRC') {
      const { parts, text } = readDate(fs);
      const s = { id: key, label: 'Date', sensitivity: 'time' as const, tag: tagHint };
      if (parts) {
        const v = id3Timestamp(parts);
        main.push(makeField({ ...s, kind: 'datetime' }, v, { display: displayDate(v) }));
      } else main.push(makeField({ ...s, kind: 'text' }, text));
      continue;
    }
    if (id === 'TXXX') {
      const desc = userDesc(f);
      const vals = fs.flatMap(txxxValues);
      const s = { id: key, label: desc || 'User text', sensitivity: sensForDesc(desc), tag: `TXXX:${desc}` };
      main.push(vals.length > 1 ? makeField({ ...s, kind: 'list' }, vals) : makeField({ ...s, kind: (vals[0] ?? '').length > 80 ? 'multiline' : 'text' }, vals[0] ?? ''));
      continue;
    }
    if (isText(id)) {
      const def = TEXT[id];
      let vals = fs.flatMap(textValues);
      if (id === 'TCON') vals = decodeGenres(vals);
      const s = { id: key, label: def?.label ?? id, sensitivity: def ? def.sens : 'content', tag: id };
      let display: string | undefined;
      if (id === 'TLEN' && /^\d+$/.test(vals[0] ?? '')) display = formatDuration(+vals[0] / 1000);
      if (TIMESTAMPS.has(id) && vals.length === 1) {
        const p = parseDate(vals[0]);
        if (p) {
          const v = id3Timestamp(p);
          main.push(makeField({ ...s, kind: 'datetime' }, v, { display: displayDate(v) }));
          continue;
        }
      }
      if (vals.length > 1) main.push(makeField({ ...s, kind: 'list' }, vals));
      else main.push(makeField({ ...s, kind: def?.multiline || (vals[0] ?? '').length > 80 ? 'multiline' : 'text' }, vals[0] ?? '', { display }));
      continue;
    }
    if (id === 'WXXX') {
      const desc = userDesc(f);
      main.push(makeField({ id: key, label: desc ? `URL (${desc})` : 'URL', kind: 'text', sensitivity: 'content', tag: 'WXXX' }, wxxxUrl(f)));
      continue;
    }
    if (isUrl(id)) {
      const def = URLS[id];
      const url = latin1(f.data).replace(/\0.*$/s, '');
      main.push(makeField({ id: key, label: def?.label ?? `URL ${id}`, kind: 'text', sensitivity: def?.sens ?? 'content', tag: id }, url));
      continue;
    }
    if (id === 'COMM' || id === 'USLT') {
      const t = parseLangText(f);
      const base = id === 'COMM' ? 'Comment' : 'Lyrics';
      const label = t.desc ? `${base} (${t.desc})` : base;
      const sens = id === 'COMM' && /^itun/i.test(t.desc) ? undefined : 'content';
      main.push(makeField({ id: key, label, kind: 'multiline', sensitivity: sens, tag: `${id}${t.lang ? ` [${t.lang}]` : ''}` }, t.text));
      continue;
    }
    if (id === 'APIC') {
      const a = parseApic(f);
      if (!a) {
        other.push(rawField(key, 'Picture (unreadable)', formatBytes(f.data.length), { sensitivity: 'content', tag: 'APIC' }));
        continue;
      }
      const v: ImageValue = imageValue(a.data, a.mime, { description: a.desc, pictureType: a.type });
      const typeName = PICTURE_TYPES[a.type] ?? `Type ${a.type}`;
      pics.push(
        makeField({ id: key, label: a.desc ? `${typeName} — ${a.desc}` : typeName, kind: 'image', sensitivity: 'content', tag: 'APIC' }, v, {
          display: describeImage(v),
        }),
      );
      continue;
    }
    const r = rawDisplay(f);
    other.push(rawField(key, r.label, fs.length > 1 ? `${fs.length} frames` : r.display, { sensitivity: r.sens, tag: id }));
  }
  const groups: FieldGroup[] = [];
  const addable: FieldSpec[] = [];
  if (opts.addable) {
    for (const [id, def] of Object.entries(TEXT)) {
      if (!def.addable || byKey.has(`id3:${id}`)) continue;
      addable.push({ id: `id3:${id}`, label: def.label, kind: id === 'TDRC' ? 'datetime' : 'text', sensitivity: def.sens, tag: id });
    }
    if (!byKey.has('id3:COMM')) addable.push({ id: 'id3:COMM', label: 'Comment', kind: 'multiline', sensitivity: 'content', tag: 'COMM' });
    if (!byKey.has('id3:USLT')) addable.push({ id: 'id3:USLT', label: 'Lyrics', kind: 'multiline', sensitivity: 'content', tag: 'USLT' });
  }
  if (main.length || addable.length) {
    groups.push({ id: 'id3', label: 'ID3 tag', source, fields: main, addable: addable.length ? addable : undefined, removable: !!tag });
  }
  if (pics.length || opts.addable) {
    groups.push({
      id: 'id3.pictures',
      label: 'Cover art',
      source,
      fields: pics,
      addable: opts.addable ? [{ id: 'id3:APIC:new', label: 'Picture', kind: 'image', sensitivity: 'content', tag: 'APIC' }] : undefined,
    });
  }
  if (other.length) groups.push({ id: 'id3.other', label: 'Other ID3 data', source, fields: other });
  return groups;
}

// ---------------------------------------------------------------- editing

const textFrame = (id: string, values: string[], version: number): Id3Frame => ({ id, data: textBody(values, version) });

function valuesOf(v: FieldValue, label: string): string[] {
  if (Array.isArray(v)) return asList(v);
  const s = asText(v, label);
  return s === '' ? [] : [s];
}

/** Build the frames for a set edit. null = this id cannot be set. */
function buildFrames(key: string, value: FieldValue, version: number, existing: Id3Frame[]): Id3Frame[] | null {
  const rest = key.slice(4);
  if (rest === 'TDRC') {
    const s = asText(value, 'Date').trim();
    if (!s) return [];
    const p = requireDate(s, 'Date');
    if (version === 4) return [textFrame('TDRC', [id3Timestamp(p)], 4)];
    const two = (n: number) => String(n).padStart(2, '0');
    const out = [textFrame('TYER', [String(p.year).padStart(4, '0')], version)];
    if (p.month !== undefined && p.day !== undefined) {
      out.push(textFrame('TDAT', [`${two(p.day)}${two(p.month)}`], version));
      if (p.hour !== undefined) out.push(textFrame('TIME', [`${two(p.hour)}${two(p.minute ?? 0)}`], version));
    }
    return out;
  }
  if (/^APIC:(\d+|new)$/.test(rest)) {
    const img = asImage(value);
    const old = existing[0] ? parseApic(existing[0]) : null;
    const pic: Apic = {
      mime: img.mime || old?.mime || 'image/jpeg',
      type: img.pictureType ?? old?.type ?? 3,
      desc: img.description ?? old?.desc ?? '',
      data: img.data,
    };
    return [{ id: 'APIC', data: apicBody(pic, version) }];
  }
  if (rest.startsWith('TXXX:')) {
    const desc = rest.slice(5);
    const vals = valuesOf(value, desc);
    if (!vals.length) return [];
    const enc = pickEnc([desc, ...vals], version);
    return [{ id: 'TXXX', data: concat([enc1(enc), encStr(desc, enc, true), ...vals.map((v, i) => encStr(v, enc, i < vals.length - 1))]) }];
  }
  if (rest.startsWith('WXXX:')) {
    const desc = rest.slice(5);
    const url = asText(value, 'URL').trim();
    if (!url) return [];
    const enc = pickEnc([desc], version);
    return [{ id: 'WXXX', data: concat([enc1(enc), encStr(desc, enc, true), encodeLatin1(url)]) }];
  }
  const m = /^(COMM|USLT)(?::(.*))?$/.exec(rest);
  if (m) {
    const text = asText(value, m[1] === 'COMM' ? 'Comment' : 'Lyrics');
    if (!text) return [];
    const old = existing[0] ? parseLangText(existing[0]) : null;
    return [{ id: m[1], data: langTextBody({ lang: old?.lang || 'eng', desc: old ? old.desc : (m[2] ?? ''), text }, version) }];
  }
  if (/^[A-Z0-9]{4}$/.test(rest)) {
    if (isText(rest)) {
      const def = TEXT[rest];
      const vals = valuesOf(value, def?.label ?? rest).map((v) => {
        if (!TIMESTAMPS.has(rest)) return v;
        const p = parseDate(v);
        return p ? id3Timestamp(p) : v;
      });
      return vals.length ? [textFrame(rest, vals, version)] : [];
    }
    if (isUrl(rest)) {
      const url = asText(value, 'URL').trim();
      return url ? [{ id: rest, data: encodeLatin1(url) }] : [];
    }
  }
  return null;
}

/** Ids that may be created when absent (anything settable except explicit frame indexes). */
function creatable(key: string): boolean {
  return !/^id3:APIC:\d+$/.test(key) && !/^id3:[A-Z0-9]{4}:\d+$/.test(key);
}

/** Apply `id3:*` edits to the tag in place. Returns true if anything changed. */
export function applyId3Edits(tag: Id3Tag, edits: Edits): boolean {
  if (tag.version === 2) {
    // v2.2 is written as v2.3: re-encode nothing but the version (frame bodies are compatible).
    tag.version = 3;
  }
  const keys = frameKeys(tag.frames);
  const slots: Id3Frame[][] = tag.frames.map((f) => [f]);
  const appended: Id3Frame[] = [];
  let changed = false;
  for (const [key, e] of edits) {
    if (!key.startsWith('id3:')) continue;
    const idx: number[] = [];
    keys.forEach((k, i) => {
      if (k === key) idx.push(i);
    });
    const existing = idx.map((i) => tag.frames[i]);
    let built: Id3Frame[] | null;
    if (e.op === 'remove') built = [];
    else if (existing[0]?.opaque) built = null;
    else built = buildFrames(key, e.value, tag.version, existing);
    if (built === null) continue;
    if (key === 'id3:APIC:new') {
      appended.push(...built);
      changed = built.length > 0 || changed;
      continue;
    }
    if (!idx.length) {
      if (!built.length || !creatable(key)) continue;
      appended.push(...built);
      changed = true;
      continue;
    }
    slots[idx[0]] = built;
    for (const i of idx.slice(1)) slots[i] = [];
    changed = true;
  }
  if (changed) tag.frames = [...slots.flat(), ...appended];
  return changed;
}

/** Plain values for mirroring into ID3v1. */
export function id3Simple(tag: Id3Tag): { title: string; artist: string; album: string; year: string; comment: string; track: string; genre: string } {
  const first = (id: string) => {
    const f = tag.frames.find((x) => x.id === id && !x.opaque);
    return f ? (textValues(f)[0] ?? '') : '';
  };
  const date = readDate(tag.frames.filter((f) => DATE_PARTS.has(f.id)));
  const comm = tag.frames.find((f) => f.id === 'COMM' && !f.opaque && parseLangText(f).desc === '');
  const tcon = tag.frames.find((f) => f.id === 'TCON' && !f.opaque);
  return {
    title: first('TIT2'),
    artist: first('TPE1'),
    album: first('TALB'),
    year: date.parts ? String(date.parts.year) : date.text.slice(0, 4),
    comment: comm ? parseLangText(comm).text : '',
    track: first('TRCK'),
    genre: tcon ? (decodeGenres(textValues(tcon))[0] ?? '') : '',
  };
}

/** A v2.3 tag holding only the pictures of `tag` (for "strip but keep cover art"). */
export function coverOnlyId3(tag: Id3Tag | null): Id3Tag | null {
  if (!tag) return null;
  const frames: Id3Frame[] = [];
  for (const f of tag.frames) {
    if (f.id !== 'APIC' || f.opaque) continue;
    const a = parseApic(f);
    if (a) frames.push({ id: 'APIC', data: apicBody(a, 3) });
  }
  return frames.length ? { version: 3, frames, size: 0, warnings: [] } : null;
}

/**
 * The cover-only tag for the tag in `b`, serialized; null when it has no
 * pictures or cannot be read, since nothing of it can be kept then.
 */
export function coverOnlyId3Bytes(b: Uint8Array | null | undefined): Uint8Array | null {
  if (!b) return null;
  let tag: Id3Tag;
  try {
    tag = parseId3v2(b);
  } catch {
    return null;
  }
  const cover = coverOnlyId3(tag);
  return cover ? serializeId3v2(cover) : null;
}

export function hasId3Edits(edits: Edits): boolean {
  for (const k of edits.keys()) if (k.startsWith('id3:')) return true;
  return false;
}

// ---------------------------------------------------------------- ID3v1

export interface Id3v1 {
  title: string;
  artist: string;
  album: string;
  year: string;
  comment: string;
  /** v1.1 track number, null for v1.0 */
  track: number | null;
  genre: number;
  /** Enhanced TAG+ block (227 bytes before "TAG") */
  plus: { title: string; artist: string; album: string; speed: number; genre: string; start: string; end: string } | null;
}

const v1str = (b: Uint8Array) => latin1(b).replace(/\0.*$/s, '').replace(/\s+$/, '');

/** `tag` = the last 128 bytes ("TAG…"); `plus` = the 227 bytes before it when they start with "TAG+". */
export function parseId3v1(tag: Uint8Array, plus: Uint8Array | null): Id3v1 | null {
  if (tag.length !== 128 || !startsWith(tag, 'TAG')) return null;
  const v11 = tag[125] === 0 && tag[126] !== 0;
  const v: Id3v1 = {
    title: v1str(tag.subarray(3, 33)),
    artist: v1str(tag.subarray(33, 63)),
    album: v1str(tag.subarray(63, 93)),
    year: v1str(tag.subarray(93, 97)),
    comment: v1str(tag.subarray(97, v11 ? 125 : 127)),
    track: v11 ? tag[126] : null,
    genre: tag[127],
    plus: null,
  };
  if (plus && plus.length === 227 && startsWith(plus, 'TAG+')) {
    v.plus = {
      title: v1str(plus.subarray(4, 64)),
      artist: v1str(plus.subarray(64, 124)),
      album: v1str(plus.subarray(124, 184)),
      speed: plus[184],
      genre: v1str(plus.subarray(185, 215)),
      start: v1str(plus.subarray(215, 221)),
      end: v1str(plus.subarray(221, 227)),
    };
  }
  return v;
}

function putStr(out: Uint8Array, at: number, len: number, s: string): void {
  out.set(encodeLatin1(s).subarray(0, len), at);
}

/** Serialise; returns the TAG+ block (or null) and the 128-byte tag. */
export function serializeId3v1(v: Id3v1): { plus: Uint8Array | null; tag: Uint8Array } {
  const tag = new Uint8Array(128);
  putStr(tag, 0, 3, 'TAG');
  putStr(tag, 3, 30, v.title);
  putStr(tag, 33, 30, v.artist);
  putStr(tag, 63, 30, v.album);
  putStr(tag, 93, 4, v.year);
  if (v.track !== null && v.track > 0 && v.track < 256) {
    putStr(tag, 97, 28, v.comment);
    tag[126] = v.track;
  } else putStr(tag, 97, 30, v.comment);
  tag[127] = v.genre;
  let plus: Uint8Array | null = null;
  if (v.plus) {
    plus = new Uint8Array(227);
    putStr(plus, 0, 4, 'TAG+');
    putStr(plus, 4, 60, v.title.slice(30));
    putStr(plus, 64, 60, v.artist.slice(30));
    putStr(plus, 124, 60, v.album.slice(30));
    plus[184] = v.plus.speed;
    putStr(plus, 185, 30, v.plus.genre);
    putStr(plus, 215, 6, v.plus.start);
    putStr(plus, 221, 6, v.plus.end);
  }
  return { plus, tag };
}

/** Values combined with the TAG+ extension. */
function v1Full(v: Id3v1): { title: string; artist: string; album: string } {
  return {
    title: v.title + (v.plus?.title ?? ''),
    artist: v.artist + (v.plus?.artist ?? ''),
    album: v.album + (v.plus?.album ?? ''),
  };
}

const GENRE_OPTIONS = [{ value: '255', label: '(none)' }, ...GENRES.map((g, i) => ({ value: String(i), label: g }))];

export function id3v1Groups(v: Id3v1): FieldGroup[] {
  const full = v1Full(v);
  const max = v.plus ? 90 : 30;
  const fields: Field[] = [
    makeField({ id: 'id3v1:title', label: 'Title', kind: 'text', sensitivity: 'content', tag: 'Title', placeholder: `max ${max} characters` }, full.title),
    makeField({ id: 'id3v1:artist', label: 'Artist', kind: 'text', sensitivity: 'identity', tag: 'Artist' }, full.artist),
    makeField({ id: 'id3v1:album', label: 'Album', kind: 'text', sensitivity: 'content', tag: 'Album' }, full.album),
    makeField({ id: 'id3v1:year', label: 'Year', kind: 'text', sensitivity: 'time', tag: 'Year' }, v.year),
    makeField({ id: 'id3v1:comment', label: 'Comment', kind: 'text', sensitivity: 'content', tag: 'Comment' }, v.comment),
  ];
  if (v.track !== null) fields.push(makeField({ id: 'id3v1:track', label: 'Track', kind: 'integer', tag: 'Track' }, v.track));
  fields.push(
    makeField({ id: 'id3v1:genre', label: 'Genre', kind: 'enum', sensitivity: 'content', tag: 'Genre', options: GENRE_OPTIONS }, String(v.genre), {
      display: GENRES[v.genre] ?? '(none)',
    }),
  );
  const empty = (f: Field) => f.value === '' && f.id !== 'id3v1:title';
  const addable: FieldSpec[] = fields.filter(empty).map((f) => ({ id: f.id, label: f.label, kind: f.kind, sensitivity: f.sensitivity, tag: f.tag }));
  if (v.track === null) addable.push({ id: 'id3v1:track', label: 'Track', kind: 'integer', tag: 'Track' });
  return [
    {
      id: 'id3v1',
      label: 'ID3v1 tag',
      source: v.plus ? 'ID3v1 + TAG+' : v.track !== null ? 'ID3v1.1' : 'ID3v1',
      fields: fields.filter((f) => !empty(f)),
      addable: addable.length ? addable : undefined,
      removable: true,
    },
  ];
}

function setV1(v: Id3v1, key: string, value: string | null): void {
  const s = value ?? '';
  const split = (full: string): [string, string] => [full.slice(0, 30), full.slice(30, 90)];
  switch (key) {
    case 'title':
    case 'artist':
    case 'album': {
      const [a, b] = split(s);
      v[key] = a;
      if (v.plus) v.plus[key] = b;
      break;
    }
    case 'year':
      v.year = s.slice(0, 4);
      break;
    case 'comment':
      v.comment = s;
      break;
    case 'track': {
      const n = parseInt(s, 10);
      v.track = Number.isFinite(n) && n > 0 && n < 256 ? n : v.track === null ? null : 0;
      break;
    }
    case 'genre': {
      if (/^\d+$/.test(s) && +s < 256) v.genre = +s;
      else if (!s) v.genre = 255;
      else {
        const i = genreIndex(s);
        v.genre = i >= 0 ? i : 255;
        if (v.plus) v.plus.genre = s.slice(0, 30);
      }
      break;
    }
  }
}

const MIRROR: Record<string, keyof ReturnType<typeof id3Simple>> = {
  'id3:TIT2': 'title',
  'id3:TPE1': 'artist',
  'id3:TALB': 'album',
  'id3:TDRC': 'year',
  'id3:COMM': 'comment',
  'id3:TRCK': 'track',
  'id3:TCON': 'genre',
};

/**
 * Apply edits to an existing ID3v1 tag: ID3v2 edits of the basic fields are
 * mirrored (from the already-edited v2 tag), then direct `id3v1:*` edits win.
 */
export function applyId3v1Edits(v: Id3v1, edits: Edits, v2: Id3Tag | null): boolean {
  let changed = false;
  const simple = v2 ? id3Simple(v2) : null;
  for (const [key, e] of edits) {
    const target = MIRROR[key];
    if (!target) continue;
    setV1(v, target, e.op === 'remove' || !simple ? '' : simple[target]);
    changed = true;
  }
  for (const [key, e] of edits) {
    if (!key.startsWith('id3v1:')) continue;
    const k = key.slice(6);
    if (e.op === 'remove') setV1(v, k, k === 'genre' ? '255' : null);
    else setV1(v, k, asText(e.value, k));
    changed = true;
  }
  return changed;
}

// ------------------------------------------------------------------ APEv2

export interface ApeItem {
  key: string;
  /** bits 1-2: 0 text (UTF-8), 1 binary, 2 external link */
  flags: number;
  value: Uint8Array;
}

export interface ApeTag {
  version: number;
  items: ApeItem[];
}

/** Total APE tag size (incl. header) given its 32-byte footer, or 0. */
export function apeSizeFromFooter(footer: Uint8Array): number {
  if (footer.length < 32 || !startsWith(footer, 'APETAGEX')) return 0;
  const r = new Reader(footer, true);
  const size = r.u32(12);
  const flags = r.u32(20);
  if (flags & 0x20000000) return 0; // this is a header, not a footer
  return size + (flags & 0x80000000 ? 32 : 0);
}

/** Parse a complete APE tag (optional header + items + footer). */
export function parseApe(b: Uint8Array): ApeTag {
  const footer = b.subarray(b.length - 32);
  if (!startsWith(footer, 'APETAGEX')) throw new MetadataError('Invalid APE tag');
  const r = new Reader(footer, true);
  const version = r.u32(8);
  const size = r.u32(12);
  const count = r.u32(16);
  const items: ApeItem[] = [];
  const ir = new Reader(b, true);
  let p = b.length - size;
  for (let i = 0; i < count && p + 9 <= b.length - 32; i++) {
    const len = ir.u32(p);
    const flags = ir.u32(p + 4);
    const z = b.indexOf(0, p + 8);
    if (z < 0 || z + 1 + len > b.length - 32) break;
    items.push({ key: latin1(b.subarray(p + 8, z)), flags, value: b.subarray(z + 1, z + 1 + len) });
    p = z + 1 + len;
  }
  return { version, items };
}

export function serializeApe(t: ApeTag): Uint8Array {
  const items = new Writer(true);
  for (const it of t.items) {
    items.u32(it.value.length).u32(it.flags).ascii(it.key).u8(0).bytes(it.value);
  }
  const body = items.finish();
  const block = (flags: number) => {
    const w = new Writer(true, 32);
    w.ascii('APETAGEX').u32(2000).u32(body.length + 32).u32(t.items.length).u32(flags).zeros(8);
    return w.finish();
  };
  return concat([block(0xa0000000), body, block(0x80000000)]);
}

const APE_SENS: Record<string, Sensitivity> = {
  title: 'content', subtitle: 'content', album: 'content', comment: 'content', lyrics: 'content', genre: 'content',
  artist: 'identity', 'album artist': 'identity', albumartist: 'identity', composer: 'identity', conductor: 'identity',
  publisher: 'identity', copyright: 'identity', label: 'identity', 'ean/upc': 'content', isrc: 'content',
  year: 'time', 'record date': 'time', 'record location': 'location', tool: 'software', 'tool name': 'software',
  'tool version': 'software', 'encoded by': 'identity', 'encoder': 'software',
};

export function apeGroups(t: ApeTag): FieldGroup[] {
  const fields: Field[] = t.items.map((it) => {
    const id = `ape:${it.key}`;
    const sens = APE_SENS[it.key.toLowerCase()] ?? (/replaygain|mp3gain/i.test(it.key) ? undefined : 'content');
    const kind = (it.flags >> 1) & 3;
    if (kind === 1) {
      if (/^cover art/i.test(it.key)) {
        const z = it.value.indexOf(0);
        const img = imageValue(it.value.subarray(z + 1));
        return makeField({ id, label: it.key, kind: 'image', sensitivity: 'content', tag: it.key }, img, { display: describeImage(img), editable: false });
      }
      return rawField(id, it.key, `Binary, ${formatBytes(it.value.length)}`, { sensitivity: sens, tag: it.key });
    }
    const vals = utf8OrLatin1(it.value).split('\0');
    const s = { id, label: it.key, sensitivity: sens, tag: it.key };
    return vals.length > 1 ? makeField({ ...s, kind: 'list' }, vals) : makeField({ ...s, kind: vals[0].length > 80 ? 'multiline' : 'text' }, vals[0]);
  });
  return [{ id: 'ape', label: 'APE tag', source: `APEv${t.version >= 2000 ? 2 : 1}`, fields, removable: true }];
}

export function applyApeEdits(t: ApeTag, edits: Edits): boolean {
  let changed = false;
  for (const [key, e] of edits) {
    if (!key.startsWith('ape:')) continue;
    const name = key.slice(4);
    const idx = t.items.findIndex((it) => it.key.toLowerCase() === name.toLowerCase());
    if (e.op === 'remove') {
      if (idx >= 0) {
        t.items = t.items.filter((it) => it.key.toLowerCase() !== name.toLowerCase());
        changed = true;
      }
      continue;
    }
    if (idx >= 0 && ((t.items[idx].flags >> 1) & 3) === 1) continue; // binary items are read-only
    const vals = valuesOf(e.value, name);
    if (!vals.length) {
      if (idx >= 0) t.items.splice(idx, 1);
      changed = true;
      continue;
    }
    const item: ApeItem = { key: idx >= 0 ? t.items[idx].key : name, flags: 0, value: encodeUtf8(vals.join('\0')) };
    if (idx >= 0) t.items[idx] = item;
    else t.items.push(item);
    changed = true;
  }
  return changed;
}
