/**
 * TIFF/EXIF structure parser and serializer.
 *
 * Values are kept as raw bytes in the block's original byte order so
 * untouched tags round-trip exactly. The writer lays out IFD0, Exif, Interop,
 * GPS and IFD1 (+thumbnail) around the MakerNote, which keeps its original
 * offset because many maker notes contain absolute offsets.
 */

import { Reader, Writer, latin1, trimNul } from '../core/binary';
import { MetadataError } from '../core/types';
import { UNRELOCATABLE, type IfdName } from './tags';

export const BYTE = 1;
export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const SBYTE = 6;
export const UNDEFINED = 7;
export const SSHORT = 8;
export const SLONG = 9;
export const SRATIONAL = 10;
export const FLOAT = 11;
export const DOUBLE = 12;
export const IFD = 13;

export const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

export interface Entry {
  tag: number;
  type: number;
  count: number;
  /** value bytes in the block's byte order */
  data: Uint8Array;
}

export interface Ifd {
  entries: Entry[];
}

export interface ExifData {
  le: boolean;
  ifd0: Ifd;
  exif: Ifd | null;
  gps: Ifd | null;
  interop: Ifd | null;
  ifd1: Ifd | null;
  thumbnail: Uint8Array | null;
  /** Original offset of the MakerNote value (relative to TIFF header) */
  makerNoteOffset: number | null;
  warnings: string[];
}

export const PTR_EXIF = 0x8769;
export const PTR_GPS = 0x8825;
export const PTR_INTEROP = 0xa005;
export const THUMB_OFFSET = 0x0201;
export const THUMB_LENGTH = 0x0202;
export const MAKERNOTE = 0x927c;

export function isTiffHeader(b: Uint8Array, at = 0): boolean {
  return (
    b.length >= at + 8 &&
    ((b[at] === 0x49 && b[at + 1] === 0x49 && b[at + 2] === 0x2a && b[at + 3] === 0) ||
      (b[at] === 0x4d && b[at + 1] === 0x4d && b[at + 2] === 0 && b[at + 3] === 0x2a))
  );
}

interface IfdRead {
  ifd: Ifd;
  next: number;
  makerNoteOffset?: number;
}

function readIfd(r: Reader, offset: number, warnings: string[], name: string, budget: { bytes: number }): IfdRead | null {
  if (offset < 8 || offset + 2 > r.length) {
    warnings.push(`${name}: invalid offset ${offset}`);
    return null;
  }
  const n = r.u16(offset);
  if (n > 1000 || offset + 2 + n * 12 > r.length) {
    warnings.push(`${name}: corrupt directory`);
    return null;
  }
  const entries: Entry[] = [];
  let makerNoteOffset: number | undefined;
  for (let i = 0; i < n; i++) {
    const p = offset + 2 + i * 12;
    const tag = r.u16(p);
    const type = r.u16(p + 2);
    const count = r.u32(p + 4);
    const size = TYPE_SIZE[type];
    if (!size) {
      warnings.push(`${name}: tag 0x${tag.toString(16)} has unknown type ${type}`);
      continue;
    }
    const total = size * count;
    let data: Uint8Array;
    if (total <= 4) {
      data = r.bytes.slice(p + 8, p + 8 + total);
    } else {
      const vo = r.u32(p + 8);
      if (vo + total > r.length || total > 64 * 1024 * 1024) {
        warnings.push(`${name}: tag 0x${tag.toString(16)} points outside the EXIF block`);
        continue;
      }
      if (total > budget.bytes) {
        warnings.push(`${name}: tag 0x${tag.toString(16)} overlaps other values and was ignored`);
        continue;
      }
      budget.bytes -= total;
      data = r.bytes.slice(vo, vo + total);
      if (tag === MAKERNOTE) makerNoteOffset = vo;
    }
    entries.push({ tag, type, count, data });
  }
  const next = offset + 2 + n * 12 + 4 <= r.length ? r.u32(offset + 2 + n * 12) : 0;
  return { ifd: { entries }, next, makerNoteOffset };
}

/** Parse a TIFF block ("II*\0…" or "MM\0*…"). */
export function parseTiff(b: Uint8Array): ExifData {
  if (!isTiffHeader(b)) throw new MetadataError('Invalid EXIF/TIFF header');
  const le = b[0] === 0x49;
  const r = new Reader(b, le);
  const warnings: string[] = [];
  // Values are copied: real ones occupy distinct ranges, so their total stays below the block size.
  const budget = { bytes: 2 * b.length + 65536 };
  const first = r.u32(4);
  const res0 = readIfd(r, first, warnings, 'IFD0', budget);
  if (!res0) throw new MetadataError('EXIF block has no readable IFD0');
  const d: ExifData = {
    le,
    ifd0: res0.ifd,
    exif: null,
    gps: null,
    interop: null,
    ifd1: null,
    thumbnail: null,
    makerNoteOffset: null,
    warnings,
  };
  const seen = new Set([first]);
  const sub = (ifd: Ifd, tag: number, name: string): IfdRead | null => {
    const e = ifd.entries.find((x) => x.tag === tag);
    if (!e) return null;
    const off = entryInts(e, le)[0];
    if (off === undefined || seen.has(off)) return null;
    seen.add(off);
    return readIfd(r, off, warnings, name, budget);
  };
  const exifRead = sub(d.ifd0, PTR_EXIF, 'Exif IFD');
  d.exif = exifRead?.ifd ?? null;
  d.makerNoteOffset = exifRead?.makerNoteOffset ?? null;
  d.gps = sub(d.ifd0, PTR_GPS, 'GPS IFD')?.ifd ?? null;
  if (d.exif) d.interop = sub(d.exif, PTR_INTEROP, 'Interop IFD')?.ifd ?? null;
  if (res0.next && !seen.has(res0.next) && res0.next < b.length) {
    const res1 = readIfd(r, res0.next, warnings, 'IFD1', budget);
    if (res1) {
      d.ifd1 = res1.ifd;
      const off = getEntry(d.ifd1, THUMB_OFFSET);
      const len = getEntry(d.ifd1, THUMB_LENGTH);
      if (off && len) {
        const o = entryInts(off, le)[0];
        const l = entryInts(len, le)[0];
        if (o + l <= b.length && l > 0) d.thumbnail = b.slice(o, o + l);
        else warnings.push('Thumbnail points outside the EXIF block');
      }
    }
  }
  return d;
}

export function getEntry(ifd: Ifd | null, tag: number): Entry | undefined {
  return ifd?.entries.find((e) => e.tag === tag);
}

export function setEntry(ifd: Ifd, entry: Entry): void {
  const i = ifd.entries.findIndex((e) => e.tag === entry.tag);
  if (i >= 0) ifd.entries[i] = entry;
  else ifd.entries.push(entry);
}

export function removeEntry(ifd: Ifd | null, tag: number): boolean {
  if (!ifd) return false;
  const n = ifd.entries.length;
  ifd.entries = ifd.entries.filter((e) => e.tag !== tag);
  return ifd.entries.length !== n;
}

// ------------------------------------------------------------ value codecs

export function entryInts(e: Entry, le: boolean): number[] {
  const r = new Reader(e.data, le);
  const out: number[] = [];
  const n = Math.min(e.count, 4096);
  for (let i = 0; i < n; i++) {
    switch (e.type) {
      case BYTE:
      case UNDEFINED:
      case ASCII:
        out.push(r.u8(i));
        break;
      case SBYTE:
        out.push(r.i8(i));
        break;
      case SHORT:
        out.push(r.u16(i * 2));
        break;
      case SSHORT:
        out.push(r.i16(i * 2));
        break;
      case LONG:
      case IFD:
        out.push(r.u32(i * 4));
        break;
      case SLONG:
        out.push(r.i32(i * 4));
        break;
      default:
        return entryNumbers(e, le);
    }
  }
  return out;
}

export function entryRationals(e: Entry, le: boolean): Array<[number, number]> {
  const r = new Reader(e.data, le);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(e.count, 1024); i++) {
    if (e.type === RATIONAL) out.push([r.u32(i * 8), r.u32(i * 8 + 4)]);
    else if (e.type === SRATIONAL) out.push([r.i32(i * 8), r.i32(i * 8 + 4)]);
  }
  return out;
}

/** Numeric values as floats (rationals divided out). */
export function entryNumbers(e: Entry, le: boolean): number[] {
  if (e.type === RATIONAL || e.type === SRATIONAL) {
    return entryRationals(e, le).map(([n, d]) => (d === 0 ? (n === 0 ? 0 : NaN) : n / d));
  }
  const r = new Reader(e.data, le);
  if (e.type === FLOAT) return Array.from({ length: Math.min(e.count, 1024) }, (_, i) => r.f32(i * 4));
  if (e.type === DOUBLE) return Array.from({ length: Math.min(e.count, 1024) }, (_, i) => r.f64(i * 8));
  return entryInts(e, le);
}

export function entryString(e: Entry): string {
  return trimNul(latin1(e.data)).trim();
}

/** ASCII entries are nominally 7-bit but in practice frequently UTF-8. */
export function entryText(e: Entry): string {
  const nul = e.data.indexOf(0);
  const bytes = nul >= 0 ? e.data.subarray(0, nul) : e.data;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    return latin1(bytes).trim();
  }
}

export function makeAscii(tag: number, s: string): Entry {
  const bytes = new TextEncoder().encode(s);
  const data = new Uint8Array(bytes.length + 1);
  data.set(bytes);
  return { tag, type: ASCII, count: data.length, data };
}

export function makeShorts(tag: number, values: number[], le: boolean): Entry {
  const w = new Writer(le, values.length * 2);
  for (const v of values) w.u16(v);
  return { tag, type: SHORT, count: values.length, data: w.finish() };
}

export function makeLongs(tag: number, values: number[], le: boolean): Entry {
  const w = new Writer(le, values.length * 4);
  for (const v of values) w.u32(v);
  return { tag, type: LONG, count: values.length, data: w.finish() };
}

export function makeBytes(tag: number, values: Uint8Array | number[], type = BYTE): Entry {
  const data = values instanceof Uint8Array ? values : Uint8Array.from(values);
  return { tag, type, count: data.length, data };
}

export function makeRationals(tag: number, values: Array<[number, number]>, le: boolean, signed = false): Entry {
  const w = new Writer(le, values.length * 8);
  for (const [n, d] of values) {
    if (signed) w.i32(n).i32(d);
    else w.u32(n).u32(d);
  }
  return { tag, type: signed ? SRATIONAL : RATIONAL, count: values.length, data: w.finish() };
}

/** Best rational approximation with a bounded denominator. */
export function toRational(x: number, maxDen = 1_000_000, signed = false): [number, number] {
  if (!Number.isFinite(x)) return [0, 1];
  if (!signed && x < 0) x = 0;
  if (Number.isInteger(x)) return [x, 1];
  // continued fractions
  let [h1, h0, k1, k0] = [1, 0, 0, 1];
  let b = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(x - h1 / k1) < 1e-10) break;
    b = 1 / (b - a);
    if (!Number.isFinite(b)) break;
  }
  const lim = signed ? 0x7fffffff : 0xffffffff;
  if (Math.abs(h1) > lim) return [Math.sign(h1) * lim, 1];
  return [h1, k1];
}

// ----------------------------------------------------------------- writing

interface Block {
  name: IfdName;
  ifd: Ifd;
}

/**
 * Serialize to a TIFF block. Empty Exif/GPS/Interop IFDs are dropped along
 * with their pointers; IFD1 is dropped when it has no thumbnail.
 */
export function writeTiff(d: ExifData): Uint8Array {
  const le = d.le;
  const clean = (ifd: Ifd | null, extraDrop: number[] = []): Ifd | null => {
    if (!ifd) return null;
    const entries = ifd.entries.filter((e) => !UNRELOCATABLE.has(e.tag) && e.type !== IFD && !extraDrop.includes(e.tag));
    return { entries };
  };
  const interop = clean(d.interop);
  const gps = clean(d.gps);
  const exif = clean(d.exif, [PTR_INTEROP]);
  const ifd0 = clean(d.ifd0, [PTR_EXIF, PTR_GPS, THUMB_OFFSET, THUMB_LENGTH])!;
  const ifd1 = d.thumbnail && d.ifd1 ? clean(d.ifd1, [THUMB_OFFSET, THUMB_LENGTH, PTR_EXIF, PTR_GPS]) : null;

  const hasInterop = !!interop?.entries.length;
  if (exif && hasInterop) exif.entries.push({ tag: PTR_INTEROP, type: LONG, count: 1, data: new Uint8Array(4) });
  const hasExif = !!exif?.entries.length;
  const hasGps = !!gps?.entries.length;
  if (hasExif) ifd0.entries.push({ tag: PTR_EXIF, type: LONG, count: 1, data: new Uint8Array(4) });
  if (hasGps) ifd0.entries.push({ tag: PTR_GPS, type: LONG, count: 1, data: new Uint8Array(4) });
  if (ifd1) {
    ifd1.entries.push({ tag: THUMB_OFFSET, type: LONG, count: 1, data: new Uint8Array(4) });
    ifd1.entries.push({ tag: THUMB_LENGTH, type: LONG, count: 1, data: new Uint8Array(4) });
  }

  const blocks: Block[] = [{ name: 'ifd0', ifd: ifd0 }];
  if (hasExif) blocks.push({ name: 'exif', ifd: exif! });
  if (hasInterop && hasExif) blocks.push({ name: 'interop', ifd: interop! });
  if (hasGps) blocks.push({ name: 'gps', ifd: gps! });
  if (ifd1) blocks.push({ name: 'ifd1', ifd: ifd1 });
  for (const b of blocks) b.ifd.entries.sort((x, y) => x.tag - y.tag);

  // ---- layout pass: assign offsets to IFDs and out-of-line values. The maker
  // note keeps its original offset, since many contain absolute offsets;
  // everything else is packed around it.
  const makerNote = exif?.entries.find((e) => e.tag === MAKERNOTE && e.data.length > 4);
  const orig = d.makerNoteOffset;
  const pinned = makerNote && orig !== null && orig >= 8 ? { start: orig, end: orig + makerNote.data.length } : null;
  let pos = 8;
  const alloc = (size: number): number => {
    pos += pos & 1;
    if (pinned && pos < pinned.end && pos + size > pinned.start) pos = pinned.end + (pinned.end & 1);
    pos += size;
    return pos - size;
  };
  const ifdOffset = new Map<IfdName, number>();
  const valueOffset = new Map<Entry, number>();
  if (pinned) valueOffset.set(makerNote!, pinned.start);
  for (const b of blocks) {
    ifdOffset.set(b.name, alloc(2 + b.ifd.entries.length * 12 + 4));
    for (const e of b.ifd.entries) if (e.data.length > 4 && !valueOffset.has(e)) valueOffset.set(e, alloc(e.data.length));
  }
  const thumbOffset = ifd1 && d.thumbnail ? alloc(d.thumbnail.length) : 0;

  // ---- fill in pointer values
  const setLong = (ifd: Ifd, tag: number, v: number) => {
    const e = ifd.entries.find((x) => x.tag === tag);
    if (e) e.data = makeLongs(tag, [v], le).data;
  };
  if (hasExif) setLong(ifd0, PTR_EXIF, ifdOffset.get('exif')!);
  if (hasGps) setLong(ifd0, PTR_GPS, ifdOffset.get('gps')!);
  if (hasInterop && hasExif) setLong(exif!, PTR_INTEROP, ifdOffset.get('interop')!);
  if (ifd1 && d.thumbnail) {
    setLong(ifd1, THUMB_OFFSET, thumbOffset);
    setLong(ifd1, THUMB_LENGTH, d.thumbnail.length);
  }

  // ---- emit, in offset order
  const pieces: Array<[number, Uint8Array]> = [];
  for (const b of blocks) {
    const iw = new Writer(le, 2 + b.ifd.entries.length * 12 + 4);
    iw.u16(b.ifd.entries.length);
    for (const e of b.ifd.entries) {
      iw.u16(e.tag).u16(e.type).u32(e.count);
      if (e.data.length <= 4) iw.bytes(e.data).zeros(4 - e.data.length);
      else iw.u32(valueOffset.get(e)!);
    }
    iw.u32(b.name === 'ifd0' && ifd1 ? ifdOffset.get('ifd1')! : 0);
    pieces.push([ifdOffset.get(b.name)!, iw.finish()]);
    for (const e of b.ifd.entries) if (e.data.length > 4) pieces.push([valueOffset.get(e)!, e.data]);
  }
  if (ifd1 && d.thumbnail) pieces.push([thumbOffset, d.thumbnail]);
  pieces.sort((x, y) => x[0] - y[0]);
  const w = new Writer(le, Math.max(pos, pinned?.end ?? 0) + 16);
  w.ascii(le ? 'II' : 'MM').u16(42).u32(ifdOffset.get('ifd0')!);
  for (const [at, bytes] of pieces) {
    if (w.pos < at) w.zeros(at - w.pos);
    w.bytes(bytes);
  }
  return w.finish();
}

export function emptyExif(le = false): ExifData {
  return {
    le,
    ifd0: { entries: [] },
    exif: null,
    gps: null,
    interop: null,
    ifd1: null,
    thumbnail: null,
    makerNoteOffset: null,
    warnings: [],
  };
}

export function isEmptyExif(d: ExifData): boolean {
  const meaningful = (ifd: Ifd | null) =>
    !!ifd && ifd.entries.some((e) => ![PTR_EXIF, PTR_GPS, PTR_INTEROP, THUMB_OFFSET, THUMB_LENGTH].includes(e.tag));
  return !meaningful(d.ifd0) && !meaningful(d.exif) && !meaningful(d.gps) && !d.thumbnail;
}
