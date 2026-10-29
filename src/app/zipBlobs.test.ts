import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { HAS_PYTHON, pyZip } from '../engine/test/docOracles';
import { zipBlobs, type ZipBlobEntry } from './zipBlobs';

/** A Blob that can only be read through slices of at most `limit` bytes. */
class SliceOnly extends Blob {
  largest = 0;
  constructor(
    parts: BlobPart[],
    private limit: number,
  ) {
    super(parts);
  }
  override slice(start = 0, end = this.size, type?: string): Blob {
    const n = Math.min(end, this.size) - start;
    if (n > this.limit) throw new Error(`read ${n} bytes at once`);
    this.largest = Math.max(this.largest, n);
    return super.slice(start, end, type);
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('read whole');
  }
  override stream(): ReturnType<Blob['stream']> {
    throw new Error('read whole');
  }
}

const noise = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 2654435761) >>> 24);

async function check(entries: ZipBlobEntry[], max32?: number) {
  const zip = new Uint8Array(await (await zipBlobs(entries, new Date(1980, 0, 1), max32)).arrayBuffer());
  if (HAS_PYTHON) {
    const py = pyZip(zip);
    expect(py.bad).toBeNull(); // every CRC checked
    expect(py.names).toEqual(entries.map((e) => e.name));
  }
  const files = unzipSync(zip);
  expect(Object.keys(files)).toEqual(entries.map((e) => e.name));
  for (const e of entries) {
    const want = new Uint8Array(await new Blob([e.blob]).arrayBuffer());
    expect(Buffer.from(files[e.name]).equals(Buffer.from(want)), e.name).toBe(true);
  }
  return zip;
}

describe('zipBlobs', () => {
  it('stores the files, reading each only in chunks', async () => {
    const big = new SliceOnly([noise(9 << 20)], 4 << 20);
    const zip = await check([
      { name: 'photo.jpg', blob: new Blob([noise(1000)]) },
      { name: 'Ünïcode name.txt', blob: new Blob(['hello']) },
      { name: 'empty', blob: new Blob([]) },
      { name: 'video.mp4', blob: big },
    ]);
    expect(big.largest).toBe(4 << 20);
    expect(zip.length).toBeLessThan((9 << 20) + 1000 + 600);
  });

  it('switches to ZIP64 records when sizes and offsets do not fit', async () => {
    const entries = [
      { name: 'a.bin', blob: new Blob([noise(300)]) },
      { name: 'b.bin', blob: new Blob([noise(50)]) },
      { name: 'c.bin', blob: new Blob([noise(400)]) },
    ];
    const zip = await check(entries, 200);
    const sig = (s: number) => Buffer.from(zip).indexOf(Buffer.from([s & 0xff, (s >> 8) & 0xff, (s >> 16) & 0xff, s >>> 24]));
    expect(sig(0x06064b50)).toBeGreaterThan(0); // ZIP64 end of central directory
    expect(sig(0x07064b50)).toBeGreaterThan(0); // and its locator
  });

  it('does not date the archive', async () => {
    const zip = await zipBlobs([{ name: 'x', blob: new Blob(['x']) }], new Date(1980, 0, 1));
    const b = new Uint8Array(await zip.arrayBuffer());
    const v = new DataView(b.buffer);
    expect([v.getUint16(10, true), v.getUint16(12, true)]).toEqual([0, (1 << 5) | 1]); // 00:00, 1980-01-01
  });
});
