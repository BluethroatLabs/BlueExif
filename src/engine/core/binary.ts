/** Low-level byte helpers shared by all format handlers. */

import { Gunzip, Inflate, Unzlib } from 'fflate';
import { MetadataError } from './types';

export class Reader {
  readonly view: DataView;
  pos: number;

  constructor(
    readonly bytes: Uint8Array,
    public le = false,
    pos = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  ensure(n: number, at = this.pos): void {
    if (at < 0 || at + n > this.bytes.length) {
      throw new MetadataError(`Unexpected end of data (need ${n} bytes at ${at}, have ${this.bytes.length})`);
    }
  }

  skip(n: number): void {
    this.ensure(n);
    this.pos += n;
  }

  u8(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(1, p);
    if (at === undefined) this.pos += 1;
    return this.view.getUint8(p);
  }

  i8(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(1, p);
    if (at === undefined) this.pos += 1;
    return this.view.getInt8(p);
  }

  u16(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(2, p);
    if (at === undefined) this.pos += 2;
    return this.view.getUint16(p, this.le);
  }

  i16(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(2, p);
    if (at === undefined) this.pos += 2;
    return this.view.getInt16(p, this.le);
  }

  u24(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(3, p);
    if (at === undefined) this.pos += 3;
    const b = this.bytes;
    return this.le ? b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) : (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
  }

  u32(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(4, p);
    if (at === undefined) this.pos += 4;
    return this.view.getUint32(p, this.le);
  }

  i32(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(4, p);
    if (at === undefined) this.pos += 4;
    return this.view.getInt32(p, this.le);
  }

  /** 64-bit unsigned as a JS number (exact up to 2^53). */
  u64(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(8, p);
    if (at === undefined) this.pos += 8;
    const hi = this.view.getUint32(this.le ? p + 4 : p, this.le);
    const lo = this.view.getUint32(this.le ? p : p + 4, this.le);
    return hi * 0x1_0000_0000 + lo;
  }

  f32(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(4, p);
    if (at === undefined) this.pos += 4;
    return this.view.getFloat32(p, this.le);
  }

  f64(at?: number): number {
    const p = at ?? this.pos;
    this.ensure(8, p);
    if (at === undefined) this.pos += 8;
    return this.view.getFloat64(p, this.le);
  }

  take(n: number): Uint8Array {
    this.ensure(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  at(offset: number, n: number): Uint8Array {
    this.ensure(n, offset);
    return this.bytes.subarray(offset, offset + n);
  }

  ascii(n: number): string {
    return latin1(this.take(n));
  }

  fourcc(at?: number): string {
    const p = at ?? this.pos;
    this.ensure(4, p);
    if (at === undefined) this.pos += 4;
    return latin1(this.bytes.subarray(p, p + 4));
  }
}

/** Growable byte buffer writer. */
export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(
    public le = false,
    initial = 1024,
  ) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  private grow(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.grow(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.grow(2);
    this.view.setUint16(this.pos, v, this.le);
    this.pos += 2;
    return this;
  }

  i16(v: number): this {
    this.grow(2);
    this.view.setInt16(this.pos, v, this.le);
    this.pos += 2;
    return this;
  }

  u24(v: number): this {
    this.grow(3);
    if (this.le) {
      this.buf[this.pos] = v & 0xff;
      this.buf[this.pos + 1] = (v >> 8) & 0xff;
      this.buf[this.pos + 2] = (v >> 16) & 0xff;
    } else {
      this.buf[this.pos] = (v >> 16) & 0xff;
      this.buf[this.pos + 1] = (v >> 8) & 0xff;
      this.buf[this.pos + 2] = v & 0xff;
    }
    this.pos += 3;
    return this;
  }

  u32(v: number): this {
    this.grow(4);
    this.view.setUint32(this.pos, v >>> 0, this.le);
    this.pos += 4;
    return this;
  }

  i32(v: number): this {
    this.grow(4);
    this.view.setInt32(this.pos, v, this.le);
    this.pos += 4;
    return this;
  }

  u64(v: number): this {
    const hi = Math.floor(v / 0x1_0000_0000);
    const lo = v >>> 0;
    if (this.le) this.u32(lo).u32(hi);
    else this.u32(hi).u32(lo);
    return this;
  }

  f64(v: number): this {
    this.grow(8);
    this.view.setFloat64(this.pos, v, this.le);
    this.pos += 8;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.grow(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  ascii(s: string): this {
    return this.bytes(encodeLatin1(s));
  }

  zeros(n: number): this {
    this.grow(n);
    this.buf.fill(0, this.pos, this.pos + n);
    this.pos += n;
    return this;
  }

  /** Pad with zeros until pos is a multiple of `n`. */
  align(n: number): this {
    const r = this.pos % n;
    if (r) this.zeros(n - r);
    return this;
  }

  /** Overwrite a u32 at an earlier position. */
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0, this.le);
  }

  patchU16(at: number, v: number): void {
    this.view.setUint16(at, v, this.le);
  }

  patchU8(at: number, v: number): void {
    this.buf[at] = v & 0xff;
  }

  patchBytes(at: number, b: Uint8Array): void {
    this.buf.set(b, at);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

// ---------------------------------------------------------------- text codecs

const utf8Decoder = new TextDecoder('utf-8');
const utf8DecoderStrict = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

export function utf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/** Decode as UTF-8 if valid, else Latin-1. */
export function utf8OrLatin1(bytes: Uint8Array): string {
  try {
    return utf8DecoderStrict.decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    utf8DecoderStrict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function encodeUtf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

export function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x2000)));
  }
  return s;
}

/** Characters outside Latin-1 are replaced with '?'. */
export function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c > 0xff ? 0x3f : c;
  }
  return out;
}

export function isLatin1(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
}

export function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

export function utf16(bytes: Uint8Array, le: boolean): string {
  const n = bytes.length >> 1;
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = bytes[i * 2];
    const b = bytes[i * 2 + 1];
    s += String.fromCharCode(le ? a | (b << 8) : (a << 8) | b);
  }
  return s;
}

/** UTF-16 with optional BOM (defaults to `defaultLe` without BOM). */
export function utf16Bom(bytes: Uint8Array, defaultLe = true): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes.subarray(2), true);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes.subarray(2), false);
  }
  return utf16(bytes, defaultLe);
}

export function encodeUtf16(s: string, le: boolean, bom = false): Uint8Array {
  const out = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
  let p = 0;
  if (bom) {
    out[p++] = le ? 0xff : 0xfe;
    out[p++] = le ? 0xfe : 0xff;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (le) {
      out[p++] = c & 0xff;
      out[p++] = c >> 8;
    } else {
      out[p++] = c >> 8;
      out[p++] = c & 0xff;
    }
  }
  return out;
}

/** Strip trailing NULs (and anything after the first NUL when `firstNul`). */
export function trimNul(s: string, firstNul = true): string {
  if (firstNul) {
    const i = s.indexOf('\0');
    return i >= 0 ? s.slice(0, i) : s;
  }
  return s.replace(/\0+$/, '');
}

// ------------------------------------------------------------------- helpers

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Does `bytes` contain `pattern` at `offset`? Pattern may be a latin1 string. */
export function startsWith(bytes: Uint8Array, pattern: Uint8Array | string, offset = 0): boolean {
  const pat = typeof pattern === 'string' ? encodeLatin1(pattern) : pattern;
  if (offset + pat.length > bytes.length) return false;
  for (let i = 0; i < pat.length; i++) if (bytes[offset + i] !== pat[i]) return false;
  return true;
}

export function indexOfBytes(bytes: Uint8Array, pattern: Uint8Array | string, from = 0): number {
  const pat = typeof pattern === 'string' ? encodeLatin1(pattern) : pattern;
  const first = pat[0];
  const last = bytes.length - pat.length;
  outer: for (let i = from; i <= last; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, seed = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Default cap for one decompressed metadata payload (a text chunk, a tag frame). */
export const MAX_INFLATED = 64 << 20;
const INFLATE_STEP = 1 << 14;

/**
 * Decompress zlib, gzip or raw deflate data, giving up with a MetadataError
 * once the output passes `limit` bytes: the engine may run on the page itself,
 * so a few KB of crafted data must not expand into gigabytes. The input is fed
 * in small steps, so memory stays near the limit, not at the bomb's full size.
 */
export function inflateLimited(data: Uint8Array, format: 'zlib' | 'gzip' | 'deflate', limit = MAX_INFLATED): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const ondata = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > limit) throw new MetadataError(`compressed data expands to more than ${formatBytes(limit)}`);
    parts.push(chunk);
  };
  const stream = format === 'zlib' ? new Unzlib(ondata) : format === 'gzip' ? new Gunzip(ondata) : new Inflate(ondata);
  try {
    for (let i = 0; ; i += INFLATE_STEP) {
      const last = i + INFLATE_STEP >= data.length;
      stream.push(data.subarray(i, i + INFLATE_STEP), last);
      if (last) break;
    }
  } catch (e) {
    if (e instanceof MetadataError) throw e;
    throw new MetadataError('compressed data is corrupt');
  }
  return concat(parts);
}

export function toHex(bytes: Uint8Array, max = 64): string {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0') + (i < n - 1 ? ' ' : '');
  return bytes.length > max ? `${s} …` : s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

export function base64Decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Make a Blob from byte arrays and/or blob slices. */
export function toBlob(parts: Array<Uint8Array | Blob>, type = ''): Blob {
  return new Blob(parts as BlobPart[], { type });
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
