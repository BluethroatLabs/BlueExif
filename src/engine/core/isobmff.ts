/**
 * ISO base media file format (MP4, QuickTime, 3GPP, HEIF, AVIF) box helpers.
 *
 * - `scanTopLevel` walks the top-level boxes of a Source with small partial
 *   reads, so multi-gigabyte media payloads (`mdat`) are never loaded.
 * - `parseBoxes` turns a byte range into a BoxNode tree; leaves keep their raw
 *   payload so untouched boxes round-trip byte-exact.
 * - Output files are described as a list of Pieces (verbatim source ranges,
 *   source ranges blanked in place, new bytes or box trees). `relocator()`
 *   maps old absolute file offsets to new ones so chunk offsets
 *   (`stco`/`co64`), item locations (`iloc`), fragment base offsets (`tfhd`)
 *   and random-access tables (`tfra`) can be patched after boxes changed size.
 * - Track helpers locate sample bytes (`trackSampleRanges`), blank encoder
 *   fingerprints and read/write the movie, track and media header dates.
 */

import { Reader, Writer, encodeLatin1, latin1, toBlob } from './binary';
import { dateToParts, displayDate, makeField, partsToDate, requireDate, toIso } from './fields';
import { MetadataError, groupKey, type Edits, type Field, type FieldGroup, type FieldSpec, type Source } from './types';

export const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

/** Header of a top-level box located by `scanTopLevel`. */
export interface TopBox {
  type: string;
  /** absolute offset of the size field */
  start: number;
  /** total size including the header */
  size: number;
  /** 8, 16 (64-bit size) — plus 16 for `uuid` boxes */
  headerSize: number;
  end: number;
  /** lower-case hex extended type of `uuid` boxes */
  uuid?: string;
  /** the size field was 0 ("extends to end of file") */
  toEnd: boolean;
}

export interface BoxNode {
  type: string;
  /** 16-byte extended type of `uuid` boxes */
  uuid?: Uint8Array;
  /** leaf payload (everything after the header) */
  data?: Uint8Array;
  /** container: bytes between header and first child (full-box version/flags …) */
  head?: Uint8Array;
  children?: BoxNode[];
  /** container: trailing bytes that do not form a box (QuickTime terminators) */
  tail?: Uint8Array;
}

/**
 * Decide whether a box is a container. Return the number of header bytes that
 * precede its children (0 for plain containers, 4 for full-box containers) or
 * null for a leaf. `payload` is the box content after its header.
 */
export type ContainerFn = (type: string, payload: Uint8Array, path: readonly string[]) => number | null;

export const fourcc = (b: Uint8Array, at = 0): string => latin1(b.subarray(at, at + 4));

export const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Printable four-character code, e.g. "©nam", or hex for binary codes ("0x00000001"). */
export function showFourcc(t: string): string {
  return /^[\x20-\x7e\xa9]{4}$/.test(t) ? t : `0x${hexOf(encodeLatin1(t))}`;
}

// ------------------------------------------------------------- top level

/**
 * Walk the top-level boxes with partial reads. Bytes after the last valid box
 * that do not form a box are reported as `trailing` (their start offset).
 */
export async function scanTopLevel(src: Source): Promise<{ boxes: TopBox[]; trailing: number | null }> {
  const boxes: TopBox[] = [];
  const size = src.size;
  let p = 0;
  while (p < size) {
    if (size - p < 8) return { boxes, trailing: p };
    const h = await src.read(p, 32);
    const r = new Reader(h);
    let boxSize = r.u32(0);
    const type = fourcc(h, 4);
    let headerSize = 8;
    let toEnd = false;
    if (boxSize === 1) {
      if (h.length < 16) return { boxes, trailing: p };
      boxSize = r.u64(8);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - p;
      toEnd = true;
    }
    let uuid: string | undefined;
    if (type === 'uuid') {
      if (h.length < headerSize + 16) return { boxes, trailing: p };
      uuid = hexOf(h.subarray(headerSize, headerSize + 16));
      headerSize += 16;
    }
    if (boxSize < headerSize || p + boxSize > size || !/^[\x20-\x7e\xa9]{4}$/.test(type)) {
      if (!boxes.length) throw new MetadataError('Not an ISO media file (invalid box structure)');
      return { boxes, trailing: p };
    }
    boxes.push({ type, start: p, size: boxSize, headerSize, end: p + boxSize, uuid, toEnd });
    p += boxSize;
    if (boxes.length > 2_000_000) throw new MetadataError('Too many boxes in file');
  }
  return { boxes, trailing: null };
}

/** Read a top-level box payload (after its header). */
export async function readPayload(src: Source, box: TopBox): Promise<Uint8Array> {
  return src.read(box.start + box.headerSize, box.size - box.headerSize);
}

// ------------------------------------------------------------------ trees

/** Parse the boxes in `b[start, end)`. Never throws on malformed data. */
export function parseBoxes(
  b: Uint8Array,
  start: number,
  end: number,
  isContainer: ContainerFn,
  path: readonly string[] = [],
  warnings?: string[],
): { boxes: BoxNode[]; tail?: Uint8Array } {
  const boxes: BoxNode[] = [];
  const r = new Reader(b);
  let p = start;
  while (p < end) {
    if (end - p < 8) return { boxes, tail: b.slice(p, end) };
    let size = r.u32(p);
    const type = fourcc(b, p + 4);
    let hs = 8;
    if (size === 1) {
      if (end - p < 16) return { boxes, tail: b.slice(p, end) };
      size = r.u64(p + 8);
      hs = 16;
    } else if (size === 0) {
      // ISO: extends to the end of the enclosing box. A lone 32-bit zero is a
      // QuickTime terminator and is kept verbatim as tail.
      if (end - p <= 8 && r.u32(p) === 0 && path.length) return { boxes, tail: b.slice(p, end) };
      size = end - p;
    }
    let uuid: Uint8Array | undefined;
    if (type === 'uuid' && size >= hs + 16) {
      uuid = b.slice(p + hs, p + hs + 16);
      hs += 16;
    }
    if (size < hs || p + size > end) {
      warnings?.push(`Malformed '${showFourcc(type)}' box inside ${path.join('/') || 'file'}`);
      return { boxes, tail: b.slice(p, end) };
    }
    const payload = b.subarray(p + hs, p + size);
    const head = path.length < 12 ? isContainer(type, payload, path) : null;
    if (head !== null && head <= payload.length) {
      const sub = parseBoxes(payload, head, payload.length, isContainer, [...path, type], warnings);
      boxes.push({ type, uuid, head: payload.slice(0, head), children: sub.boxes, tail: sub.tail });
    } else {
      boxes.push({ type, uuid, data: payload.slice() });
    }
    p += size;
  }
  return { boxes };
}

function payloadSize(n: BoxNode): number {
  if (n.children) {
    let s = (n.head?.length ?? 0) + (n.tail?.length ?? 0);
    for (const c of n.children) s += nodeSize(c);
    return s;
  }
  return n.data?.length ?? 0;
}

/** Serialized size of a box tree. */
export function nodeSize(n: BoxNode): number {
  const body = payloadSize(n) + (n.uuid ? 16 : 0);
  return body + 8 > 0xffffffff ? body + 16 : body + 8;
}

function writeNode(w: Writer, n: BoxNode): void {
  const size = nodeSize(n);
  if (size > 0xffffffff) w.u32(1).ascii(n.type).u64(size);
  else w.u32(size).ascii(n.type);
  if (n.uuid) w.bytes(n.uuid);
  if (n.children) {
    if (n.head) w.bytes(n.head);
    for (const c of n.children) writeNode(w, c);
    if (n.tail) w.bytes(n.tail);
  } else if (n.data) {
    w.bytes(n.data);
  }
}

export function serializeNode(n: BoxNode): Uint8Array {
  const w = new Writer(false, nodeSize(n));
  writeNode(w, n);
  return w.finish();
}

/** Leaf box from payload parts. */
export function leaf(type: string, ...parts: Uint8Array[]): BoxNode {
  const w = new Writer(false, 64);
  for (const p of parts) w.bytes(p);
  return { type, data: w.finish() };
}

export function container(type: string, children: BoxNode[], head?: Uint8Array): BoxNode {
  return { type, head, children };
}

/** Version + flags of a full box. */
export function fullHead(version: number, flags = 0): Uint8Array {
  return new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
}

/** Serialized box from payload parts (convenience for small boxes). */
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  return serializeNode(leaf(type, ...parts));
}

export function child(n: BoxNode | null | undefined, type: string): BoxNode | undefined {
  return n?.children?.find((c) => c.type === type);
}

export function childrenOf(n: BoxNode | null | undefined, type: string): BoxNode[] {
  return n?.children?.filter((c) => c.type === type) ?? [];
}

/** Follow a "a/b/c" path of first children. */
export function findPath(n: BoxNode | null | undefined, path: string): BoxNode | undefined {
  let cur = n ?? undefined;
  for (const t of path.split('/')) {
    cur = child(cur, t);
    if (!cur) return undefined;
  }
  return cur;
}

/** All descendants (depth first) matching `type`. */
export function descendants(n: BoxNode, type: string, out: BoxNode[] = []): BoxNode[] {
  for (const c of n.children ?? []) {
    if (c.type === type) out.push(c);
    if (c.children) descendants(c, type, out);
  }
  return out;
}

/** Remove direct children matching `pred`; returns true if anything was removed. */
export function removeChildren(n: BoxNode, pred: (c: BoxNode) => boolean): boolean {
  if (!n.children) return false;
  const before = n.children.length;
  n.children = n.children.filter((c) => !pred(c));
  return n.children.length !== before;
}

/**
 * `meta` is a full box in ISO files but a plain container in QuickTime. Tell
 * them apart by looking for the `hdlr` that must come first.
 */
export function metaHeadSize(payload: Uint8Array): number {
  if (payload.length >= 8 && fourcc(payload, 4) === 'hdlr') return 0;
  return 4;
}

/** Handler type of a `hdlr` box (or of the `hdlr` child of a container). */
export function handlerType(n: BoxNode | undefined): string | null {
  const h = n?.type === 'hdlr' ? n : child(n, 'hdlr');
  if (!h?.data || h.data.length < 12) return null;
  return fourcc(h.data, 8);
}

// ------------------------------------------------------------------ ftyp

export interface Ftyp {
  major: string;
  minor: number;
  compatible: string[];
}

export function parseFtyp(payload: Uint8Array): Ftyp {
  const r = new Reader(payload);
  const major = payload.length >= 4 ? fourcc(payload, 0) : '';
  const minor = payload.length >= 8 ? r.u32(4) : 0;
  const compatible: string[] = [];
  for (let p = 8; p + 4 <= payload.length; p += 4) {
    const b = fourcc(payload, p);
    if (b !== '\0\0\0\0') compatible.push(b);
  }
  return { major, minor, compatible };
}

/** ftyp of a file whose first box is `ftyp`. */
export function sniffFtyp(head: Uint8Array): Ftyp | null {
  if (head.length < 16 || fourcc(head, 4) !== 'ftyp') return null;
  const size = new Reader(head).u32(0);
  if (size < 16 || size > 4096) return null;
  return parseFtyp(head.subarray(8, Math.min(size, head.length)));
}

/** Brands of still-image HEIF files (HEIC, AVIF …) and image sequences. */
export const HEIF_BRANDS = new Set([
  'mif1', 'mif2', 'msf1', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
  'avif', 'avis', 'avio', 'MiHA', 'MiHB', 'MiHE', 'MiPr', 'miaf', 'jpeg', 'jpgs', 'vvic',
]);

/** Top-level box types in the first `head` bytes (stops at the first invalid box). */
export function sniffTopTypes(head: Uint8Array): string[] {
  const out: string[] = [];
  const r = new Reader(head);
  let p = 0;
  while (p + 8 <= head.length && out.length < 64) {
    let size = r.u32(p);
    const type = fourcc(head, p + 4);
    if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) break;
    out.push(type);
    if (size === 1) {
      if (p + 16 > head.length) break;
      size = r.u64(p + 8);
    }
    if (size === 0 || size < 8) break;
    p += size;
  }
  return out;
}

// ------------------------------------------------------- output assembly

/** Part of an output file. */
export type Piece =
  /** verbatim source range [start, end) */
  | { copy: [number, number] }
  /** source range [start, end) written as zero bytes (same length, so offsets into it stay valid) */
  | { zero: [number, number] }
  /** new bytes; `mirror` = source offset they replace 1:1 (same length, offsets still valid) */
  | { bytes: Uint8Array; mirror?: number }
  /** box tree, serialized at assembly time (after offsets have been patched) */
  | { node: BoxNode };

export function pieceSize(p: Piece): number {
  if ('copy' in p) return p.copy[1] - p.copy[0];
  if ('zero' in p) return p.zero[1] - p.zero[0];
  if ('bytes' in p) return p.bytes.length;
  return nodeSize(p.node);
}

/**
 * Pieces for the source range [start, end) with the sorted, disjoint `zeros`
 * ranges blanked in place; everything else is carried over verbatim.
 */
export function copyWithZeros(start: number, end: number, zeros: ReadonlyArray<readonly [number, number]>): Piece[] {
  const out: Piece[] = [];
  // first range that ends after `start`
  let lo = 0;
  for (let hi = zeros.length; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (zeros[mid][1] <= start) lo = mid + 1;
    else hi = mid;
  }
  let pos = start;
  for (let i = lo; i < zeros.length && zeros[i][0] < end; i++) {
    const s = Math.max(zeros[i][0], pos);
    const e = Math.min(zeros[i][1], end);
    if (e <= s) continue;
    if (s > pos) out.push({ copy: [pos, s] });
    out.push({ zero: [s, e] });
    pos = e;
  }
  if (pos < end) out.push({ copy: [pos, end] });
  return out;
}

export type Relocate = (offset: number) => number;

/**
 * Map absolute source offsets to output offsets. Only offsets inside copied
 * or mirrored pieces can be mapped; anything else throws.
 */
export function relocator(pieces: Piece[]): Relocate {
  const segs: Array<[srcStart: number, srcEnd: number, out: number]> = [];
  let pos = 0;
  for (const p of pieces) {
    if ('copy' in p) segs.push([p.copy[0], p.copy[1], pos]);
    else if ('zero' in p) segs.push([p.zero[0], p.zero[1], pos]);
    else if ('bytes' in p && p.mirror !== undefined) segs.push([p.mirror, p.mirror + p.bytes.length, pos]);
    pos += pieceSize(p);
  }
  segs.sort((a, b) => a[0] - b[0]);
  return (o: number) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e, out] = segs[mid];
      if (o < s) hi = mid - 1;
      else if (o >= e) lo = mid + 1;
      else return out + (o - s);
    }
    // An offset at the very end of a kept range (zero-length data).
    const end = segs.find(([, e]) => e === o);
    if (end) return end[2] + (o - end[0]);
    throw new MetadataError(`Media data at offset ${o} lies in a part of the file that was rewritten`);
  };
}

export function totalSize(pieces: Piece[]): number {
  return pieces.reduce((n, p) => n + pieceSize(p), 0);
}

const ZERO_BLOCK = 1 << 16;

export function assemble(src: Source, pieces: Piece[], mime = ''): Blob {
  const parts: Array<Uint8Array | Blob> = [];
  // Long zero runs reference one shared block instead of allocating their full length.
  let block: Blob | null = null;
  for (const p of pieces) {
    if ('copy' in p) {
      if (p.copy[1] > p.copy[0]) parts.push(src.slice(p.copy[0], p.copy[1]));
    } else if ('zero' in p) {
      let n = p.zero[1] - p.zero[0];
      if (n >= ZERO_BLOCK) block ??= new Blob([new Uint8Array(ZERO_BLOCK)]);
      for (; n >= ZERO_BLOCK; n -= ZERO_BLOCK) parts.push(block!);
      if (n > 0) parts.push(new Uint8Array(n));
    } else if ('bytes' in p) parts.push(p.bytes);
    else parts.push(serializeNode(p.node));
  }
  return toBlob(parts, mime);
}

// ---------------------------------------------------------- offset patches

/** Rewrite every `stco`/`co64` chunk offset in a `moov` tree (same box sizes). */
export function patchChunkOffsets(moov: BoxNode, relocate: Relocate): void {
  for (const trak of childrenOf(moov, 'trak')) {
    const stbl = findPath(trak, 'mdia/minf/stbl');
    if (!stbl) continue;
    for (const t of stbl.children ?? []) {
      if ((t.type !== 'stco' && t.type !== 'co64') || !t.data || t.data.length < 8) continue;
      const d = t.data.slice();
      const r = new Reader(d);
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const n = Math.min(r.u32(4), Math.floor((d.length - 8) / (t.type === 'co64' ? 8 : 4)));
      for (let i = 0; i < n; i++) {
        if (t.type === 'stco') {
          const at = 8 + i * 4;
          const o = relocate(r.u32(at));
          if (o > 0xffffffff) throw new MetadataError('The file would grow beyond the 4 GB limit of its chunk offset table');
          v.setUint32(at, o);
        } else {
          const at = 8 + i * 8;
          const o = relocate(r.u64(at));
          v.setUint32(at, Math.floor(o / 0x1_0000_0000));
          v.setUint32(at + 4, o >>> 0);
        }
      }
      t.data = d;
    }
  }
}

// ------------------------------------------------------------------ iloc

export interface IlocExtent {
  index: number;
  offset: number;
  length: number;
}

export interface IlocItem {
  id: number;
  /** 0 = file offset, 1 = idat offset, 2 = item offset */
  method: number;
  dataRef: number;
  base: number;
  extents: IlocExtent[];
}

export interface Iloc {
  version: number;
  flags: number;
  offsetSize: number;
  lengthSize: number;
  baseSize: number;
  indexSize: number;
  items: IlocItem[];
}

function readN(r: Reader, n: number): number {
  if (n === 0) return 0;
  if (n === 4) return r.u32();
  if (n === 8) return r.u64();
  if (n === 2) return r.u16();
  if (n === 1) return r.u8();
  throw new MetadataError(`Unsupported iloc field size ${n}`);
}

function writeN(w: Writer, n: number, v: number): void {
  if (n === 0) {
    if (v !== 0) throw new MetadataError('iloc value does not fit');
  } else if (n === 4) {
    if (v > 0xffffffff) throw new MetadataError('iloc value does not fit in 32 bits');
    w.u32(v);
  } else if (n === 8) w.u64(v);
  else if (n === 2) w.u16(v);
  else w.u8(v);
}

/** Parse an `iloc` payload (versions 0–2). */
export function parseIloc(d: Uint8Array): Iloc {
  const r = new Reader(d);
  const version = r.u8();
  const flags = r.u24();
  if (version > 2) throw new MetadataError(`Unsupported iloc version ${version}`);
  const a = r.u8();
  const b = r.u8();
  const offsetSize = a >> 4;
  const lengthSize = a & 15;
  const baseSize = b >> 4;
  const indexSize = version >= 1 ? b & 15 : 0;
  const count = version < 2 ? r.u16() : r.u32();
  const items: IlocItem[] = [];
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? r.u16() : r.u32();
    const method = version >= 1 ? r.u16() & 15 : 0;
    const dataRef = r.u16();
    const base = readN(r, baseSize);
    const n = r.u16();
    const extents: IlocExtent[] = [];
    for (let k = 0; k < n; k++) {
      const index = version >= 1 && indexSize ? readN(r, indexSize) : 0;
      const offset = readN(r, offsetSize);
      const length = readN(r, lengthSize);
      extents.push({ index, offset, length });
    }
    items.push({ id, method, dataRef, base, extents });
  }
  return { version, flags, offsetSize, lengthSize, baseSize, indexSize, items };
}

export function serializeIloc(l: Iloc): Uint8Array {
  const version = l.items.some((i) => i.id > 0xffff) ? 2 : l.version;
  const w = new Writer(false, 64 + l.items.length * 32);
  w.bytes(fullHead(version, l.flags));
  w.u8((l.offsetSize << 4) | l.lengthSize);
  w.u8((l.baseSize << 4) | (version >= 1 ? l.indexSize : 0));
  if (version < 2) w.u16(l.items.length);
  else w.u32(l.items.length);
  for (const it of l.items) {
    if (version < 2) w.u16(it.id);
    else w.u32(it.id);
    if (version >= 1) w.u16(it.method & 15);
    else if (it.method !== 0) throw new MetadataError('iloc version 0 cannot store idat items');
    w.u16(it.dataRef);
    writeN(w, l.baseSize, it.base);
    w.u16(it.extents.length);
    for (const e of it.extents) {
      if (version >= 1 && l.indexSize) writeN(w, l.indexSize, e.index);
      writeN(w, l.offsetSize, e.offset);
      writeN(w, l.lengthSize, e.length);
    }
  }
  return w.finish();
}

/**
 * Grow iloc field sizes so that file offsets up to `maxFileSize` and the
 * current lengths fit. Must run before layout (it changes the box size).
 */
export function fitIloc(l: Iloc, maxFileSize: number): void {
  const need = maxFileSize > 0xffffffff ? 8 : 4;
  if (l.offsetSize) l.offsetSize = Math.max(l.offsetSize, need);
  if (l.baseSize) l.baseSize = Math.max(l.baseSize, need);
  if (!l.offsetSize && !l.baseSize) l.offsetSize = need;
  const maxLen = Math.max(0, ...l.items.flatMap((i) => i.extents.map((e) => e.length)));
  if (maxLen > 0xffffffff) l.lengthSize = 8;
  else if (maxLen > 0 && l.lengthSize === 0) l.lengthSize = 4;
}

/**
 * Move construction-method-0 extents to their new file positions. Keeps the
 * base_offset form when all extents of an item move by the same amount.
 */
export function relocateIloc(l: Iloc, relocate: Relocate): void {
  for (const it of l.items) {
    if (it.method !== 0 || it.dataRef !== 0 || !it.extents.length) continue;
    const abs = it.extents.map((e) => it.base + e.offset);
    const moved = abs.map((o, i) => (it.extents[i].length === 0 && o === 0 ? 0 : relocate(o)));
    const delta = moved[0] - abs[0];
    if (moved.every((m, i) => m - abs[i] === delta) && it.base + delta >= 0) {
      if (it.base) it.base += delta;
      else it.extents.forEach((e, i) => (e.offset = moved[i]));
    } else {
      it.base = 0;
      it.extents.forEach((e, i) => (e.offset = moved[i]));
    }
  }
}

/** Absolute data ranges of an item (construction method 0/1 only). */
export function itemRanges(it: IlocItem, idatStart: number, fileSize: number): Array<[number, number]> | null {
  if (it.dataRef !== 0 || it.method > 1) return null;
  const origin = it.method === 1 ? idatStart : 0;
  return it.extents.map((e) => {
    const s = origin + it.base + e.offset;
    return [s, e.length ? s + e.length : fileSize] as [number, number];
  });
}

// ----------------------------------------------------------------- tracks

/** track_ID from a trak's `tkhd` (0 if missing). */
export function trackId(trak: BoxNode): number {
  const d = child(trak, 'tkhd')?.data;
  return d && d.length >= 24 ? new Reader(d).u32(d[0] === 1 ? 20 : 12) : 0;
}

/** Sorted ranges with overlapping or touching ones merged. */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([s, e]) => e > s).map(([s, e]): [number, number] => [s, e]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const prev = out[out.length - 1];
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * For each sample description (1-based), whether its samples are stored in
 * this file: its data reference is self-contained (flag 1) or unknown.
 */
function localDescriptions(trak: BoxNode): (index: number) => boolean {
  const stsd = findPath(trak, 'mdia/minf/stbl/stsd')?.data;
  const dref = findPath(trak, 'mdia/minf/dinf/dref')?.data;
  if (!stsd || !dref || dref.length < 8) return () => true;
  const r = new Reader(dref);
  const local: boolean[] = [];
  for (let p = 8, i = 0; i < r.u32(4) && p + 12 <= dref.length; i++) {
    const size = r.u32(p);
    if (size < 12 || p + size > dref.length) break;
    local.push((r.u24(p + 9) & 1) === 1);
    p += size;
  }
  const s = new Reader(stsd);
  const refs: number[] = [];
  for (let p = 8, i = 0; i < s.u32(4) && p + 16 <= stsd.length; i++) {
    const size = s.u32(p);
    if (size < 16 || p + size > stsd.length) break;
    refs.push(s.u16(p + 14));
    p += size;
  }
  return (index) => local[(refs[index - 1] ?? 0) - 1] ?? true;
}

/**
 * Absolute byte ranges of a track's samples in this file, merged (one per
 * run of adjacent chunks), from stsc + stsz/stz2 + stco/co64. Chunks of
 * sample descriptions that point at another file are left out. Returns null
 * when the sample tables are missing or unreadable.
 */
export function trackSampleRanges(trak: BoxNode): Array<[number, number]> | null {
  const stbl = findPath(trak, 'mdia/minf/stbl');
  const stsc = child(stbl, 'stsc')?.data;
  const stsz = child(stbl, 'stsz')?.data;
  const stz2 = child(stbl, 'stz2')?.data;
  const stco = child(stbl, 'stco')?.data;
  const co64 = child(stbl, 'co64')?.data;
  const offs = stco ?? co64;
  if (!stsc || stsc.length < 8 || !offs || offs.length < 8 || !(stsz ?? stz2) || (stsz ?? stz2)!.length < 12) return null;
  // sample sizes
  let count: number;
  let fixed = 0;
  let size: (i: number) => number;
  if (stsz) {
    const r = new Reader(stsz);
    fixed = r.u32(4);
    count = r.u32(8);
    if (!fixed && count > (stsz.length - 12) / 4) return null;
    size = (i) => r.u32(12 + i * 4);
  } else {
    const d = stz2!;
    const r = new Reader(d);
    const bits = d[7];
    count = r.u32(8);
    if ((bits !== 4 && bits !== 8 && bits !== 16) || count > ((d.length - 12) * 8) / bits) return null;
    size = bits === 16 ? (i) => r.u16(12 + i * 2) : bits === 8 ? (i) => d[12 + i] : (i) => (d[12 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15;
  }
  // chunk offsets
  const or = new Reader(offs);
  const wide = !stco;
  const chunks = or.u32(4);
  if (chunks > (offs.length - 8) / (wide ? 8 : 4)) return null;
  const offset = (c: number) => (wide ? or.u64(8 + c * 8) : or.u32(8 + c * 4));
  // sample-to-chunk runs
  const sr = new Reader(stsc);
  const runs = sr.u32(4);
  if (runs > (stsc.length - 8) / 12) return null;
  const local = localDescriptions(trak);
  const out: Array<[number, number]> = [];
  let sample = 0;
  // Chunks are visited once, in order, however the runs of a damaged table overlap.
  let next = 1;
  for (let k = 0; k < runs && sample < count; k++) {
    const first = sr.u32(8 + k * 12);
    const perChunk = sr.u32(12 + k * 12);
    const desc = sr.u32(16 + k * 12);
    const last = k + 1 < runs ? sr.u32(8 + (k + 1) * 12) - 1 : chunks;
    if (first < 1) return null;
    for (let c = Math.max(first, next); c <= Math.min(last, chunks) && sample < count; c++, next = c) {
      const n = Math.min(perChunk, count - sample);
      let len = n * fixed;
      if (!fixed) for (let i = 0; i < n; i++) len += size(sample + i);
      sample += n;
      const at = offset(c - 1);
      if (len && local(desc)) out.push([at, at + len]);
    }
  }
  return mergeRanges(out);
}

/**
 * Give a `hdlr` box an empty name ("VideoHandler", "Core Media Video" …) and
 * zero its reserved fields (QuickTime: component manufacturer such as 'appl',
 * flags, mask). One zero byte is an empty C string and an empty Pascal string.
 */
export function blankHandlerName(hdlr: BoxNode): void {
  // version/flags, pre_defined (QuickTime component type), handler type | reserved[3], name
  const d = hdlr.data;
  if (!d || d.length < 24 || (d.length <= 25 && d.subarray(12).every((b) => b === 0))) return;
  const blank = new Uint8Array(25);
  blank.set(d.subarray(0, 12));
  hdlr.data = blank;
}

const VISUAL_HANDLERS = new Set(['vide', 'pict', 'auxv']);

/**
 * Blank the encoder / device fingerprints tracks carry: the vendor code of
 * visual and audio sample entries ('FFMP', 'appl' …), the compressor name of
 * visual sample entries ("Lavc… libx264") — both fixed-size, zeroed in place —
 * and the names of the media and data handlers (mdia/hdlr, minf/hdlr).
 */
export function scrubTrackFingerprints(moov: BoxNode): void {
  for (const trak of childrenOf(moov, 'trak')) {
    const mdia = child(trak, 'mdia');
    const handler = handlerType(child(mdia, 'hdlr'));
    for (const h of [child(mdia, 'hdlr'), findPath(mdia, 'minf/hdlr')]) if (h) blankHandlerName(h);
    const stsd = findPath(mdia, 'minf/stbl/stsd');
    const visual = VISUAL_HANDLERS.has(handler ?? '');
    if (!stsd?.data || stsd.data.length < 8 || (!visual && handler !== 'soun')) continue;
    const d = stsd.data.slice();
    const r = new Reader(d);
    for (let p = 8, i = 0; i < r.u32(4) && p + 8 <= d.length; i++) {
      const size = r.u32(p);
      if (size < 8 || p + size > d.length) break;
      const e = p + 8; // entry payload: reserved(6) data_reference_index(2) version(2) revision(2) vendor(4) …
      if (size >= 8 + 16) d.fill(0, e + 12, e + 16);
      if (visual && size >= 8 + 74) d.fill(0, e + 42, e + 74); // compressorname[32]
      p += size;
    }
    stsd.data = d;
  }
}

// ------------------------------------------------------- time (1904 epoch)

const EPOCH_1904 = Date.UTC(1904, 0, 1) / 1000;

/** Seconds since 1904-01-01 UTC -> Date (null for 0 = unset). */
export function macTimeToDate(seconds: number): Date | null {
  if (!seconds) return null;
  return new Date((seconds + EPOCH_1904) * 1000);
}

export function dateToMacTime(d: Date): number {
  return Math.round(d.getTime() / 1000) - EPOCH_1904;
}

/** Creation / modification time of a movie, track or media header (mvhd, tkhd, mdhd). */
export function readHeaderTimes(n: BoxNode | undefined): { version: number; created: number; modified: number } | null {
  const d = n?.data;
  if (!d || d.length < 12) return null;
  const r = new Reader(d);
  if (d[0] === 1) return d.length >= 20 ? { version: 1, created: r.u64(4), modified: r.u64(12) } : null;
  return { version: 0, created: r.u32(4), modified: r.u32(8) };
}

export function writeHeaderTime(n: BoxNode, which: 'created' | 'modified', seconds: number): void {
  const d = n.data!.slice();
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d[0] === 1) {
    const at = which === 'created' ? 4 : 12;
    v.setUint32(at, Math.floor(seconds / 0x1_0000_0000));
    v.setUint32(at + 4, seconds >>> 0);
  } else {
    if (seconds > 0xffffffff) throw new MetadataError('Dates after 2040-02-06 cannot be stored in this file’s 32-bit header');
    v.setUint32(which === 'created' ? 4 : 8, seconds);
  }
  n.data = d;
}

function macIso(seconds: number): string | null {
  const d = macTimeToDate(seconds);
  return d ? toIso(dateToParts(d, true)) : null;
}

export interface HeaderDateSlot {
  id: string;
  label: string;
  box: BoxNode;
  which: 'created' | 'modified';
}

/**
 * Date fields of the movie, track and media headers of a `moov`, with ids
 * `<prefix>:mvhd:created`, `<prefix>:tkhd:<track>:modified`, `<prefix>:mdhd:<track>:created` …
 */
export function headerDateSlots(moov: BoxNode, prefix: string): HeaderDateSlot[] {
  const out: HeaderDateSlot[] = [];
  const add = (box: BoxNode | undefined, key: string, label: string) => {
    if (!box || !readHeaderTimes(box)) return;
    out.push({ id: `${prefix}:${key}:created`, label: `${label} created`, box, which: 'created' });
    out.push({ id: `${prefix}:${key}:modified`, label: `${label} modified`, box, which: 'modified' });
  };
  add(child(moov, 'mvhd'), 'mvhd', 'Movie');
  for (const trak of childrenOf(moov, 'trak')) {
    const id = trackId(trak);
    add(child(trak, 'tkhd'), `tkhd:${id}`, `Track ${id}`);
    add(findPath(trak, 'mdia/mdhd'), `mdhd:${id}`, `Track ${id} media`);
  }
  return out;
}

/** "Dates" group: header dates that are set; an unset movie date is addable. */
export function headerDateGroup(moov: BoxNode, prefix: string, group: { id: string; source: string }): FieldGroup {
  const fields: Field[] = [];
  const addable: FieldSpec[] = [];
  for (const s of headerDateSlots(moov, prefix)) {
    const iso = macIso(readHeaderTimes(s.box)![s.which]);
    const spec: FieldSpec = {
      id: s.id,
      label: s.label,
      kind: 'datetime',
      sensitivity: 'time',
      tag: `${s.box.type} ${s.which === 'created' ? 'creation_time' : 'modification_time'}`,
      description: 'Stored in UTC.',
    };
    if (iso) fields.push(makeField(spec, iso, { display: displayDate(iso) }));
    else if (s.box.type === 'mvhd') addable.push(spec);
  }
  return { id: group.id, label: 'Dates', source: group.source, fields, addable: addable.length ? addable : undefined, removable: true };
}

/** Apply set/remove edits (and removal of `groupId`) to header dates; true if anything changed. */
export function applyHeaderDateEdits(moov: BoxNode, edits: Edits, prefix: string, groupId: string): boolean {
  const slots = headerDateSlots(moov, prefix);
  let changed = false;
  if (edits.get(groupKey(groupId))?.op === 'remove') {
    for (const s of slots) writeHeaderTime(s.box, s.which, 0);
    changed = true;
  }
  for (const s of slots) {
    const e = edits.get(s.id);
    if (!e) continue;
    if (e.op === 'remove') writeHeaderTime(s.box, s.which, 0);
    else {
      const p = requireDate(e.value, s.label);
      const secs = dateToMacTime(partsToDate({ ...p, tz: p.tz ?? 0 }));
      if (secs <= 0) throw new MetadataError(`${s.label}: dates before 1904 cannot be stored`);
      writeHeaderTime(s.box, s.which, secs);
    }
    changed = true;
  }
  return changed;
}

/** Clear every movie, track and media header date (0 = unset). */
export function zeroHeaderDates(moov: BoxNode): void {
  for (const s of headerDateSlots(moov, '')) writeHeaderTime(s.box, s.which, 0);
}

/** Packed ISO-639-2/T language code (as used in mdhd and 3GPP atoms). */
export function unpackLanguage(code: number): string {
  if (code === 0 || code === 0x7fff) return '';
  const c = (s: number) => String.fromCharCode(((code >> s) & 31) + 0x60);
  return c(10) + c(5) + c(0);
}

export function packLanguage(lang: string): number {
  const s = (lang || 'und').padEnd(3, 'd').toLowerCase();
  return ((s.charCodeAt(0) - 0x60) << 10) | ((s.charCodeAt(1) - 0x60) << 5) | (s.charCodeAt(2) - 0x60);
}
