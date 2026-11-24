/**
 * A ZIP of Blobs that never holds a file in memory: entries are stored
 * uncompressed and the archive is a Blob made of the file Blobs themselves
 * between small headers. Each file is read once, a chunk at a time, for its
 * CRC. ZIP64 records are added only when a size, an offset or the entry
 * count does not fit the classic fields.
 */

import { Writer, crc32, encodeUtf8, toBlob } from '../engine/core/binary';

export interface ZipBlobEntry {
  name: string;
  blob: Blob;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const UTF8_NAMES = 0x800;
const CHUNK = 4 << 20;

async function blobCrc(blob: Blob): Promise<number> {
  let crc = 0;
  for (let at = 0; at < blob.size; at += CHUNK) {
    crc = crc32(new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer()), crc);
  }
  return crc;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A ZIP64 extended-information extra field holding `values`, or nothing. */
function zip64Extra(values: number[]): Uint8Array {
  if (!values.length) return new Uint8Array(0);
  const w = new Writer(true, 4 + values.length * 8);
  w.u16(0x0001).u16(values.length * 8);
  for (const v of values) w.u64(v);
  return w.finish();
}

/**
 * Archive `entries` (names must be unique) with every timestamp set to
 * `date`. `max32` is the largest value written to a 32-bit field; tests lower
 * it to exercise the ZIP64 records without gigabytes of data.
 */
export async function zipBlobs(entries: ZipBlobEntry[], date: Date, max32 = 0xfffffffe): Promise<Blob> {
  const t = dosTime(date);
  const parts: Array<Uint8Array | Blob> = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, blob } of entries) {
    const nameBytes = encodeUtf8(name);
    const crc = await blobCrc(blob);
    const size = blob.size;
    const big = size > max32;
    const far = offset > max32;
    const version = big || far ? 45 : 20;

    const localExtra = zip64Extra(big ? [size, size] : []);
    const lw = new Writer(true, 30 + nameBytes.length + localExtra.length);
    lw.u32(SIG_LOCAL).u16(version).u16(UTF8_NAMES).u16(0).u16(t.time).u16(t.date).u32(crc);
    lw.u32(big ? 0xffffffff : size).u32(big ? 0xffffffff : size);
    lw.u16(nameBytes.length).u16(localExtra.length).bytes(nameBytes).bytes(localExtra);
    const local = lw.finish();

    const centralExtra = zip64Extra([...(big ? [size, size] : []), ...(far ? [offset] : [])]);
    const cw = new Writer(true, 46 + nameBytes.length + centralExtra.length);
    cw.u32(SIG_CENTRAL).u16(version).u16(version).u16(UTF8_NAMES).u16(0).u16(t.time).u16(t.date).u32(crc);
    cw.u32(big ? 0xffffffff : size).u32(big ? 0xffffffff : size);
    cw.u16(nameBytes.length).u16(centralExtra.length).u16(0).u16(0).u16(0).u32(0);
    cw.u32(far ? 0xffffffff : offset)
      .bytes(nameBytes)
      .bytes(centralExtra);
    central.push(cw.finish());

    parts.push(local, blob);
    offset += local.length + size;
  }

  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  parts.push(...central);
  const count = entries.length;
  const zip64 = count >= 0xffff || cdStart > max32 || cdSize > max32;
  if (zip64) {
    const ew = new Writer(true, 56 + 20);
    ew.u32(SIG_EOCD64).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(cdSize).u64(cdStart);
    ew.u32(SIG_LOCATOR64)
      .u32(0)
      .u64(cdStart + cdSize)
      .u32(1);
    parts.push(ew.finish());
  }
  const ew = new Writer(true, 22);
  ew.u32(SIG_EOCD).u16(0).u16(0);
  ew.u16(zip64 ? 0xffff : count).u16(zip64 ? 0xffff : count);
  ew.u32(zip64 ? 0xffffffff : cdSize)
    .u32(zip64 ? 0xffffffff : cdStart)
    .u16(0);
  parts.push(ew.finish());
  return toBlob(parts, 'application/zip');
}
