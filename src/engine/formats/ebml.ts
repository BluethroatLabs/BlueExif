/**
 * EBML primitives (the binary XML used by Matroska / WebM): variable-length
 * ids and sizes, "unknown" sizes, element parsing, value decoding, element
 * builders (incl. Void padding and CRC-32), and a windowed async reader for
 * walking large files without loading them.
 */

import { concat, crc32, encodeUtf8, utf8OrLatin1 } from '../core/binary';
import { MetadataError, type Source } from '../core/types';

export const ID_EBML = 0x1a45dfa3;
export const ID_VOID = 0xec;
export const ID_CRC32 = 0xbf;

/** Marker for elements whose size field is all ones ("unknown size"). */
export const UNKNOWN_SIZE = -1;

export interface ElementHeader {
  /** element id including its length-marker bits, e.g. 0x1A45DFA3 */
  id: number;
  /** payload size, or UNKNOWN_SIZE */
  size: number;
  /** bytes taken by id + size */
  headerSize: number;
  /** bytes taken by the size field alone */
  sizeLength: number;
}

export interface EbmlElement extends ElementHeader {
  /** offset of the element's first byte within the parsed buffer */
  offset: number;
  /** payload, bounded by the parent for unknown sizes */
  data: Uint8Array;
  /** the whole element, header included */
  raw: Uint8Array;
}

/** Length of an element id from its first byte (0 = invalid). */
export function idLength(first: number): number {
  if (first & 0x80) return 1;
  if (first & 0x40) return 2;
  if (first & 0x20) return 3;
  if (first & 0x10) return 4;
  return 0;
}

/** Length of a size vint from its first byte (0 = invalid). */
export function vintLength(first: number): number {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

/** Parse an element header at `pos`; null when truncated or malformed. */
export function readHeader(b: Uint8Array, pos: number): ElementHeader | null {
  if (pos >= b.length) return null;
  const il = idLength(b[pos]);
  if (!il || pos + il >= b.length) return null;
  let id = 0;
  for (let i = 0; i < il; i++) id = id * 256 + b[pos + i];
  const sp = pos + il;
  const sl = vintLength(b[sp]);
  if (!sl || sp + sl > b.length) return null;
  const mask = 0xff >> sl;
  let v = b[sp] & mask;
  let allOnes = v === mask;
  for (let i = 1; i < sl; i++) {
    v = v * 256 + b[sp + i];
    if (b[sp + i] !== 0xff) allOnes = false;
  }
  return { id, size: allOnes ? UNKNOWN_SIZE : v, headerSize: il + sl, sizeLength: sl };
}

/** Child elements of a master payload. Stops at the first malformed or overflowing header. */
export function parseChildren(b: Uint8Array, start = 0, end = b.length): EbmlElement[] {
  const out: EbmlElement[] = [];
  let p = start;
  while (p < end) {
    const h = readHeader(b.subarray(0, end), p);
    if (!h) break;
    const dataStart = p + h.headerSize;
    const stop = h.size === UNKNOWN_SIZE ? end : dataStart + h.size;
    if (stop > end) break;
    out.push({ ...h, offset: p, data: b.subarray(dataStart, stop), raw: b.subarray(p, stop) });
    p = stop;
  }
  return out;
}

/** First child with `id`, or undefined. */
export function child(list: EbmlElement[], id: number): EbmlElement | undefined {
  return list.find((e) => e.id === id);
}

// ------------------------------------------------------------------- values

export function readUint(d: Uint8Array): number {
  let v = 0;
  for (const x of d) v = v * 256 + x;
  return v;
}

export function readBigUint(d: Uint8Array): bigint {
  let v = 0n;
  for (const x of d) v = (v << 8n) | BigInt(x);
  return v;
}

/** Signed big-endian integer (EBML "int"/"date"). */
export function readBigInt(d: Uint8Array): bigint {
  if (!d.length) return 0n;
  const u = readBigUint(d);
  const bits = BigInt(d.length * 8);
  return d[0] & 0x80 ? u - (1n << bits) : u;
}

export function readFloat(d: Uint8Array): number {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length === 4) return v.getFloat32(0);
  if (d.length === 8) return v.getFloat64(0);
  return 0;
}

/** UTF-8 string with trailing NULs removed. */
export function readText(d: Uint8Array): string {
  let n = d.length;
  while (n > 0 && d[n - 1] === 0) n--;
  return utf8OrLatin1(d.subarray(0, n));
}

// ----------------------------------------------------------------- building

export function encodeId(id: number): Uint8Array {
  const n = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const out = new Uint8Array(n);
  let v = id;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

/** Encode a size vint; `width` 0 = shortest form. Throws if it does not fit. */
export function encodeSize(n: number, width = 0): Uint8Array {
  let w = width;
  if (!w) {
    w = 1;
    while (w < 8 && n >= 2 ** (7 * w) - 1) w++;
  }
  if (n < 0 || n >= 2 ** (7 * w) - 1 || w > 8) throw new MetadataError(`EBML size ${n} does not fit in ${w} bytes`);
  const out = new Uint8Array(w);
  let v = n;
  for (let i = w - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (w - 1);
  return out;
}

/** Size field meaning "unknown" with the given width. */
export function unknownSize(width = 8): Uint8Array {
  const out = new Uint8Array(width).fill(0xff);
  out[0] = (0x80 >> (width - 1)) | (0xff >> width);
  return out;
}

/** id + size header for a payload of `size` bytes. */
export function header(id: number, size: number, sizeWidth = 0): Uint8Array {
  return concat([encodeId(id), encodeSize(size, sizeWidth)]);
}

export function element(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = payload.length === 1 ? payload[0] : concat(payload);
  return concat([header(id, body.length), body]);
}

/** Unsigned integer element; `width` 0 = shortest form (at least one byte). */
export function uintElement(id: number, value: number | bigint, width = 0): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) throw new MetadataError('Negative value for an unsigned EBML element');
  let n = width;
  if (!n) {
    n = 1;
    while (n < 8 && v >= 1n << BigInt(8 * n)) n++;
  }
  const out = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v) throw new MetadataError(`Value ${value} does not fit in ${n} bytes`);
  return element(id, out);
}

/** Signed 8-byte integer element (EBML "date"). */
export function int64Element(id: number, value: bigint): Uint8Array {
  let v = BigInt.asUintN(64, value);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return element(id, out);
}

export function stringElement(id: number, s: string): Uint8Array {
  return element(id, encodeUtf8(s));
}

export function floatElement(id: number, v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return element(id, b);
}

/** A Void element occupying exactly `total` bytes (>= 2). */
export function voidElement(total: number): Uint8Array {
  for (let w = 1; w <= 8; w++) {
    const payload = total - 1 - w;
    if (payload >= 0 && payload < 2 ** (7 * w) - 1) {
      const out = new Uint8Array(total);
      out[0] = ID_VOID;
      out.set(encodeSize(payload, w), 1);
      return out;
    }
  }
  throw new MetadataError(`Cannot build a ${total}-byte Void element`);
}

/** CRC-32 element over the concatenated `children` (stored little-endian). */
export function crcElement(children: Uint8Array[]): Uint8Array {
  let c = 0;
  for (const ch of children) c = crc32(ch, c);
  const out = new Uint8Array([ID_CRC32, 0x84, 0, 0, 0, 0]);
  new DataView(out.buffer).setUint32(2, c, true);
  return out;
}

/** Master element from serialized children, optionally led by a CRC-32. */
export function master(id: number, children: Uint8Array[], crc = false): Uint8Array {
  return element(id, ...(crc ? [crcElement(children), ...children] : children));
}

// ------------------------------------------------------------ async reading

/**
 * Random-access element reader over a Source with a small read-ahead window,
 * so walking many element headers costs few Blob reads.
 */
export class EbmlCursor {
  private buf: Uint8Array = new Uint8Array(0);
  private at = 0;

  constructor(
    readonly src: Source,
    private readonly window = 4096,
  ) {}

  get size(): number {
    return this.src.size;
  }

  /** `len` bytes at `pos` (fewer at end of file). */
  async bytes(pos: number, len: number): Promise<Uint8Array> {
    if (pos >= this.at && pos + len <= this.at + this.buf.length) return this.buf.subarray(pos - this.at, pos - this.at + len);
    if (len > this.window) return this.src.read(pos, len);
    this.buf = await this.src.read(pos, this.window);
    this.at = pos;
    return this.buf.subarray(0, Math.min(len, this.buf.length));
  }

  /** Element header at `pos`, or null if truncated/malformed. */
  async header(pos: number): Promise<ElementHeader | null> {
    return readHeader(await this.bytes(pos, 12), 0);
  }
}
