/**
 * ZIP reader + surgical rewriter. Unchanged entries are copied byte-for-byte
 * (as Blob slices, never decompressed); only replaced/added entries are
 * re-encoded. Used by OOXML, ODF and EPUB handlers.
 */

import { deflateSync } from 'fflate';
import { Reader, Writer, crc32, encodeUtf8, formatBytes, inflateLimited, latin1, utf8, toBlob } from './binary';
import { MetadataError, Source } from './types';

export interface ZipEntry {
  name: string;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  modTime: number;
  modDate: number;
  crc: number;
  compressedSize: number;
  size: number;
  internalAttrs: number;
  externalAttrs: number;
  centralExtra: Uint8Array;
  comment: Uint8Array;
  localOffset: number;
  /** offset of the next entry / central directory — the raw span to copy */
  endOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export function isZip(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/** Largest single entry the handlers decompress, and the total for one archive (sizes come from the file). */
const MAX_ENTRY = 256 << 20;
const MAX_ARCHIVE = 512 << 20;

export class ZipArchive {
  private inflated = 0;

  private constructor(
    readonly src: Source,
    readonly entries: ZipEntry[],
    readonly comment: Uint8Array,
    readonly centralOffset: number,
  ) {}

  static async open(src: Source): Promise<ZipArchive> {
    const size = src.size;
    const tailLen = Math.min(size, 0xffff + 22);
    const tail = await src.read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new MetadataError('Not a valid ZIP archive (end of central directory not found)');
    const r = new Reader(tail, true, eocd);
    r.u32();
    r.u16(); // disk
    r.u16(); // cd disk
    r.u16(); // entries on disk
    const count = r.u16();
    const cdSize = r.u32();
    const cdOffset = r.u32();
    const commentLen = r.u16();
    const comment = tail.slice(eocd + 22, eocd + 22 + commentLen);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new MetadataError('ZIP64 archives are not supported');
    }
    const cd = await src.read(cdOffset, cdSize);
    const cr = new Reader(cd, true);
    const entries: ZipEntry[] = [];
    for (let k = 0; k < count; k++) {
      if (cr.u32() !== SIG_CENTRAL) throw new MetadataError('Corrupt ZIP central directory');
      const e = {
        versionMadeBy: cr.u16(),
        versionNeeded: cr.u16(),
        flags: cr.u16(),
        method: cr.u16(),
        modTime: cr.u16(),
        modDate: cr.u16(),
        crc: cr.u32(),
        compressedSize: cr.u32(),
        size: cr.u32(),
      };
      const nameLen = cr.u16();
      const extraLen = cr.u16();
      const commentLen2 = cr.u16();
      cr.u16(); // disk start
      const internalAttrs = cr.u16();
      const externalAttrs = cr.u32();
      const localOffset = cr.u32();
      const nameBytes = cr.take(nameLen);
      const name = e.flags & 0x800 ? utf8(nameBytes) : decodeCp437(nameBytes);
      const centralExtra = cr.take(extraLen).slice();
      const ecomment = cr.take(commentLen2).slice();
      if (e.compressedSize === 0xffffffff || e.size === 0xffffffff || localOffset === 0xffffffff) {
        throw new MetadataError('ZIP64 archives are not supported');
      }
      entries.push({ ...e, name, internalAttrs, externalAttrs, centralExtra, comment: ecomment, localOffset, endOffset: 0 });
    }
    const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    for (let k = 0; k < sorted.length; k++) {
      sorted[k].endOffset = k + 1 < sorted.length ? sorted[k + 1].localOffset : cdOffset;
    }
    return new ZipArchive(src, entries, comment, cdOffset);
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  get(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  async dataOffset(e: ZipEntry): Promise<number> {
    const h = await this.src.read(e.localOffset, 30);
    const r = new Reader(h, true);
    if (r.u32(0) !== SIG_LOCAL) throw new MetadataError(`Corrupt ZIP local header for ${e.name}`);
    return e.localOffset + 30 + r.u16(26) + r.u16(28);
  }

  async read(name: string): Promise<Uint8Array> {
    const e = this.get(name);
    if (!e) throw new MetadataError(`Missing ${name} in archive`);
    if (e.flags & 1) throw new MetadataError(`${name} is encrypted`);
    const start = await this.dataOffset(e);
    const raw = await this.src.read(start, e.compressedSize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      if (e.size > Math.min(MAX_ENTRY, MAX_ARCHIVE - this.inflated)) {
        throw new MetadataError(`${name} is too large to process (${formatBytes(e.size)} uncompressed)`);
      }
      let out: Uint8Array;
      try {
        out = inflateLimited(raw, 'deflate', e.size);
      } catch (err) {
        throw new MetadataError(`${name} cannot be decompressed: ${(err as Error).message}`);
      }
      this.inflated += out.length;
      return out;
    }
    throw new MetadataError(`Unsupported ZIP compression method ${e.method} for ${name}`);
  }

  async readText(name: string): Promise<string> {
    return utf8(await this.read(name));
  }
}

function decodeCp437(b: Uint8Array): string {
  // ASCII subset is identical; good enough for metadata paths.
  return latin1(b);
}

export interface NewEntry {
  name: string;
  data: Uint8Array;
  /** default true; ODF/EPUB `mimetype` must be stored */
  compress?: boolean;
}

export interface RewriteOptions {
  /** name -> new content, or null to delete the entry */
  replace?: Map<string, Uint8Array | null>;
  /** entries to append (or to place first when `first` is set) */
  add?: NewEntry[];
  /**
   * Reset every entry's timestamp to this DOS date (Date) and drop extended
   * timestamp extra fields. Useful when stripping metadata.
   */
  normalizeTime?: Date;
  /** Keep the archive comment (default true) */
  keepComment?: boolean;
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const TIME_EXTRAS = new Set([0x5455, 0x000a, 0x5855]);

function filterExtra(extra: Uint8Array, drop: Set<number>): Uint8Array {
  const out: Uint8Array[] = [];
  const r = new Reader(extra, true);
  while (r.remaining >= 4) {
    const id = r.u16();
    const len = r.u16();
    if (len > r.remaining) break;
    const body = r.take(len);
    if (!drop.has(id)) {
      const w = new Writer(true, 4 + len);
      w.u16(id).u16(len).bytes(body);
      out.push(w.finish());
    }
  }
  const total = out.reduce((n, b) => n + b.length, 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const b of out) {
    res.set(b, o);
    o += b.length;
  }
  return res;
}

/** Produce a new archive. Entry order is preserved; additions go last. */
export async function rewriteZip(zip: ZipArchive, opts: RewriteOptions): Promise<Blob> {
  const replace = opts.replace ?? new Map();
  const parts: Array<Uint8Array | Blob> = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const norm = opts.normalizeTime ? dosTime(opts.normalizeTime) : null;
  const ordered = [...zip.entries].sort((a, b) => a.localOffset - b.localOffset);

  const writeNew = (name: string, data: Uint8Array, compress: boolean, base?: ZipEntry) => {
    const nameBytes = encodeUtf8(name);
    const comp = compress ? deflateSync(data, { level: 6 }) : data;
    const method = compress ? 8 : 0;
    const crc = crc32(data);
    const t = norm ?? (base ? { time: base.modTime, date: base.modDate } : dosTime(new Date(1980, 0, 1)));
    const flags = 0x800;
    const lw = new Writer(true, 30 + nameBytes.length);
    lw.u32(SIG_LOCAL).u16(20).u16(flags).u16(method).u16(t.time).u16(t.date).u32(crc).u32(comp.length).u32(data.length);
    lw.u16(nameBytes.length).u16(0).bytes(nameBytes);
    const local = lw.finish();
    const cw = new Writer(true, 46 + nameBytes.length);
    cw.u32(SIG_CENTRAL)
      .u16(base?.versionMadeBy ?? 20)
      .u16(20)
      .u16(flags)
      .u16(method)
      .u16(t.time)
      .u16(t.date)
      .u32(crc)
      .u32(comp.length)
      .u32(data.length);
    cw.u16(nameBytes.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(base?.internalAttrs ?? 0)
      .u32(base?.externalAttrs ?? 0)
      .u32(offset);
    cw.bytes(nameBytes);
    central.push(cw.finish());
    parts.push(local, comp);
    offset += local.length + comp.length;
  };

  for (const e of ordered) {
    if (replace.has(e.name)) {
      const data = replace.get(e.name);
      if (data) writeNew(e.name, data, e.method !== 0, e);
      continue;
    }
    // copy as-is, optionally patching timestamps
    const hdr = await zip.src.read(e.localOffset, 30);
    const hr = new Reader(hdr, true);
    if (hr.u32(0) !== SIG_LOCAL) throw new MetadataError(`Corrupt ZIP local header for ${e.name}`);
    const nameLen = hr.u16(26);
    const extraLen = hr.u16(28);
    const fullHdr = (await zip.src.read(e.localOffset, 30 + nameLen + extraLen)).slice();
    let localHeader: Uint8Array = fullHdr;
    let centralExtra = e.centralExtra;
    if (norm) {
      const name = fullHdr.subarray(30, 30 + nameLen);
      const extra = filterExtra(fullHdr.subarray(30 + nameLen), TIME_EXTRAS);
      const w = new Writer(true, 30 + nameLen + extra.length);
      w.bytes(fullHdr.subarray(0, 26)).u16(nameLen).u16(extra.length).bytes(name).bytes(extra);
      localHeader = w.finish();
      localHeader[10] = norm.time & 0xff;
      localHeader[11] = norm.time >> 8;
      localHeader[12] = norm.date & 0xff;
      localHeader[13] = norm.date >> 8;
      centralExtra = filterExtra(e.centralExtra, TIME_EXTRAS);
    }
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    parts.push(localHeader, zip.src.slice(dataStart, e.endOffset));
    const nameBytes = e.flags & 0x800 ? encodeUtf8(e.name) : fullHdr.subarray(30, 30 + nameLen);
    const cw = new Writer(true, 46 + nameBytes.length + centralExtra.length + e.comment.length);
    const t = norm ?? { time: e.modTime, date: e.modDate };
    cw.u32(SIG_CENTRAL)
      .u16(e.versionMadeBy)
      .u16(e.versionNeeded)
      .u16(e.flags)
      .u16(e.method)
      .u16(t.time)
      .u16(t.date)
      .u32(e.crc)
      .u32(e.compressedSize)
      .u32(e.size);
    cw.u16(nameBytes.length).u16(centralExtra.length).u16(e.comment.length).u16(0);
    cw.u16(e.internalAttrs).u32(e.externalAttrs).u32(offset);
    cw.bytes(nameBytes).bytes(centralExtra).bytes(e.comment);
    central.push(cw.finish());
    offset += localHeader.length + (e.endOffset - dataStart);
  }

  for (const a of opts.add ?? []) writeNew(a.name, a.data, a.compress ?? true);

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    parts.push(c);
    cdSize += c.length;
  }
  const comment = opts.keepComment === false ? new Uint8Array(0) : zip.comment;
  const ew = new Writer(true, 22 + comment.length);
  ew.u32(SIG_EOCD).u16(0).u16(0).u16(central.length).u16(central.length).u32(cdSize).u32(cdStart).u16(comment.length);
  ew.bytes(comment);
  parts.push(ew.finish());
  return toBlob(parts, 'application/zip');
}
