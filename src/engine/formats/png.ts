/**
 * PNG / APNG: text chunks (tEXt, zTXt, iTXt), EXIF (eXIf), XMP (iTXt
 * "XML:com.adobe.xmp"), tIME, iCCP, ImageMagick/ExifTool "Raw profile type …"
 * legacy profiles, private ancillary chunks and data after IEND.
 *
 * Image data (IDAT, fdAT) and every chunk we do not change are copied
 * verbatim with their original CRC; regenerated chunks get a fresh CRC. New
 * chunks are placed right before the image data (first IDAT or fcTL).
 */

import { zlibSync } from 'fflate';
import {
  MAX_INFLATED,
  Reader,
  Writer,
  crc32,
  encodeLatin1,
  encodeUtf8,
  formatBytes,
  inflateLimited,
  isAscii,
  latin1,
  startsWith,
  toBlob,
  utf8,
  utf8OrLatin1,
} from '../core/binary';
import { asText, dateToParts, displayDate, fmtNum, makeField, partsToDate, rawField, requireDate, toIso } from '../core/fields';
import { iccDescription } from '../core/icc';
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
import { applyExifEdits, exifGroups, exifOrientation, orientationOnlyExif } from '../exif/fields';
import { emptyExif, isEmptyExif, parseTiff, writeTiff, type ExifData } from '../exif/tiff';
import {
  IRB_IPTC,
  IRB_IPTC_DIGEST,
  applyIptcEdits,
  iptcGroups,
  isEmptyIptc,
  parseIptc,
  parseIrb,
  serializeIptc,
  serializeIrb,
  type IptcData,
} from '../iptc/iptc';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const XMP_KEYWORD = 'XML:com.adobe.xmp';
const PROFILE_RE = /^Raw profile type (\S+)$/i;

/** Own-property lookup: keys come from file contents ("constructor", "__proto__"…). */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Ancillary chunks needed to render the image correctly (kept by strip). */
const RENDER_CHUNKS = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'pHYs', 'sBIT', 'bKGD', 'hIST', 'acTL', 'fcTL', 'fdAT']);

const CHUNK_LABELS: Record<string, [string, Sensitivity?]> = {
  caBX: ['Content Credentials (C2PA)', 'software'],
  iDOT: ['Apple decoding hint'],
  zxIf: ['Compressed EXIF (non-standard)', 'content'],
  vpAg: ['Virtual page size (ImageMagick)'],
  sPLT: ['Suggested palette'],
  oFFs: ['Image offset'],
  pCAL: ['Pixel calibration'],
  sCAL: ['Physical scale'],
  dSIG: ['Digital signature', 'identity'],
  sTER: ['Stereo layout'],
  orNT: ['Orientation (non-standard)'],
  gIFg: ['GIF graphic control'],
  gIFx: ['GIF application data', 'content'],
};

interface KeywordDef {
  label: string;
  sens: Sensitivity;
  multiline?: boolean;
  /** offered in the "add field" menu */
  common?: boolean;
}

const KEYWORDS: Record<string, KeywordDef> = {
  Title: { label: 'Title', sens: 'content', common: true },
  Author: { label: 'Author', sens: 'identity', common: true },
  Description: { label: 'Description', sens: 'content', multiline: true, common: true },
  Copyright: { label: 'Copyright', sens: 'identity', common: true },
  'Creation Time': { label: 'Creation time', sens: 'time', common: true },
  Software: { label: 'Software', sens: 'software', common: true },
  Disclaimer: { label: 'Disclaimer', sens: 'content', multiline: true, common: true },
  Warning: { label: 'Warning', sens: 'content', multiline: true, common: true },
  Source: { label: 'Source device', sens: 'device', common: true },
  Comment: { label: 'Comment', sens: 'content', multiline: true, common: true },
  parameters: { label: 'Generation parameters (AI)', sens: 'content', multiline: true },
  prompt: { label: 'Prompt (AI)', sens: 'content', multiline: true },
  workflow: { label: 'Workflow (AI)', sens: 'content', multiline: true },
};

const COLOR_TYPES: Record<number, string> = {
  0: 'Grayscale',
  2: 'RGB',
  3: 'Indexed (palette)',
  4: 'Grayscale + alpha',
  6: 'RGBA',
};

// ------------------------------------------------------------------ parse

interface Chunk {
  type: string;
  data: Uint8Array;
  /** the whole chunk as stored: length + type + data + CRC */
  raw: Uint8Array;
  crcOk: boolean;
}

interface Png {
  chunks: Chunk[];
  hasIend: boolean;
  trailer: Uint8Array;
}

interface PngText {
  type: 'tEXt' | 'zTXt' | 'iTXt';
  keyword: string;
  text: string;
  compressed: boolean;
  lang: string;
  translated: string;
}

type Role =
  | { kind: 'text'; text: PngText }
  | { kind: 'badtext'; error: string }
  | { kind: 'xmp'; text: PngText }
  | { kind: 'profile'; profile: string; text: PngText }
  | { kind: 'exif' }
  | { kind: 'time' }
  | { kind: 'iccp' }
  | { kind: 'render' }
  | { kind: 'critical' }
  | { kind: 'private' };

export function parsePng(bytes: Uint8Array): Png {
  if (!startsWith(bytes, SIGNATURE)) throw new MetadataError('Not a PNG file');
  const r = new Reader(bytes);
  const chunks: Chunk[] = [];
  let p = 8;
  let hasIend = false;
  while (p + 12 <= bytes.length) {
    const len = r.u32(p);
    const type = r.fourcc(p + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new MetadataError(`Corrupt PNG: invalid chunk type at byte ${p}`);
    if (p + 12 + len > bytes.length) throw new MetadataError(`Truncated PNG: chunk ${type} runs past the end of the file`);
    const crcOk = crc32(bytes.subarray(p + 4, p + 8 + len)) === r.u32(p + 8 + len);
    chunks.push({ type, data: bytes.subarray(p + 8, p + 8 + len), raw: bytes.subarray(p, p + 12 + len), crcOk });
    p += 12 + len;
    if (type === 'IEND') {
      hasIend = true;
      break;
    }
  }
  if (!chunks.length || (chunks[0].type !== 'IHDR' && chunks[0].type !== 'CgBI')) {
    throw new MetadataError('Corrupt PNG: missing IHDR header');
  }
  return { chunks, hasIend, trailer: bytes.subarray(p) };
}

const inflate = (b: Uint8Array, limit?: number) => inflateLimited(b, 'zlib', limit);

function decodeText(c: Chunk, budget: { left: number }): PngText {
  const inflateText = (b: Uint8Array) => {
    const out = inflate(b, budget.left);
    budget.left -= out.length;
    return out;
  };
  const d = c.data;
  const nul = d.indexOf(0);
  if (nul < 1 || nul > 79) throw new MetadataError('invalid keyword');
  const keyword = latin1(d.subarray(0, nul));
  const base = { keyword, compressed: false, lang: '', translated: '' };
  if (c.type === 'tEXt') return { ...base, type: 'tEXt', text: latin1(d.subarray(nul + 1)) };
  if (c.type === 'zTXt') return { ...base, type: 'zTXt', compressed: true, text: latin1(inflateText(d.subarray(nul + 2))) };
  const flag = d[nul + 1];
  const langEnd = d.indexOf(0, nul + 3);
  const trEnd = langEnd < 0 ? -1 : d.indexOf(0, langEnd + 1);
  if (trEnd < 0) throw new MetadataError('invalid iTXt header');
  const body = d.subarray(trEnd + 1);
  return {
    type: 'iTXt',
    keyword,
    compressed: flag === 1,
    lang: latin1(d.subarray(nul + 3, langEnd)),
    translated: utf8(d.subarray(langEnd + 1, trEnd)),
    text: utf8(flag === 1 ? inflateText(body) : body),
  };
}

function classify(png: Png): Role[] {
  // Every compressed text chunk is decoded: one budget for all, so many small bombs cannot add up.
  const budget = { left: MAX_INFLATED };
  return png.chunks.map((c): Role => {
    if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      let text: PngText;
      try {
        text = decodeText(c, budget);
      } catch (e) {
        return { kind: 'badtext', error: (e as Error).message };
      }
      if (text.keyword === XMP_KEYWORD) return { kind: 'xmp', text };
      const m = PROFILE_RE.exec(text.keyword);
      if (m) return { kind: 'profile', profile: m[1].toLowerCase(), text };
      return { kind: 'text', text };
    }
    if (c.type === 'eXIf') return { kind: 'exif' };
    if (c.type === 'tIME') return { kind: 'time' };
    if (c.type === 'iCCP') return { kind: 'iccp' };
    if (RENDER_CHUNKS.has(c.type)) return { kind: 'render' };
    // Upper-case first letter = critical chunk (IHDR, PLTE, IDAT, IEND, CgBI…)
    if (c.type.charCodeAt(0) < 0x61) return { kind: 'critical' };
    return { kind: 'private' };
  });
}

/** ImageMagick "Raw profile type …" payload: "\n<name>\n<length>\n<hex…>\n". */
function decodeProfile(text: string): Uint8Array | null {
  // Scanned step by step: a single regex for this layout backtracks quadratically on long runs of spaces.
  const start = text.search(/\S|$/);
  const length = /\s*(\d+)/y;
  const lengthAfter = (nl: number) => {
    if (nl < 0) return null;
    length.lastIndex = nl + 1;
    return length.exec(text);
  };
  // "<name>\n<length>", or else a length line with no name before it
  const m = lengthAfter(text.indexOf('\n', start)) ?? lengthAfter(text.lastIndexOf('\n', start));
  if (!m) return null;
  const len = +m[1];
  const hex = text.slice(length.lastIndex).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < len * 2) return null;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function encodeProfile(name: string, data: Uint8Array): string {
  let s = `\n${name}\n${String(data.length).padStart(8)}`;
  for (let i = 0; i < data.length; i++) s += (i % 36 === 0 ? '\n' : '') + data[i].toString(16).padStart(2, '0');
  return `${s}\n`;
}

const stripExifHeader = (b: Uint8Array) => (startsWith(b, 'Exif\0\0') ? b.subarray(6) : b);

interface Extracted<T> {
  data: T | null;
  error?: string;
}

function exifOf(png: Png, roles: Role[]): Extracted<ExifData> {
  let block: Uint8Array | null = null;
  const i = png.chunks.findIndex((c) => c.type === 'eXIf');
  if (i >= 0) block = png.chunks[i].data;
  else {
    const prof = roles.find((r) => r.kind === 'profile' && (r.profile === 'exif' || r.profile === 'app1'));
    if (prof?.kind === 'profile') block = decodeProfile(prof.text.text);
  }
  if (!block) return { data: null };
  try {
    return { data: parseTiff(stripExifHeader(block)) };
  } catch (e) {
    return { data: null, error: `EXIF could not be parsed: ${(e as Error).message}` };
  }
}

function xmpOf(roles: Role[]): Extracted<XmpPacket> {
  let xml: string | null = null;
  const std = roles.find((r) => r.kind === 'xmp');
  if (std?.kind === 'xmp') xml = std.text.text;
  else {
    const prof = roles.find((r) => r.kind === 'profile' && r.profile === 'xmp');
    const bytes = prof?.kind === 'profile' ? decodeProfile(prof.text.text) : null;
    if (bytes) xml = utf8OrLatin1(bytes);
  }
  if (xml === null) return { data: null };
  try {
    return { data: parseXmp(xml) };
  } catch (e) {
    return { data: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

/** IPTC lives in a "Raw profile type iptc" text chunk (raw IIM or a Photoshop IRB). */
function iptcOf(roles: Role[]): { data: IptcData | null; irb: boolean } {
  const prof = roles.find((r) => r.kind === 'profile' && r.profile === 'iptc');
  const bytes = prof?.kind === 'profile' ? decodeProfile(prof.text.text) : null;
  if (!bytes) return { data: null, irb: false };
  if (startsWith(bytes, '8BIM')) {
    const res = parseIrb(bytes).find((x) => x.id === IRB_IPTC);
    return { data: res ? parseIptc(res.data) : { datasets: [] }, irb: true };
  }
  return { data: parseIptc(bytes), irb: false };
}

function iccOf(png: Png): { name: string; icc: Uint8Array | null } | null {
  const c = png.chunks.find((x) => x.type === 'iCCP');
  if (!c) return null;
  const nul = c.data.indexOf(0);
  const name = latin1(c.data.subarray(0, Math.max(0, nul)));
  try {
    return { name, icc: inflate(c.data.subarray(nul + 2)) };
  } catch {
    return { name, icc: null };
  }
}

function timeOf(png: Png): string | null {
  const c = png.chunks.find((x) => x.type === 'tIME');
  if (!c || c.data.length < 7) return null;
  const r = new Reader(c.data);
  const p = { year: r.u16(0), month: c.data[2], day: c.data[3], hour: c.data[4], minute: c.data[5], second: c.data[6], tz: 0 };
  if (p.month < 1 || p.month > 12 || p.day < 1 || p.day > 31 || p.hour > 23 || p.minute > 59 || p.second > 60) return null;
  return toIso(p);
}

// ----------------------------------------------------------------- fields

function textFieldId(keyword: string, occurrence: number): string {
  return occurrence ? `png:text#${occurrence + 1}:${keyword}` : `png:text:${keyword}`;
}

function parseTextFieldId(id: string): { keyword: string; occurrence: number } | null {
  const m = /^png:text(?:#(\d+))?:([\s\S]+)$/.exec(id);
  if (!m) return null;
  return { keyword: m[2], occurrence: m[1] ? Math.max(0, +m[1] - 1) : 0 };
}

function guessSensitivity(keyword: string): Sensitivity {
  if (/gps|location|latitude|longitude|city|country/i.test(keyword)) return 'location';
  if (/date|time/i.test(keyword)) return 'time';
  if (/author|artist|creator|owner|copyright|user|email/i.test(keyword)) return 'identity';
  if (/software|program|tool|generator|version|producer/i.test(keyword)) return 'software';
  if (/make|model|serial|device|camera|scanner/i.test(keyword)) return 'device';
  return 'content';
}

function keywordSpec(keyword: string, id: string, tag: string): FieldSpec {
  const def = own(KEYWORDS, keyword);
  return {
    id,
    label: def?.label ?? keyword,
    kind: def?.multiline ? 'multiline' : 'text',
    sensitivity: def?.sens ?? guessSensitivity(keyword),
    tag,
  };
}

const TIME_SPEC: FieldSpec = {
  id: 'png:tIME',
  label: 'Last modified (tIME)',
  kind: 'datetime',
  sensitivity: 'time',
  tag: 'tIME',
};

function textFields(roles: Role[]): Field[] {
  const seen = new Map<string, number>();
  const out: Field[] = [];
  for (const r of roles) {
    if (r.kind !== 'text') continue;
    const t = r.text;
    const n = seen.get(t.keyword) ?? 0;
    seen.set(t.keyword, n + 1);
    const tag = `${t.type} “${t.keyword}”${t.lang ? ` [${t.lang}]` : ''}`;
    const spec = keywordSpec(t.keyword, textFieldId(t.keyword, n), tag);
    if (spec.kind === 'text' && (t.text.includes('\n') || t.text.length > 80)) spec.kind = 'multiline';
    out.push(makeField(spec, t.text));
  }
  return out;
}

const PROFILE_LABELS: Record<string, string> = {
  exif: 'EXIF',
  app1: 'EXIF',
  xmp: 'XMP',
  iptc: 'IPTC',
  '8bim': 'Photoshop resources',
  icc: 'Color profile',
  icm: 'Color profile',
};

export async function readPng(src: Source): Promise<Metadata> {
  const png = parsePng(await src.bytes());
  const roles = classify(png);
  const warnings: string[] = [];
  const info: InfoItem[] = [];
  const groups: FieldGroup[] = [];

  const ihdr = png.chunks[0].type === 'IHDR' ? png.chunks[0].data : png.chunks.find((c) => c.type === 'IHDR')?.data;
  if (ihdr && ihdr.length >= 13) {
    const r = new Reader(ihdr);
    info.push({ label: 'Dimensions', value: `${r.u32(0)} × ${r.u32(4)}` });
    info.push({ label: 'Color', value: `${COLOR_TYPES[ihdr[9]] ?? `type ${ihdr[9]}`}, ${ihdr[8]}-bit` });
    if (ihdr[12] === 1) info.push({ label: 'Interlace', value: 'Adam7' });
  }
  const actl = png.chunks.find((c) => c.type === 'acTL');
  if (actl && actl.data.length >= 8) {
    const r = new Reader(actl.data);
    info.push({ label: 'Frames', value: String(r.u32(0)) });
    const plays = r.u32(4);
    info.push({ label: 'Loop', value: plays ? `${plays} time${plays > 1 ? 's' : ''}` : 'Forever' });
  }
  const icc = iccOf(png);
  if (icc) {
    const desc = icc.icc ? iccDescription(icc.icc) : null;
    info.push({ label: 'Color profile', value: desc ?? (icc.name || 'Embedded ICC profile') });
  } else if (png.chunks.some((c) => c.type === 'sRGB')) info.push({ label: 'Color profile', value: 'sRGB' });
  else if (png.chunks.some((c) => c.type === 'cICP')) info.push({ label: 'Color profile', value: 'CICP (coded)' });
  const gama = png.chunks.find((c) => c.type === 'gAMA');
  if (gama && gama.data.length >= 4 && !icc) info.push({ label: 'Gamma', value: fmtNum(100000 / new Reader(gama.data).u32(0), 2) });
  const phys = png.chunks.find((c) => c.type === 'pHYs');
  if (phys && phys.data.length >= 9 && phys.data[8] === 1) {
    const r = new Reader(phys.data);
    const [x, y] = [r.u32(0), r.u32(4)].map((v) => Math.round(v * 0.0254));
    info.push({ label: 'Resolution', value: x === y ? `${x} dpi` : `${x} × ${y} dpi` });
  }

  for (const c of png.chunks) if (!c.crcOk) warnings.push(`Chunk ${c.type} has a bad checksum`);
  if (!png.hasIend) warnings.push('The file is truncated (no IEND chunk)');

  const exif = exifOf(png, roles);
  if (exif.error) warnings.push(exif.error);
  if (exif.data) warnings.push(...exif.data.warnings.map((w) => `EXIF: ${w}`));
  groups.push(...exifGroups(exif.data ?? emptyExif(), { addable: true }));

  const xmp = xmpOf(roles);
  if (xmp.error) warnings.push(xmp.error);
  groups.push(...xmpGroups(xmp.data ?? { props: [] }, { addable: true }));

  const iptc = iptcOf(roles);
  if (iptc.data) groups.push(...iptcGroups(iptc.data));

  // Text chunks + tIME
  const fields = textFields(roles);
  const time = timeOf(png);
  if (time) fields.push(makeField(TIME_SPEC, time, { display: displayDate(time) }));
  else if (png.chunks.some((c) => c.type === 'tIME')) fields.push(rawField('png:tIME', TIME_SPEC.label, 'Invalid date', { tag: 'tIME', sensitivity: 'time' }));
  const present = new Set(fields.map((f) => f.id));
  const addable: FieldSpec[] = Object.entries(KEYWORDS)
    .filter(([k, d]) => d.common && !present.has(textFieldId(k, 0)))
    .map(([k]) => keywordSpec(k, textFieldId(k, 0), `tEXt “${k}”`));
  if (!present.has('png:tIME')) addable.push(TIME_SPEC);
  groups.push({ id: 'png', label: 'PNG text', source: 'PNG', fields, addable, removable: true });

  // Other embedded data
  const other: Field[] = [];
  if (icc) {
    const desc = icc.icc ? iccDescription(icc.icc) : null;
    const size = png.chunks.find((c) => c.type === 'iCCP')!.data.length;
    other.push(
      rawField('png:iccp', 'Color profile (ICC)', `${desc ?? (icc.name || 'ICC profile')} — ${formatBytes(icc.icc?.length ?? size)}`, {
        tag: 'iCCP',
        description: 'Removing the color profile can make colors look different.',
      }),
    );
  }
  roles.forEach((r, i) => {
    const c = png.chunks[i];
    if (r.kind === 'profile') {
      const bytes = decodeProfile(r.text.text);
      const what = own(PROFILE_LABELS, r.profile) ?? r.profile;
      other.push(
        rawField(`png:chunk:${i}`, `Legacy ${what} profile`, `${bytes ? formatBytes(bytes.length) : 'Unreadable'}, hex-encoded (ImageMagick style)`, {
          tag: `${c.type} “${r.text.keyword}”`,
          sensitivity: 'content',
          description: 'Non-standard copy of metadata written by ImageMagick and similar tools.',
        }),
      );
    } else if (r.kind === 'badtext') {
      warnings.push(`Text chunk could not be read: ${r.error}`);
      other.push(rawField(`png:chunk:${i}`, 'Unreadable text chunk', formatBytes(c.data.length), { tag: c.type, sensitivity: 'content' }));
    } else if (r.kind === 'private') {
      const [label, sens] = own(CHUNK_LABELS, c.type) ?? [`Private chunk “${c.type}”`, 'content'];
      other.push(rawField(`png:chunk:${i}`, label, formatBytes(c.data.length), { tag: c.type, sensitivity: sens }));
    }
  });
  const meaningfulTrailer = png.trailer.length > 16 || png.trailer.some((b) => b !== 0);
  if (meaningfulTrailer) {
    other.push(
      rawField('png:trailer', 'Data after image', `${formatBytes(png.trailer.length)} after the end of the image`, {
        tag: 'after IEND',
        sensitivity: 'content',
      }),
    );
  }
  if (other.length) groups.push({ id: 'png.other', label: 'Embedded data', source: 'PNG', fields: other });

  return {
    format: { id: 'png', name: actl ? 'Animated PNG' : 'PNG image', mime: actl ? 'image/apng' : 'image/png', category: 'image' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ---------------------------------------------------------------- writing

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const t = encodeLatin1(type);
  const w = new Writer(false, data.length + 12);
  w.u32(data.length)
    .bytes(t)
    .bytes(data)
    .u32(crc32(data, crc32(t)));
  return w.finish();
}

function encodeText(t: PngText): Uint8Array {
  const kw = encodeLatin1(t.keyword);
  const w = new Writer(false, t.text.length + 32);
  w.bytes(kw).u8(0);
  if (t.type === 'tEXt') w.bytes(encodeLatin1(t.text));
  else if (t.type === 'zTXt') w.u8(0).bytes(zlibSync(encodeLatin1(t.text)));
  else {
    const body = encodeUtf8(t.text);
    w.u8(t.compressed ? 1 : 0)
      .u8(0)
      .bytes(encodeLatin1(t.lang))
      .u8(0)
      .bytes(encodeUtf8(t.translated))
      .u8(0);
    w.bytes(t.compressed ? zlibSync(body) : body);
  }
  return makeChunk(t.type, w.finish());
}

/**
 * New text for a keyword, keeping the previous chunk type when it can hold the
 * value. Like ExifTool, non-ASCII text goes to UTF-8 iTXt: Latin-1 tEXt is
 * routinely mis-decoded as UTF-8 by readers.
 */
function updatedText(prev: PngText | undefined, keyword: string, value: string): PngText {
  const text = value.replace(/\0/g, '');
  const big = text.length > 1024;
  if (prev?.type === 'iTXt' || !isAscii(text)) {
    return {
      type: 'iTXt',
      keyword,
      text,
      compressed: prev ? prev.compressed || prev.type === 'zTXt' : big,
      lang: prev?.lang ?? '',
      translated: prev?.translated ?? '',
    };
  }
  const type = prev ? prev.type : big ? 'zTXt' : 'tEXt';
  return { type, keyword, text, compressed: type === 'zTXt', lang: '', translated: '' };
}

function validKeyword(k: string): boolean {
  return k.length >= 1 && k.length <= 79 && /^[\x20-\x7e\xa1-\xff]+$/.test(k) && !/^ | $| {2}/.test(k);
}

function encodeTime(value: Parameters<typeof asText>[0]): Uint8Array {
  const p = requireDate(value, TIME_SPEC.label);
  // tIME is UTC; convert when an offset is given, otherwise take the value as UTC.
  const u = p.tz !== undefined && p.tz !== 0 ? dateToParts(partsToDate(p)) : p;
  if (u.year < 0 || u.year > 65535) throw new MetadataError(`${TIME_SPEC.label}: year out of range`);
  const w = new Writer(false, 7);
  w.u16(u.year)
    .u8(u.month ?? 1)
    .u8(u.day ?? 1)
    .u8(u.hour ?? 0)
    .u8(u.minute ?? 0)
    .u8(Math.min(u.second ?? 0, 60));
  return w.finish();
}

interface Plan {
  /** undefined = keep as is, null = remove */
  exif?: ExifData | null;
  xmp?: XmpPacket | null;
  iptc?: Uint8Array | null;
  time?: Uint8Array | null;
  /** chunk index -> replacement text (null = drop) */
  texts: Map<number, PngText | null>;
  newTexts: PngText[];
  drop: Set<number>;
  dropTrailer: boolean;
}

const emptyPlan = (): Plan => ({ texts: new Map(), newTexts: [], drop: new Set(), dropTrailer: false });

function assemble(png: Png, roles: Role[], plan: Plan): Blob {
  const out: Uint8Array[] = [SIGNATURE];
  const regen = <T>(v: T | null | undefined, make: (x: T) => Uint8Array | null) => (v === undefined ? undefined : v === null ? null : make(v));
  const exifChunk = regen(plan.exif, (d) => (isEmptyExif(d) ? null : makeChunk('eXIf', writeTiff(d))));
  const xmpChunk = regen(plan.xmp, (p) =>
    p.props.length
      ? encodeText({ type: 'iTXt', keyword: XMP_KEYWORD, text: serializeXmp(p, { padding: 0 }), compressed: false, lang: '', translated: '' })
      : null,
  );
  const iptcChunk = regen(plan.iptc, (b) =>
    encodeText({ type: 'zTXt', keyword: 'Raw profile type iptc', text: encodeProfile('IPTC profile', b), compressed: true, lang: '', translated: '' }),
  );
  const timeChunk = regen(plan.time, (b) => makeChunk('tIME', b));
  const placed = { exif: false, xmp: false, iptc: false, time: false, texts: false };
  const place = (key: 'exif' | 'xmp' | 'iptc' | 'time', chunk: Uint8Array | null | undefined) => {
    if (placed[key] || !chunk) return;
    out.push(chunk);
    placed[key] = true;
  };
  const placeNew = () => {
    place('exif', exifChunk);
    place('xmp', xmpChunk);
    place('time', timeChunk);
    place('iptc', iptcChunk);
    if (!placed.texts) for (const t of plan.newTexts) out.push(encodeText(t));
    placed.texts = true;
  };
  /** Replace a chunk of a regenerated kind in place (first one only) or keep it. */
  const swap = (key: 'exif' | 'xmp' | 'iptc' | 'time', chunk: Uint8Array | null | undefined, c: Chunk) => {
    if (chunk === undefined) out.push(c.raw);
    else if (!placed[key] && chunk) place(key, chunk);
    else placed[key] = true;
  };

  const firstFrame = png.chunks.findIndex((c) => c.type === 'IDAT' || c.type === 'fcTL');
  png.chunks.forEach((c, i) => {
    if (i === firstFrame || c.type === 'IEND') placeNew();
    if (plan.drop.has(i)) return;
    const r = roles[i];
    switch (r.kind) {
      case 'exif':
        return swap('exif', exifChunk, c);
      case 'xmp':
        return swap('xmp', xmpChunk, c);
      case 'time':
        return swap('time', timeChunk, c);
      case 'profile':
        if (r.profile === 'iptc') return swap('iptc', iptcChunk, c);
        // Legacy EXIF/XMP copies are folded into the standard chunks on edit.
        if ((r.profile === 'exif' || r.profile === 'app1') && plan.exif !== undefined) return;
        if (r.profile === 'xmp' && plan.xmp !== undefined) return;
        out.push(c.raw);
        return;
      case 'text': {
        const t = plan.texts.get(i);
        if (t === undefined) out.push(c.raw);
        else if (t) out.push(encodeText(t));
        return;
      }
      default:
        // Apple's iDOT holds file offsets of IDAT chunks that a rewrite
        // invalidates; decoders simply fall back to serial decoding without it.
        if (c.type === 'iDOT') return;
        out.push(c.raw);
    }
  });
  if (!png.hasIend) {
    placeNew();
    out.push(makeChunk('IEND', new Uint8Array(0)));
  }
  if (!plan.dropTrailer && png.trailer.length) out.push(png.trailer);
  return toBlob(out, 'image/png');
}

export async function writePng(src: Source, edits: Edits): Promise<Blob> {
  const png = parsePng(await src.bytes());
  const roles = classify(png);
  const plan = emptyPlan();
  const keys = [...edits.keys()];

  // EXIF
  if (edits.get(groupKey('exif'))?.op === 'remove') plan.exif = null;
  else if (keys.some((k) => k.startsWith('exif:'))) {
    const cur = exifOf(png, roles);
    if (cur.error) throw new MetadataError(cur.error);
    const d = cur.data ?? emptyExif(false);
    applyExifEdits(d, edits);
    plan.exif = d;
  }

  // XMP
  if (edits.get(groupKey('xmp'))?.op === 'remove') plan.xmp = null;
  else if (keys.some((k) => k.startsWith('xmp:'))) {
    const cur = xmpOf(roles);
    if (cur.error) throw new MetadataError(cur.error);
    const p = cur.data ?? { props: [] };
    applyXmpEdits(p, edits);
    plan.xmp = p;
  }

  // IPTC (legacy raw profile, ExifTool style: Photoshop IRB)
  if (edits.get(groupKey('iptc'))?.op === 'remove') plan.iptc = null;
  else if (keys.some((k) => k.startsWith('iptc:'))) {
    const cur = iptcOf(roles);
    const d = cur.data ?? { datasets: [] };
    applyIptcEdits(d, edits);
    if (isEmptyIptc(d)) plan.iptc = null;
    else {
      const prof = roles.find((r) => r.kind === 'profile' && r.profile === 'iptc');
      const old = prof?.kind === 'profile' ? decodeProfile(prof.text.text) : null;
      if (cur.data && !cur.irb) plan.iptc = serializeIptc(d);
      else {
        const res = (old && startsWith(old, '8BIM') ? parseIrb(old) : []).filter((x) => x.id !== IRB_IPTC && x.id !== IRB_IPTC_DIGEST);
        res.push({ sig: '8BIM', id: IRB_IPTC, name: new Uint8Array(0), data: serializeIptc(d) });
        plan.iptc = serializeIrb(res);
      }
    }
  }

  // Text chunks and tIME
  const removeAllText = edits.get(groupKey('png'))?.op === 'remove';
  const textIdx: Array<{ index: number; text: PngText }> = [];
  roles.forEach((r, i) => {
    if (r.kind === 'text') textIdx.push({ index: i, text: r.text });
  });
  if (removeAllText) {
    for (const t of textIdx) plan.texts.set(t.index, null);
    plan.time = null;
  }
  for (const [id, e] of edits) {
    if (id === 'png:tIME') {
      plan.time = e.op === 'remove' ? null : encodeTime(e.value);
      continue;
    }
    const key = parseTextFieldId(id);
    if (!key) continue;
    const hits = textIdx.filter((t) => t.text.keyword === key.keyword);
    const hit = hits[key.occurrence];
    if (e.op === 'remove') {
      if (hit) plan.texts.set(hit.index, null);
      continue;
    }
    const value = asText(e.value, own(KEYWORDS, key.keyword)?.label ?? key.keyword);
    if (hit) {
      plan.texts.set(hit.index, updatedText(hit.text, key.keyword, value));
      continue;
    }
    if (key.keyword === XMP_KEYWORD || PROFILE_RE.test(key.keyword)) {
      throw new MetadataError(`“${key.keyword}” is reserved for embedded metadata`);
    }
    if (!validKeyword(key.keyword)) {
      throw new MetadataError(`“${key.keyword}” is not a valid PNG keyword (1–79 Latin-1 characters, no leading/trailing spaces)`);
    }
    plan.newTexts.push(updatedText(undefined, key.keyword, value));
  }

  // Raw blocks
  for (const [id, e] of edits) {
    if (e.op !== 'remove') continue;
    if (id === 'png:iccp') roles.forEach((r, i) => r.kind === 'iccp' && plan.drop.add(i));
    else if (id === 'png:trailer') plan.dropTrailer = true;
    else {
      const m = /^png:chunk:(\d+)$/.exec(id);
      const kind = m ? roles[+m[1]]?.kind : undefined;
      if (kind === 'private' || kind === 'badtext' || kind === 'profile') plan.drop.add(+m![1]);
    }
  }
  return assemble(png, roles, plan);
}

export async function stripPng(src: Source, opts: StripOptions): Promise<Blob> {
  const png = parsePng(await src.bytes());
  const roles = classify(png);
  const orientation = exifOrientation(exifOf(png, roles).data);
  const plan = emptyPlan();
  plan.exif = opts.keepOrientation && orientation && orientation !== 1 ? orientationOnlyExif(orientation) : null;
  plan.xmp = null;
  plan.iptc = null;
  plan.time = null;
  plan.dropTrailer = true;
  roles.forEach((r, i) => {
    const keep = r.kind === 'critical' || r.kind === 'render' || (r.kind === 'iccp' && opts.keepColorProfile) || r.kind === 'exif';
    if (!keep) plan.drop.add(i);
  });
  return assemble(png, roles, plan);
}

export const pngHandler: FormatHandler = {
  id: 'png',
  name: 'PNG image',
  category: 'image',
  extensions: ['png', 'apng'],
  mime: 'image/png',
  detect(ctx: DetectContext) {
    if (startsWith(ctx.head, SIGNATURE)) return startsWith(ctx.head, 'IHDR', 12) || startsWith(ctx.head, 'CgBI', 12) ? 3 : 2;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readPng,
  write: writePng,
  strip: stripPng,
};
