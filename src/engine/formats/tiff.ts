/**
 * TIFF and TIFF-based camera RAW (DNG, CR2, NEF, ARW, PEF, ORF, RW2 …).
 *
 * Plain TIFF files are edited without moving any image data: the rewritten
 * IFD0 (with its Exif / GPS / Interop sub-IFDs) and every new or changed value
 * are appended to the end of the file and the header is re-pointed at the new
 * IFD0. Unchanged out-of-line values (strip offset tables, colour maps, maker
 * notes…), the strips/tiles themselves, SubIFDs and further pages keep their
 * original offsets. Old directories and values that are no longer referenced
 * are overwritten with zeros so no stale metadata survives.
 *
 * strip() rewrites every page (and SubIFD) down to its structural tags and,
 * when the extent of all image data is known, rebuilds a compact file from
 * just those directories and the strips/tiles; otherwise it works in place
 * like write() and zeroes the old directories. JPEGInterchangeFormat/Length
 * are image data only in old-style JPEG directories (Compression 6);
 * elsewhere they hold an EXIF-style JPEG thumbnail, which strip drops.
 *
 * RAW variants are read-only: their maker notes and private IFDs use absolute
 * offsets in ways that cannot be relocated safely.
 */

import { Reader, Writer, encodeUtf8, formatBytes, startsWith, toBlob, utf8OrLatin1 } from '../core/binary';
import { fmtNum, imageValue, makeField, rawField } from '../core/fields';
import { iccDescription } from '../core/icc';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edits,
  type Field,
  type FieldGroup,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Source,
  type StripOptions,
} from '../core/types';
import { applyExifEdits, exifGroups } from '../exif/fields';
import { BYTE, IFD, LONG, PTR_EXIF, PTR_GPS, PTR_INTEROP, SHORT, TYPE_SIZE, type Entry, type ExifData, type Ifd } from '../exif/tiff';
import {
  IRB_IPTC,
  IRB_IPTC_DIGEST,
  IRB_NAMES,
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

const T_XMP = 0x02bc;
const T_IPTC = 0x83bb;
const T_PHOTOSHOP = 0x8649;
const T_ICC = 0x8773;
const T_SUBIFDS = 0x014a;
const T_ORIENTATION = 0x0112;
const T_COMPRESSION = 0x0103;
const T_DNG_VERSION = 0xc612;
const T_JPEG_IF = 0x0201;
const T_JPEG_IF_LEN = 0x0202;
const LONG8 = 16;

/** Own-property lookup: keys come from file contents ("constructor", "__proto__"…). */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Tags describing the image data itself: kept by strip, hidden from the field list, never edited. */
const STRUCTURAL = new Set([
  0x00fe, 0x00ff, 0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107, 0x0108, 0x0109, 0x010a, 0x0111, 0x0115, 0x0116,
  0x0117, 0x0118, 0x0119, 0x011a, 0x011b, 0x011c, 0x011e, 0x011f, 0x0122, 0x0123, 0x0124, 0x0125, 0x0128, 0x0129,
  0x012d, 0x013d, 0x013e, 0x013f, 0x0140, 0x0141, 0x0142, 0x0143, 0x0144, 0x0145, T_SUBIFDS, 0x014c, 0x014d, 0x014e,
  0x0150, 0x0152, 0x0153, 0x0154, 0x0155, 0x0156, 0x015b, 0x0200, 0x0201, 0x0202, 0x0203, 0x0205, 0x0206, 0x0207,
  0x0208, 0x0209, 0x0211, 0x0212, 0x0213, 0x0214, 0x828d, 0x828e,
]);
/** "Free space" bookkeeping: hidden and kept on edit, dropped by strip. */
const FREE_SPACE = new Set([0x0120, 0x0121]);
/** Handled by dedicated groups (or rebuilt pointers), not shown as EXIF fields. */
const SPECIAL = new Set([T_XMP, T_IPTC, T_PHOTOSHOP, T_ICC, PTR_EXIF, PTR_GPS]);
/** DNG tags that identify the camera or its owner; the rest of 0xC612+ is colour calibration. */
const DNG_IDENTIFYING = new Set([0xc614, 0xc615, 0xc62f, 0xc634, 0xc68b, 0xc68c, 0xc6f3, 0xc6f4, 0xc6f8, 0xc6fe]);

/** [offsets tag, byte counts tag] pairs pointing at image data. */
const DATA_PAIRS: Array<[number, number]> = [
  [0x0111, 0x0117],
  [0x0144, 0x0145],
  [0x0201, 0x0202],
];

const COMPRESSION: Record<number, string> = {
  1: 'Uncompressed',
  2: 'CCITT RLE',
  3: 'CCITT Group 3',
  4: 'CCITT Group 4',
  5: 'LZW',
  6: 'JPEG (old-style)',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  32946: 'Deflate',
  34712: 'JPEG 2000',
  34892: 'Lossy JPEG',
  50000: 'Zstandard',
  50001: 'WebP',
  52546: 'JPEG XL',
};
const PHOTOMETRIC: Record<number, string> = {
  0: 'Grayscale',
  1: 'Grayscale',
  2: 'RGB',
  3: 'Palette',
  4: 'Mask',
  5: 'CMYK',
  6: 'YCbCr',
  8: 'CIELab',
  32803: 'Color filter array',
  34892: 'Linear raw',
};

type Variant = 'tiff' | 'dng' | 'cr2' | 'nef' | 'arw' | 'pef' | 'orf' | 'rw2' | 'raw';

const VARIANT_NAMES: Record<Variant, string> = {
  tiff: 'TIFF image',
  dng: 'DNG raw image',
  cr2: 'Canon CR2 raw image',
  nef: 'Nikon NEF raw image',
  arw: 'Sony ARW raw image',
  pef: 'Pentax PEF raw image',
  orf: 'Olympus ORF raw image',
  rw2: 'Panasonic RW2 raw image',
  raw: 'Camera raw image',
};

const RAW_EXT: Record<string, Variant> = {
  dng: 'dng',
  cr2: 'cr2',
  nef: 'nef',
  nrw: 'nef',
  arw: 'arw',
  srf: 'arw',
  sr2: 'arw',
  pef: 'pef',
  orf: 'orf',
  ors: 'orf',
  rw2: 'rw2',
  rwl: 'rw2',
  raw: 'rw2',
  '3fr': 'raw',
  erf: 'raw',
  mef: 'raw',
  mos: 'raw',
  iiq: 'raw',
  srw: 'raw',
  dcr: 'raw',
  kdc: 'raw',
  k25: 'raw',
};

// ------------------------------------------------------------------ parse

/** An IFD entry that remembers where its value lives in the file. */
interface TEntry extends Entry {
  /** absolute offset of an out-of-line value (undefined for inline or new values) */
  at?: number;
  /** unknown type / bad offset: the 4 raw value bytes are written back untouched */
  pinned?: Uint8Array;
}

interface TIfd {
  offset: number;
  entries: TEntry[];
  next: number;
}

interface Tiff {
  bytes: Uint8Array;
  le: boolean;
  variant: Variant;
  ifd0: TIfd;
  exif: TIfd | null;
  gps: TIfd | null;
  interop: TIfd | null;
  warnings: string[];
  /** directory entries that may still be read: overlapping tables could otherwise repeat them endlessly */
  budget: { entries: number };
}

/** Far more than any real file (10,000 pages of 30 tags is 300,000). */
const MAX_ENTRIES = 1_000_000;

const tableSize = (ifd: TIfd) => 2 + ifd.entries.length * 12 + 4;

function readIfd(b: Uint8Array, le: boolean, offset: number, warnings: string[], name: string, budget: { entries: number }): TIfd | null {
  const r = new Reader(b, le);
  if (offset < 8 || offset + 2 > b.length) {
    warnings.push(`${name}: invalid offset ${offset}`);
    return null;
  }
  const n = r.u16(offset);
  if (offset + 2 + n * 12 + 4 > b.length) {
    warnings.push(`${name}: directory runs past the end of the file`);
    return null;
  }
  budget.entries -= n;
  if (budget.entries < 0) throw new MetadataError('This TIFF file has more directory entries than can be processed');
  const entries: TEntry[] = [];
  for (let i = 0; i < n; i++) {
    const p = offset + 2 + i * 12;
    const tag = r.u16(p);
    const type = r.u16(p + 2);
    const count = r.u32(p + 4);
    const size = (TYPE_SIZE[type] ?? (type === LONG8 ? 8 : 0)) * count;
    const raw = b.slice(p + 8, p + 12);
    if (!TYPE_SIZE[type] && type !== LONG8) {
      entries.push({ tag, type, count, data: raw, pinned: raw });
      continue;
    }
    if (size <= 4) {
      entries.push({ tag, type, count, data: b.slice(p + 8, p + 8 + size) });
      continue;
    }
    const at = r.u32(p + 8);
    if (at + size > b.length) {
      warnings.push(`${name}: tag 0x${tag.toString(16).padStart(4, '0')} points outside the file`);
      entries.push({ tag, type, count, data: raw, pinned: raw });
      continue;
    }
    // A view, not a copy: crafted entries may all point at one large region (writers work on a copy of the file).
    entries.push({ tag, type, count, data: b.subarray(at, at + size), at });
  }
  return { offset, entries, next: r.u32(offset + 2 + n * 12) };
}

/** Every integer of a SHORT/LONG/IFD/LONG8 array (no count limit). */
function ints(e: Entry, le: boolean): number[] {
  if (e.type !== SHORT && e.type !== LONG && e.type !== IFD && e.type !== LONG8 && e.type !== BYTE) return [];
  const r = new Reader(e.data, le);
  const size = e.type === SHORT ? 2 : e.type === BYTE ? 1 : e.type === LONG8 ? 8 : 4;
  const out: number[] = [];
  for (let i = 0; i + size <= e.data.length; i += size) {
    out.push(size === 1 ? r.u8(i) : size === 2 ? r.u16(i) : size === 4 ? r.u32(i) : r.u64(i));
  }
  return out;
}

const find = (ifd: { entries: TEntry[] } | null, tag: number) => ifd?.entries.find((e) => e.tag === tag);
const firstInt = (ifd: TIfd | null, tag: number, le: boolean) => {
  const e = find(ifd, tag);
  return e && !e.pinned ? ints(e, le)[0] : undefined;
};

function variantOf(b: Uint8Array, le: boolean, ifd0: TIfd, ext: string): Variant {
  const magic = new Reader(b, le).u16(2);
  if (magic === 0x4f52 || magic === 0x5352) return 'orf';
  if (magic === 0x55) return 'rw2';
  if (startsWith(b, 'CR', 8)) return 'cr2';
  if (find(ifd0, T_DNG_VERSION)) return 'dng';
  return own(RAW_EXT, ext) ?? 'tiff';
}

export function parseTiffFile(bytes: Uint8Array, name = ''): Tiff {
  if (bytes.length < 8) throw new MetadataError('Not a TIFF file');
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!le && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw new MetadataError('Not a TIFF file');
  const r = new Reader(bytes, le);
  const magic = r.u16(2);
  if (magic === 43) throw new MetadataError('BigTIFF files are not supported yet');
  if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352 && magic !== 0x55) throw new MetadataError('Not a TIFF file');
  const warnings: string[] = [];
  const budget = { entries: MAX_ENTRIES };
  const ifd0 = readIfd(bytes, le, r.u32(4), warnings, 'IFD0', budget);
  if (!ifd0) throw new MetadataError('TIFF file has no readable first directory');
  const sub = (parent: TIfd | null, tag: number, label: string): TIfd | null => {
    const off = parent ? firstInt(parent, tag, le) : undefined;
    return off ? readIfd(bytes, le, off, warnings, label, budget) : null;
  };
  const exif = sub(ifd0, PTR_EXIF, 'Exif IFD');
  const dot = name.lastIndexOf('.');
  return {
    bytes,
    le,
    variant: variantOf(bytes, le, ifd0, dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''),
    ifd0,
    exif,
    gps: sub(ifd0, PTR_GPS, 'GPS IFD'),
    interop: sub(exif, PTR_INTEROP, 'Interop IFD'),
    warnings,
    budget,
  };
}

/** IFD offsets of the page chain starting at IFD0. */
function pageChain(t: Tiff): TIfd[] {
  const pages = [t.ifd0];
  const seen = new Set([t.ifd0.offset]);
  let next = t.ifd0.next;
  while (next && !seen.has(next) && pages.length < 10_000) {
    seen.add(next);
    const ifd = readIfd(t.bytes, t.le, next, t.warnings, `IFD${pages.length}`, t.budget);
    if (!ifd) break;
    pages.push(ifd);
    next = ifd.next;
  }
  return pages;
}

// ----------------------------------------------------------- extraction

function rawOf(e: TEntry | undefined): Uint8Array | null {
  return e && !e.pinned ? e.data : null;
}

function xmpOf(t: Tiff): { data: XmpPacket | null; error?: string } {
  const raw = rawOf(find(t.ifd0, T_XMP));
  if (!raw) return { data: null };
  try {
    return { data: parseXmp(utf8OrLatin1(raw)) };
  } catch (e) {
    return { data: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

function iptcOf(t: Tiff): IptcData | null {
  const raw = rawOf(find(t.ifd0, T_IPTC));
  if (raw) return parseIptc(raw);
  const irb = rawOf(find(t.ifd0, T_PHOTOSHOP));
  const res = irb ? parseIrb(irb).find((x) => x.id === IRB_IPTC) : undefined;
  return res ? parseIptc(res.data) : null;
}

function isRaw(t: Tiff): boolean {
  return t.variant !== 'tiff';
}

/** EXIF view without structural tags (or DNG calibration), for display. */
function displayExif(t: Tiff): ExifData {
  const show = (e: TEntry) => {
    if (e.pinned || STRUCTURAL.has(e.tag) || FREE_SPACE.has(e.tag) || SPECIAL.has(e.tag) || e.type === IFD) return false;
    if (isRaw(t) && e.tag >= T_DNG_VERSION && !DNG_IDENTIFYING.has(e.tag)) return false;
    if (t.variant === 'rw2' && e.tag < 0x00fe) return false; // Panasonic sensor parameters
    return true;
  };
  const clean = (ifd: TIfd | null): Ifd | null => (ifd ? { entries: ifd.entries.filter((e) => !e.pinned) } : null);
  return {
    le: t.le,
    ifd0: { entries: t.ifd0.entries.filter(show) },
    exif: clean(t.exif),
    gps: clean(t.gps),
    interop: clean(t.interop),
    ifd1: null,
    thumbnail: null,
    makerNoteOffset: null,
    warnings: [],
  };
}

/** Largest image among the pages and their SubIFDs (RAW files keep the full image in a SubIFD). */
function mainImage(t: Tiff, pages: TIfd[]): TIfd {
  let best = t.ifd0;
  let area = -1;
  const visit = (ifd: TIfd, depth: number) => {
    const w = firstInt(ifd, 0x0100, t.le) ?? 0;
    const h = firstInt(ifd, 0x0101, t.le) ?? 0;
    if (w * h > area) {
      area = w * h;
      best = ifd;
    }
    const subs = find(ifd, T_SUBIFDS);
    if (subs && depth < 3) {
      for (const off of ints(subs, t.le).slice(0, 16)) {
        const child = readIfd(t.bytes, t.le, off, [], 'SubIFD', t.budget);
        if (child) visit(child, depth + 1);
      }
    }
  };
  for (const p of pages.slice(0, 16)) visit(p, 0);
  return best;
}

/** Old-style JPEG directory: JPEGInterchangeFormat points at the image data itself. */
const oldJpeg = (ifd: TIfd, le: boolean) => firstInt(ifd, T_COMPRESSION, le) === 6;

/** Byte range of an EXIF-style JPEG thumbnail (JPEGInterchangeFormat in a directory not compressed as old-style JPEG). */
function thumbnailRange(ifd: TIfd, le: boolean, size: number): Range | null {
  if (oldJpeg(ifd, le)) return null;
  const off = firstInt(ifd, T_JPEG_IF, le);
  const len = firstInt(ifd, T_JPEG_IF_LEN, le);
  return off && len && off < size ? [off, Math.min(size, off + len)] : null;
}

/** Directories (pages and their SubIFDs) carrying an EXIF-style JPEG thumbnail. */
function thumbnails(t: Tiff, pages: TIfd[]): Array<{ ifd: TIfd; range: Range | null }> {
  const out: Array<{ ifd: TIfd; range: Range | null }> = [];
  const visit = (ifd: TIfd, depth: number) => {
    if (!oldJpeg(ifd, t.le) && find(ifd, T_JPEG_IF)) out.push({ ifd, range: thumbnailRange(ifd, t.le, t.bytes.length) });
    const subs = find(ifd, T_SUBIFDS);
    if (subs && !subs.pinned && depth < 3) {
      for (const off of ints(subs, t.le).slice(0, 16)) {
        const child = readIfd(t.bytes, t.le, off, [], 'SubIFD', t.budget);
        if (child) visit(child, depth + 1);
      }
    }
  };
  for (const p of pages.slice(0, 64)) visit(p, 0);
  return out;
}

function thumbnailField(t: Tiff, pages: TIfd[], writable: boolean): Field | null {
  const found = thumbnails(t, pages);
  if (!found.length) return null;
  const size = found.reduce((n, x) => n + (x.range ? x.range[1] - x.range[0] : 0), 0);
  const spec = {
    id: 'tiff:thumbnail',
    label: 'Embedded thumbnail',
    sensitivity: 'content' as const,
    tag: 'JPEGInterchangeFormat (0x0201)',
    description: 'A small JPEG copy of the image. It may still show the original, uncropped picture; viewers do not need it.',
  };
  // write() rewrites IFD0 only; thumbnails elsewhere go when stripping.
  const removable = writable && found.every((x) => x.ifd === t.ifd0);
  const first = found[0].range;
  const data = first ? t.bytes.subarray(first[0], first[1]) : null;
  if (found.length === 1 && data && data[0] === 0xff && data[1] === 0xd8) {
    const img = imageValue(data, 'image/jpeg');
    return makeField({ ...spec, kind: 'image' }, img, { editable: false, removable, display: `${img.width ?? '?'}×${img.height ?? '?'} JPEG preview — ${formatBytes(size)}` });
  }
  return rawField(spec.id, spec.label, `${found.length > 1 ? `${found.length} JPEG previews` : 'JPEG preview'} — ${formatBytes(size)}`, { ...spec, removable });
}

export async function readTiff(src: Source): Promise<Metadata> {
  const t = parseTiffFile(await src.bytes(), src.name);
  const pages = pageChain(t);
  const warnings = [...t.warnings];
  const info: InfoItem[] = [];
  const groups: FieldGroup[] = [];
  const writable = !isRaw(t);
  const le = t.le;

  const img = isRaw(t) ? mainImage(t, pages) : t.ifd0;
  const w = firstInt(img, 0x0100, le);
  const h = firstInt(img, 0x0101, le);
  if (w && h) info.push({ label: 'Dimensions', value: `${w} × ${h}` });
  const comp = firstInt(img, T_COMPRESSION, le);
  if (comp !== undefined) info.push({ label: 'Compression', value: COMPRESSION[comp] ?? `Type ${comp}` });
  const photo = firstInt(img, 0x0106, le);
  const bps = find(img, 0x0102);
  if (photo !== undefined) {
    const bits = bps ? ints(bps, le) : [];
    const depth = bits.length ? `, ${bits.every((b) => b === bits[0]) ? bits[0] : bits.join('/')}-bit` : '';
    info.push({ label: 'Color', value: `${PHOTOMETRIC[photo] ?? `Photometric ${photo}`}${depth}` });
  }
  if (!isRaw(t) && pages.length > 1) info.push({ label: 'Pages', value: String(pages.length) });
  const xres = find(t.ifd0, 0x011a);
  const unit = firstInt(t.ifd0, 0x0128, le) ?? 2;
  if (xres && xres.data.length >= 8 && unit !== 1) {
    const r = new Reader(xres.data, le);
    const v = r.u32(4) ? r.u32(0) / r.u32(4) : 0;
    if (v > 0) info.push({ label: 'Resolution', value: `${fmtNum(unit === 3 ? v * 2.54 : v, 1)} dpi` });
  }
  const icc = rawOf(find(t.ifd0, T_ICC));
  const iccDesc = icc ? iccDescription(icc) : null;
  if (icc) info.push({ label: 'Color profile', value: iccDesc ?? 'Embedded ICC profile' });

  groups.push(...exifGroups(displayExif(t), { addable: writable }));

  const xmp = xmpOf(t);
  if (xmp.error) warnings.push(xmp.error);
  groups.push(...xmpGroups(xmp.data ?? { props: [] }, { addable: writable }));

  groups.push(...iptcGroups(iptcOf(t) ?? { datasets: [] }, { addable: writable }));

  const other: Field[] = [];
  if (icc) {
    other.push(
      rawField('tiff:icc', 'Color profile (ICC)', `${iccDesc ?? 'ICC profile'} — ${formatBytes(icc.length)}`, {
        tag: 'ICC_Profile (0x8773)',
        description: 'Removing the color profile can make colors look different.',
      }),
    );
  }
  const irb = rawOf(find(t.ifd0, T_PHOTOSHOP));
  if (irb) {
    const rest = parseIrb(irb).filter((x) => x.id !== IRB_IPTC && x.id !== IRB_IPTC_DIGEST);
    const names = [...new Set(rest.map((x) => IRB_NAMES[x.id] ?? `#${x.id.toString(16)}`))].join(', ');
    other.push(rawField('tiff:photoshop', 'Photoshop resources', names || formatBytes(irb.length), { sensitivity: 'software', tag: 'PhotoshopSettings (0x8649)' }));
  }
  const thumb = thumbnailField(t, pages, writable && comp !== 6);
  if (thumb) other.push(thumb);
  if (other.length) groups.push({ id: 'tiff.other', label: 'Embedded data', source: 'TIFF', fields: other });

  if (isRaw(t)) warnings.push('Camera RAW files can be inspected but not edited or stripped.');
  else if (comp === 6) warnings.push('Old-style JPEG compressed TIFF files cannot be edited.');
  const editable = writable && comp !== 6;
  return {
    format: { id: 'tiff', name: VARIANT_NAMES[t.variant], mime: t.variant === 'dng' ? 'image/x-adobe-dng' : 'image/tiff', category: 'image' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: editable,
    canStrip: editable,
  };
}

// ---------------------------------------------------------------- writing

type Range = [number, number];

/** Appends IFDs and values to the end of the file (word aligned). */
class Appender {
  readonly parts: Uint8Array[] = [];
  constructor(
    public pos: number,
    readonly le: boolean,
  ) {}

  push(b: Uint8Array): number {
    if (this.pos % 2) {
      this.parts.push(new Uint8Array(1));
      this.pos++;
    }
    const at = this.pos;
    this.parts.push(b);
    this.pos += b.length;
    return at;
  }

  /** Write values (new ones appended, unchanged ones referenced in place) then the table. */
  ifd(entries: TEntry[], next: number): number {
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    const valueAt = new Map<TEntry, number>();
    for (const e of sorted) {
      if (e.pinned || e.data.length <= 4) continue;
      valueAt.set(e, e.at ?? this.push(e.data));
    }
    const w = new Writer(this.le, 6 + sorted.length * 12);
    w.u16(sorted.length);
    for (const e of sorted) {
      w.u16(e.tag).u16(e.type).u32(e.count);
      if (e.pinned) w.bytes(e.pinned);
      else if (e.data.length <= 4) w.bytes(e.data).zeros(4 - e.data.length);
      else w.u32(valueAt.get(e)!);
    }
    w.u32(next);
    return this.push(w.finish());
  }
}

const longEntry = (tag: number, values: number[], le: boolean): TEntry => {
  const w = new Writer(le, values.length * 4);
  for (const v of values) w.u32(v);
  return { tag, type: LONG, count: values.length, data: w.finish() };
};

/** Byte ranges of an IFD's table, out-of-line values and image data. */
function ifdRanges(ifd: TIfd, le: boolean, size: number): { ranges: Range[]; complete: boolean } {
  const ranges: Range[] = [[ifd.offset, ifd.offset + tableSize(ifd)]];
  let complete = true;
  for (const e of ifd.entries) if (e.at !== undefined) ranges.push([e.at, e.at + e.data.length]);
  for (const [o, c] of DATA_PAIRS) {
    const offs = find(ifd, o);
    if (!offs || offs.pinned) continue;
    const cnts = find(ifd, c);
    const a = ints(offs, le);
    const n = cnts && !cnts.pinned ? ints(cnts, le) : [];
    if (n.length !== a.length) complete = false;
    a.forEach((off, i) => ranges.push([off, Math.min(size, off + (n[i] ?? 0))]));
  }
  return { ranges, complete };
}

/** Everything reachable from an untouched IFD (sub-IFDs and next pages included). */
function reachable(t: Tiff, offset: number, out: Range[], seen: Set<number>, depth = 0): void {
  let off = offset;
  while (off && !seen.has(off) && depth < 8 && seen.size < 10_000) {
    seen.add(off);
    const ifd = readIfd(t.bytes, t.le, off, [], 'IFD', t.budget);
    if (!ifd) return;
    out.push(...ifdRanges(ifd, t.le, t.bytes.length).ranges);
    for (const e of ifd.entries) {
      if (e.pinned) continue;
      if (e.tag === T_SUBIFDS || e.tag === PTR_EXIF || e.tag === PTR_GPS || e.tag === PTR_INTEROP || e.type === IFD) {
        for (const child of ints(e, t.le)) reachable(t, child, out, seen, depth + 1);
      }
    }
    off = ifd.next;
  }
}

/** Zero `zero` ranges of `buf` except where they overlap `keep`. */
function scrub(buf: Uint8Array, zero: Range[], keep: Range[]): void {
  const k = keep.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  for (const [a0, b0] of zero) {
    let a = Math.max(8, a0);
    const b = Math.min(buf.length, b0);
    for (const [ka, kb] of k) {
      if (kb <= a) continue;
      if (ka >= b) break;
      if (ka > a) buf.fill(0, a, ka);
      a = Math.max(a, kb);
      if (a >= b) break;
    }
    if (a < b) buf.fill(0, a, b);
  }
}

function requireEditable(t: Tiff): void {
  if (isRaw(t)) throw new MetadataError(`Editing ${VARIANT_NAMES[t.variant]} files is not supported (read-only)`);
  if (firstInt(t.ifd0, T_COMPRESSION, t.le) === 6) throw new MetadataError('Old-style JPEG compressed TIFF files cannot be edited');
}

function finish(t: Tiff, buf: Uint8Array, app: Appender, ifd0: number): Blob {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(4, ifd0, t.le);
  return toBlob([buf, ...app.parts], 'image/tiff');
}

/** IPTC bytes in the shape of the existing tag (LONG-padded by default, like Photoshop/ExifTool). */
function iptcEntry(old: TEntry | undefined, data: Uint8Array): TEntry {
  if (old && !old.pinned && old.type !== LONG) return { tag: T_IPTC, type: old.type, count: data.length, data };
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  return { tag: T_IPTC, type: LONG, count: padded.length / 4, data: padded };
}

export async function writeTiffFile(src: Source, edits: Edits): Promise<Blob> {
  const t = parseTiffFile(await src.bytes(), src.name);
  requireEditable(t);
  const le = t.le;
  const keys = [...edits.keys()];

  // ---- EXIF: edit the real IFDs; structural / special tags are off limits.
  const d: ExifData = {
    le,
    ifd0: { entries: [...t.ifd0.entries] },
    exif: t.exif ? { entries: [...t.exif.entries] } : null,
    gps: t.gps ? { entries: [...t.gps.entries] } : null,
    interop: t.interop ? { entries: [...t.interop.entries] } : null,
    ifd1: null,
    thumbnail: null,
    makerNoteOffset: null,
    warnings: [],
  };
  const exifEdits: Edits = new Map();
  for (const [id, e] of edits) {
    const m = /^exif:(ifd0|exif|gps|interop):([0-9a-f]+|location)$/.exec(id);
    if (!m) continue;
    const tag = parseInt(m[2], 16);
    if (m[1] === 'ifd0' && (STRUCTURAL.has(tag) || FREE_SPACE.has(tag) || SPECIAL.has(tag) || tag === T_DNG_VERSION)) continue;
    exifEdits.set(id, e);
  }
  if (edits.get(groupKey('exif'))?.op === 'remove') {
    d.ifd0.entries = d.ifd0.entries.filter((e) => STRUCTURAL.has(e.tag) || FREE_SPACE.has(e.tag) || (SPECIAL.has(e.tag) && e.tag !== PTR_EXIF && e.tag !== PTR_GPS));
    d.exif = d.gps = d.interop = null;
  } else applyExifEdits(d, exifEdits);
  const ifd0 = d.ifd0.entries as TEntry[];
  const set = (tag: number, entry: TEntry | null) => {
    const i = ifd0.findIndex((e) => e.tag === tag);
    if (i >= 0) ifd0.splice(i, 1);
    if (entry) ifd0.push(entry);
  };

  // ---- XMP (tag 700)
  if (edits.get(groupKey('xmp'))?.op === 'remove') set(T_XMP, null);
  else if (keys.some((k) => k.startsWith('xmp:'))) {
    const cur = xmpOf(t);
    if (cur.error) throw new MetadataError(cur.error);
    const p = cur.data ?? { props: [] };
    applyXmpEdits(p, edits);
    const xml = encodeUtf8(serializeXmp(p, { padding: 0 }));
    set(T_XMP, p.props.length ? { tag: T_XMP, type: BYTE, count: xml.length, data: xml } : null);
  }

  // ---- IPTC (tag 33723); a stale copy inside the Photoshop resources is dropped
  const iptcRemoved = edits.get(groupKey('iptc'))?.op === 'remove';
  if (iptcRemoved || keys.some((k) => k.startsWith('iptc:'))) {
    const iptc = iptcOf(t) ?? { datasets: [] };
    if (iptcRemoved) iptc.datasets = [];
    else applyIptcEdits(iptc, edits);
    set(T_IPTC, isEmptyIptc(iptc) ? null : iptcEntry(find(t.ifd0, T_IPTC), serializeIptc(iptc)));
    const irb = rawOf(find(t.ifd0, T_PHOTOSHOP));
    if (irb && parseIrb(irb).some((x) => x.id === IRB_IPTC)) {
      const rest = serializeIrb(parseIrb(irb).filter((x) => x.id !== IRB_IPTC && x.id !== IRB_IPTC_DIGEST));
      set(T_PHOTOSHOP, rest.length ? { tag: T_PHOTOSHOP, type: find(t.ifd0, T_PHOTOSHOP)!.type, count: rest.length, data: rest } : null);
    }
  }

  const removed = (id: string) => edits.get(id)?.op === 'remove';
  if (removed('tiff:icc')) set(T_ICC, null);
  if (removed('tiff:photoshop')) set(T_PHOTOSHOP, null);
  let thumb: Range | null = null;
  if (removed('tiff:thumbnail')) {
    thumb = thumbnailRange(t.ifd0, le, t.bytes.length);
    set(T_JPEG_IF, null);
    set(T_JPEG_IF_LEN, null);
  }

  // ---- lay out: Interop -> Exif -> GPS -> IFD0, appended after the original bytes
  const buf = t.bytes.slice();
  const app = new Appender(buf.length, le);
  const exifEntries = (d.exif?.entries ?? []).filter((e) => e.tag !== PTR_INTEROP) as TEntry[];
  if (d.interop?.entries.length && exifEntries.length) {
    exifEntries.push(longEntry(PTR_INTEROP, [app.ifd(d.interop.entries as TEntry[], 0)], le));
  }
  set(PTR_EXIF, exifEntries.length ? longEntry(PTR_EXIF, [app.ifd(exifEntries, 0)], le) : null);
  set(PTR_GPS, d.gps?.entries.length ? longEntry(PTR_GPS, [app.ifd(d.gps.entries as TEntry[], 0)], le) : null);
  const newIfd0 = app.ifd(ifd0, t.ifd0.next);

  // ---- zero what the old IFD0/Exif/GPS/Interop used and nothing references any more
  const zero: Range[] = [];
  const kept = new Set<TEntry>([...ifd0, ...exifEntries, ...((d.gps?.entries ?? []) as TEntry[]), ...((d.interop?.entries ?? []) as TEntry[])]);
  const keep: Range[] = [];
  for (const old of [t.ifd0, t.exif, t.gps, t.interop]) {
    if (!old) continue;
    zero.push([old.offset, old.offset + tableSize(old)]);
    for (const e of old.entries) if (e.at !== undefined && !kept.has(e)) zero.push([e.at, e.at + e.data.length]);
  }
  if (thumb) zero.push(thumb);
  for (const e of kept) if (e.at !== undefined) keep.push([e.at, e.at + e.data.length]);
  keep.push(...ifdRanges({ offset: 0, entries: ifd0, next: 0 }, le, buf.length).ranges.slice(1));
  const seen = new Set<number>([t.ifd0.offset]);
  reachable(t, t.ifd0.next, keep, seen);
  const subs = ifd0.find((e) => e.tag === T_SUBIFDS);
  if (subs && !subs.pinned) for (const off of ints(subs, le)) reachable(t, off, keep, seen);
  scrub(buf, zero, keep);
  return finish(t, buf, app, newIfd0);
}

/** A stripped IFD: the entries to keep plus its SubIFD chains. */
interface StripNode {
  entries: TEntry[];
  subs: StripNode[][];
}

/** JPEGQTables/DCTables/ACTables: offsets to tables of unknown size. */
const OLD_JPEG_TABLES = [0x0207, 0x0208, 0x0209];

export async function stripTiffFile(src: Source, opts: StripOptions): Promise<Blob> {
  const t = parseTiffFile(await src.bytes(), src.name);
  requireEditable(t);
  const le = t.le;
  const seen = new Set<number>([t.ifd0.offset]);
  /** every original directory that is replaced or dropped */
  const old: TIfd[] = [];
  /** EXIF-style JPEG thumbnails that are dropped */
  const thumbs: Range[] = [];
  const dropSub = (parent: TIfd, tag: number) => {
    const off = firstInt(parent, tag, le);
    if (!off || seen.has(off)) return;
    seen.add(off);
    const sub = readIfd(t.bytes, le, off, [], 'IFD', t.budget);
    if (!sub) return;
    old.push(sub);
    dropSub(sub, PTR_INTEROP);
  };

  // ---- what survives: structural tags (+ orientation / ICC on request), per IFD
  const node = (ifd: TIfd, depth: number): StripNode => {
    const n: StripNode = { entries: [], subs: [] };
    old.push(ifd);
    dropSub(ifd, PTR_EXIF);
    dropSub(ifd, PTR_GPS);
    const dropThumb = !oldJpeg(ifd, le);
    if (dropThumb) {
      const r = thumbnailRange(ifd, le, t.bytes.length);
      if (r) thumbs.push(r);
    }
    for (const e of ifd.entries) {
      if (dropThumb && (e.tag === T_JPEG_IF || e.tag === T_JPEG_IF_LEN)) continue;
      if (e.tag === T_SUBIFDS && !e.pinned && depth < 4) {
        for (const off of ints(e, le)) {
          if (seen.has(off)) continue;
          seen.add(off);
          const kid = readIfd(t.bytes, le, off, [], 'SubIFD', t.budget);
          if (kid) n.subs.push(chain(kid, depth + 1));
        }
        continue;
      }
      const orientation = e.tag === T_ORIENTATION && opts.keepOrientation && ints(e, le)[0] !== 1;
      const icc = e.tag === T_ICC && opts.keepColorProfile;
      if ((STRUCTURAL.has(e.tag) && e.tag !== T_SUBIFDS && !e.pinned) || orientation || icc) n.entries.push(e);
    }
    return n;
  };
  const chain = (first: TIfd, depth: number): StripNode[] => {
    const out = [node(first, depth)];
    let off = first.next;
    while (off && !seen.has(off) && out.length < 10_000) {
      seen.add(off);
      const ifd = readIfd(t.bytes, le, off, [], 'IFD', t.budget);
      if (!ifd) break;
      out.push(node(ifd, depth));
      off = ifd.next;
    }
    return out;
  };
  const pages = chain(t.ifd0, 0);
  const all: StripNode[] = [];
  const flatten = (c: StripNode[]) => c.forEach((n) => (all.push(n), n.subs.forEach(flatten)));
  flatten(pages);

  const keep: Range[] = [];
  let complete = true;
  for (const n of all) {
    const r = ifdRanges({ offset: 0, entries: n.entries, next: 0 }, le, t.bytes.length);
    keep.push(...r.ranges.slice(1));
    complete &&= r.complete && !n.entries.some((e) => OLD_JPEG_TABLES.includes(e.tag));
  }
  // The compact rebuild copies each distinct image span; spans adding up to more than the file
  // overlap (crafted files only) and would blow up the output: keep those in place instead.
  if (complete) {
    const spans = new Map<string, number>();
    for (const n of all) {
      for (const [o, c] of DATA_PAIRS) {
        const offs = find(n, o);
        const counts = find(n, c);
        if (!offs || !counts) continue;
        const lens = ints(counts, le);
        ints(offs, le).forEach((off, i) => spans.set(`${off}:${lens[i]}`, lens[i] ?? 0));
      }
    }
    let total = 0;
    for (const len of spans.values()) total += len;
    complete = total <= t.bytes.length;
  }

  // ---- emit chains back to front so every table knows its successor
  const emit = (app: Appender, c: StripNode[], prepare: (n: StripNode) => TEntry[]): number => {
    let next = 0;
    for (let i = c.length - 1; i >= 0; i--) {
      const entries = prepare(c[i]);
      const subs = c[i].subs.map((s) => emit(app, s, prepare));
      if (subs.length) entries.push(longEntry(T_SUBIFDS, subs, le));
      next = app.ifd(entries, next);
    }
    return next;
  };

  if (complete) {
    // Every needed byte is known: rebuild a compact file (image data copied as is).
    const app = new Appender(8, le);
    const copied = new Map<string, number>();
    const copy = (off: number, len: number) => {
      const key = `${off}:${len}`;
      if (!copied.has(key)) copied.set(key, app.push(t.bytes.subarray(off, off + len)));
      return copied.get(key)!;
    };
    const prepare = (n: StripNode): TEntry[] => {
      const entries: TEntry[] = n.entries.map((e) => ({ tag: e.tag, type: e.type, count: e.count, data: e.data }));
      for (const [o, c] of DATA_PAIRS) {
        const oi = entries.findIndex((e) => e.tag === o);
        const ce = entries.find((e) => e.tag === c);
        if (oi < 0 || !ce) continue;
        const counts = ints(ce, le);
        const offs = ints(entries[oi], le).map((off, i) => copy(off, counts[i]));
        const short = entries[oi].type === SHORT && offs.every((v) => v <= 0xffff);
        const w = new Writer(le, offs.length * 4);
        for (const v of offs) if (short) w.u16(v); else w.u32(v);
        entries[oi] = { tag: o, type: short ? SHORT : LONG, count: offs.length, data: w.finish() };
      }
      return entries;
    };
    // Image data first, in page order; then the directories.
    const prepared = new Map(all.map((n) => [n, prepare(n)]));
    const first = emit(app, pages, (n) => prepared.get(n)!);
    const head = new Writer(le, 8);
    head.ascii(le ? 'II' : 'MM').u16(42).u32(first);
    return toBlob([head.finish(), ...app.parts], 'image/tiff');
  }

  // Some image data has an unknown extent: keep everything in place, append the
  // new directories and zero the old metadata directories and values.
  const buf = t.bytes.slice();
  const app = new Appender(buf.length, le);
  const first = emit(app, pages, (n) => [...n.entries]);
  const zero: Range[] = [...thumbs];
  for (const o of old) {
    zero.push([o.offset, o.offset + tableSize(o)]);
    for (const e of o.entries) if (e.at !== undefined) zero.push([e.at, e.at + e.data.length]);
  }
  scrub(buf, zero, keep);
  return finish(t, buf, app, first);
}

export const tiffHandler: FormatHandler = {
  id: 'tiff',
  name: 'TIFF image',
  category: 'image',
  extensions: ['tif', 'tiff', ...Object.keys(RAW_EXT)],
  mime: 'image/tiff',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if (h.length < 8) return this.extensions.includes(ctx.ext) ? 1 : 0;
    const le = h[0] === 0x49 && h[1] === 0x49;
    if (!le && !(h[0] === 0x4d && h[1] === 0x4d)) return this.extensions.includes(ctx.ext) ? 1 : 0;
    const r = new Reader(h, le);
    const magic = r.u16(2);
    if (magic === 42 || magic === 0x4f52 || magic === 0x5352 || magic === 0x55) {
      const first = r.u32(4);
      return first >= 8 && first < ctx.size ? 3 : 2;
    }
    if (magic === 43) return 2; // BigTIFF: claimed so the user gets a clear message
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readTiff,
  write: writeTiffFile,
  strip: stripTiffFile,
};

