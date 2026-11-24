import { describe, expect, it } from 'vitest';
import { Source, groupKey, type GpsValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARKER, containsText, decodeErrors, detectScore, etAllProblems, pixelHash } from './images.testutil';
import { parseTiffFile, tiffHandler } from './tiff';

const ARTIST = 'exif:ifd0:013b';
const DESCRIPTION = 'exif:ifd0:010e';
const GPS = 'exif:gps:location';
const TAKEN = 'exif:exif:9003';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';

const read = async (b: Uint8Array, name = 'x.tif') => tiffHandler.read(new Source(new Blob([b as BlobPart]), name));

/** Strip bytes of every page ("offset:hex", or just hex when data may move). */
function strips(b: Uint8Array, withOffsets: boolean): string[] {
  const t = parseTiffFile(b);
  const out: string[] = [];
  let off = t.ifd0.offset;
  const seen = new Set<number>();
  while (off && !seen.has(off)) {
    seen.add(off);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getUint16(off, t.le);
    let so = 0;
    let sc = 0;
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12;
      const tag = dv.getUint16(p, t.le);
      if (tag === 0x111) so = dv.getUint32(p + 8, t.le);
      if (tag === 0x117) sc = dv.getUint32(p + 8, t.le);
    }
    const hex = Buffer.from(b.subarray(so, so + sc)).toString('hex');
    out.push(withOffsets ? `${so}:${hex}` : hex);
    off = dv.getUint32(off + 2 + n * 12, t.le);
  }
  return out;
}

/** Same pixels; `inPlace`: the compressed strips did not even move. */
function checkImage(out: Uint8Array, src: Uint8Array, inPlace = true) {
  expect(strips(out, inPlace)).toEqual(strips(src, inPlace));
  expect(decodeErrors(out, 'tif')).toBe('');
  expect(pixelHash(out, 'tif')).toBe(pixelHash(src, 'tif'));
}

describe('tiff', () => {
  it('detects and reads EXIF, GPS, XMP, IPTC and ICC', async () => {
    expect(detectScore(tiffHandler, fixtureBytes('images/rich.tif'), 'x')).toBe(3);
    expect(detectScore(tiffHandler, fixtureBytes('images/fake.orf'), 'x')).toBe(3);
    const m = await tiffHandler.read(fixture('images/rich.tif'));
    expect(m.format.name).toBe('TIFF image');
    expect(m.canWrite && m.canStrip).toBe(true);
    expect(m.info).toEqual(
      expect.arrayContaining([
        { label: 'Dimensions', value: '32 × 24' },
        { label: 'Compression', value: 'LZW' },
        { label: 'Color', value: 'RGB, 8-bit' },
        { label: 'Resolution', value: '72 dpi' },
        { label: 'Color profile', value: 'Display P3' },
      ]),
    );
    expect(field(m, ARTIST)?.value).toBe('Jane Doe');
    expect(field(m, 'exif:ifd0:010f')?.value).toBe('Nikon');
    expect(field(m, DESCRIPTION)?.value).toBe(`Scan ${MARKER}`);
    expect(field(m, 'exif:ifd0:0112')?.value).toBe('6');
    expect(field(m, TAKEN)?.value).toBe('2024-05-01T18:29:59');
    expect((field(m, GPS)?.value as GpsValue).lat).toBeCloseTo(51.5007, 4);
    expect(field(m, XMP_TITLE)?.value).toBe('Big Ben');
    expect(field(m, 'iptc:2:25')?.value).toEqual(['clock', 'london']);
    expect(field(m, 'tiff:icc')?.display).toMatch(/^Display P3/);
    // image structure is not presented as editable metadata
    for (const tag of ['0100', '0103', '0111', '0117', '011a', '02bc', '83bb', '8773']) expect(field(m, `exif:ifd0:${tag}`)).toBeUndefined();
    expect(m.warnings).toEqual([]);
  });

  it('edits in place: appended IFDs, unchanged pixels, no stale data', async () => {
    const src = fixtureBytes('images/rich.tif');
    const out = await bytesOf(
      await tiffHandler.write!(
        fixture('images/rich.tif'),
        edits({
          [ARTIST]: 'Zoë Smith',
          [DESCRIPTION]: REMOVE,
          [GPS]: REMOVE,
          [TAKEN]: '2023-12-24T20:15:00+01:00',
          'exif:ifd0:0111': REMOVE, // structural: ignored
          [XMP_TITLE]: 'Westminster',
          'iptc:2:90': REMOVE,
          'iptc:2:25': ['clock'],
        }),
      ),
    );
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Jane Doe')).toBe(true); // copyright is untouched
    const et = await exiftool(out, 'out.tif');
    expect(etProblems(et)).toEqual([]);
    expect(await etAllProblems(out, 'out.tif')).toEqual([]);
    expect(et['IFD0:Artist']).toBe('Zoë Smith');
    expect(et['IFD0:ImageDescription']).toBeUndefined();
    expect(etFind(et, 'GPSLatitude')).toEqual([]);
    expect(et['ExifIFD:DateTimeOriginal']).toBe('2023:12:24 20:15:00');
    expect(et['ExifIFD:OffsetTimeOriginal']).toBe('+01:00');
    expect(String(et['ExifIFD:SerialNumber'])).toBe('3001234');
    expect(et['XMP-dc:Title']).toBe('Westminster');
    expect(et['XMP-dc:Creator']).toBe('Jane Doe');
    expect(et['IPTC:Keywords']).toBe('clock');
    expect(et['IPTC:City']).toBeUndefined();
    expect(et['IFD0:Model']).toBe('Z 8');
    expect(et['IFD0:Copyright']).toBe('© 2024 Jane Doe');
    expect(et['IFD0:Orientation']).toBe('Rotate 90 CW');
    expect(et['IFD0:StripOffsets']).toBe(4192);
    checkImage(out, src);

    const m = await read(out);
    expect(field(m, ARTIST)?.value).toBe('Zoë Smith');
    expect(field(m, DESCRIPTION)).toBeUndefined();
    expect(field(m, 'tiff:icc')).toBeDefined();
    expect(m.warnings).toEqual([]);
  });

  it('adds metadata to a bare little-endian TIFF', async () => {
    const src = fixtureBytes('images/plain.tif');
    const out = await bytesOf(
      await tiffHandler.write!(
        fixture('images/plain.tif'),
        edits({ [ARTIST]: 'Someone', [GPS]: { lat: -33.8568, lon: 151.2153 }, [TAKEN]: '2024-02-03T04:05:06', [XMP_TITLE]: 'Added', 'iptc:2:25': ['x', 'y'] }),
      ),
    );
    const et = await exiftool(out, 'out.tif', ['-n']);
    expect(etProblems(et)).toEqual([]);
    expect(et['IFD0:Artist']).toBe('Someone');
    expect(et['GPS:GPSLatitude']).toBeCloseTo(33.8568, 4);
    expect(et['GPS:GPSLatitudeRef']).toBe('S');
    expect(et['ExifIFD:DateTimeOriginal']).toBe('2024:02:03 04:05:06');
    expect(et['XMP-dc:Title']).toBe('Added');
    expect(et['IPTC:Keywords']).toEqual(['x', 'y']);
    expect(et['IFD0:Software']).toMatch(/^Lavc/);
    expect(String(et['File:ExifByteOrder'])).toMatch(/^(II|Little)/);
    checkImage(out, src);
  });

  it('keeps further pages when editing a multi-page TIFF', async () => {
    const src = fixtureBytes('images/multipage.tif');
    const m = await tiffHandler.read(fixture('images/multipage.tif'));
    expect(m.info).toEqual(
      expect.arrayContaining([
        { label: 'Pages', value: '2' },
        { label: 'Dimensions', value: '8 × 8' },
      ]),
    );
    expect(field(m, ARTIST)?.value).toBe('Page One Artist');

    const out = await bytesOf(await tiffHandler.write!(fixture('images/multipage.tif'), edits({ [ARTIST]: REMOVE, 'exif:ifd0:0131': 'Edited' })));
    const et = await exiftool(out, 'm.tif');
    expect(etProblems(et)).toEqual([]);
    expect(et['IFD0:Artist']).toBeUndefined();
    expect(et['IFD0:Software']).toBe('Edited');
    expect(et['IFD1:Software']).toBe(`Scanner ${MARKER}`);
    expect(containsText(out, 'Page One Artist')).toBe(false);
    checkImage(out, src);
  });

  it('removes whole groups', async () => {
    const out = await bytesOf(
      await tiffHandler.write!(fixture('images/rich.tif'), edits({ [groupKey('exif')]: REMOVE, [groupKey('xmp')]: REMOVE, [groupKey('iptc')]: REMOVE })),
    );
    const et = await exiftool(out, 'g.tif');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => /^(XMP|IPTC|ExifIFD|GPS)/.test(k))).toEqual([]);
    expect(et['IFD0:Artist']).toBeUndefined();
    expect(et['IFD0:Orientation']).toBeUndefined();
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Jane')).toBe(false);
    expect(allFields(await read(out)).map((f) => f.id)).toEqual(['tiff:icc']);
    checkImage(out, fixtureBytes('images/rich.tif'));
  });

  it('strips everything except orientation and ICC, scrubbing old bytes', async () => {
    const src = fixtureBytes('images/rich.tif');
    const out = await bytesOf(await tiffHandler.strip!(fixture('images/rich.tif'), strip()));
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Jane')).toBe(false);
    expect(containsText(out, 'Nikon')).toBe(false);
    expect(containsText(out, 'Lavc')).toBe(false);
    const et = await exiftool(out, 's.tif');
    expect(etProblems(et)).toEqual([]);
    expect(await etAllProblems(out, 's.tif')).toEqual([]);
    expect(etMetaKeys(et).filter((k) => !k.startsWith('IFD0:') && !k.startsWith('ICC'))).toEqual([]);
    expect(et['IFD0:Orientation']).toBe('Rotate 90 CW');
    expect(allFields(await read(out)).map((f) => f.id)).toEqual(['exif:ifd0:0112', 'tiff:icc']);
    checkImage(out, src, false);
    // compact rebuild: header, pixels, ICC and the directory — nothing else
    expect(out.length).toBeLessThan(722 + 536 + 400);

    const bare = await bytesOf(await tiffHandler.strip!(fixture('images/rich.tif'), strip({ keepOrientation: false, keepColorProfile: false })));
    expect(allFields(await read(bare))).toEqual([]);
    expect(containsText(bare, 'Display P3')).toBe(false);
    checkImage(bare, src, false);
  });

  it('strips every page of a multi-page TIFF', async () => {
    const src = fixtureBytes('images/multipage.tif');
    const out = await bytesOf(await tiffHandler.strip!(fixture('images/multipage.tif'), strip()));
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Page One')).toBe(false);
    expect(containsText(out, '2024:05:01')).toBe(false);
    const et = await exiftool(out, 'm.tif');
    expect(etProblems(et)).toEqual([]);
    expect(etFind(et, 'Software')).toEqual([]);
    expect(et['IFD1:ImageWidth']).toBe(6);
    checkImage(out, src, false);
    expect(parseTiffFile(out).ifd0.offset).toBeGreaterThan(8 + 192 + 72);
  });

  it('strips in place when the extent of image data is unknown', async () => {
    // Rename page 1's StripByteCounts so the strip size is unknown.
    const src = fixtureBytes('images/multipage.tif');
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const ifd0 = dv.getUint32(4);
    for (let i = 0; i < dv.getUint16(ifd0); i++) if (dv.getUint16(ifd0 + 2 + i * 12) === 0x117) dv.setUint16(ifd0 + 2 + i * 12, 0x9117);
    const out = await bytesOf(await tiffHandler.strip!(new Source(new Blob([src as BlobPart]), 'm.tif'), strip()));
    expect(out.length).toBeGreaterThan(src.length); // directories appended, nothing moved
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Page One')).toBe(false);
    expect(containsText(out, 'PageMaker')).toBe(false);
    expect(Buffer.from(out.subarray(8, 8 + 192 + 72)).equals(Buffer.from(src.subarray(8, 8 + 192 + 72)))).toBe(true);
    const et = await exiftool(out, 'm.tif');
    // the damaged input already triggers "StripOffsets is missing the corresponding size tag"
    const problems = await etAllProblems(out, 'm.tif');
    expect(problems).toEqual(['IFD0:StripOffsets is missing the corresponding size tag']);
    expect(await etAllProblems(src, 'm.tif')).toEqual(expect.arrayContaining(problems));
    expect(etFind(et, 'Software')).toEqual([]);
    expect(et['IFD1:StripByteCounts']).toBe(72);
  });

  it('reads camera RAW variants read-only', async () => {
    const dng = await tiffHandler.read(fixture('images/fake.dng'));
    expect(dng.format.name).toBe('DNG raw image');
    expect(dng.canWrite).toBe(false);
    expect(field(dng, 'exif:ifd0:010f')?.value).toBe('Canon');
    expect(field(dng, 'exif:ifd0:c614')?.value).toBe('Canon EOS R5');
    expect(field(dng, 'exif:ifd0:c612')).toBeUndefined();
    expect(field(dng, 'exif:exif:a431')?.value).toBe('0123');
    await expect(tiffHandler.write!(fixture('images/fake.dng'), edits({ [ARTIST]: 'x' }))).rejects.toThrow(/not supported/);
    await expect(tiffHandler.strip!(fixture('images/fake.dng'), strip())).rejects.toThrow(/not supported/);

    const orf = await tiffHandler.read(fixture('images/fake.orf'));
    expect(orf.format.name).toBe('Olympus ORF raw image');
    expect(field(orf, ARTIST)?.value).toBe('Jane Doe');
    expect(field(orf, XMP_TITLE)?.value).toBe('Big Ben');
  });

  it('rejects BigTIFF with a clear message', async () => {
    const big = new Uint8Array([0x49, 0x49, 0x2b, 0, 8, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectScore(tiffHandler, big, 'a.tif')).toBe(2);
    await expect(read(big)).rejects.toThrow(/BigTIFF/);
  });
});

/**
 * `src` with an EXIF-style JPEG thumbnail (JPEGInterchangeFormat/Length) added to page `page`
 * (a rewritten directory appended after the thumbnail), optionally with its Compression replaced.
 */
function withThumbnail(src: Uint8Array, jpeg: Uint8Array, page = 0, compression?: number): Uint8Array {
  const le = src[0] === 0x49;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  let ptrAt = 4;
  let off = dv.getUint32(4, le);
  for (let i = 0; i < page; i++) {
    ptrAt = off + 2 + dv.getUint16(off, le) * 12;
    off = dv.getUint32(ptrAt, le);
  }
  const n = dv.getUint16(off, le);
  const next = dv.getUint32(off + 2 + n * 12, le);
  const thumbAt = src.length + (src.length % 2);
  const ifdAt = thumbAt + jpeg.length + (jpeg.length % 2);
  const entry = (tag: number, type: number, value: number) => {
    const e = new DataView(new ArrayBuffer(12));
    e.setUint16(0, tag, le);
    e.setUint16(2, type, le);
    e.setUint32(4, 1, le);
    if (type === 3) e.setUint16(8, value, le);
    else e.setUint32(8, value, le);
    return new Uint8Array(e.buffer);
  };
  const tagOf = (e: Uint8Array) => new DataView(e.buffer, e.byteOffset).getUint16(0, le);
  const entries = Array.from({ length: n }, (_, i) => src.slice(off + 2 + i * 12, off + 14 + i * 12)).filter(
    (e) => compression === undefined || tagOf(e) !== 0x0103,
  );
  entries.push(entry(0x0201, 4, thumbAt), entry(0x0202, 4, jpeg.length));
  if (compression !== undefined) entries.push(entry(0x0103, 3, compression));
  entries.sort((a, b) => tagOf(a) - tagOf(b));
  const out = new Uint8Array(ifdAt + 2 + entries.length * 12 + 4);
  out.set(src);
  out.set(jpeg, thumbAt);
  const v = new DataView(out.buffer);
  v.setUint16(ifdAt, entries.length, le);
  entries.forEach((e, i) => out.set(e, ifdAt + 2 + i * 12));
  v.setUint32(ifdAt + 2 + entries.length * 12, next, le);
  v.setUint32(ptrAt, ifdAt, le);
  return out;
}

/** camera.jpg's serial number: present in the thumbnail only. */
const THUMB_SECRET = 'F2LXK1234567';

describe('tiff: EXIF-style JPEG thumbnails', () => {
  it('shows the thumbnail and drops it on edit and strip, keeping the pixels', async () => {
    const src = withThumbnail(fixtureBytes('images/rich.tif'), fixtureBytes('jpeg/camera.jpg'));
    expect(containsText(src, THUMB_SECRET)).toBe(true);
    expect(decodeErrors(src, 'tif')).toBe('');
    const m = await read(src);
    expect(field(m, 'tiff:thumbnail')).toMatchObject({ kind: 'image', display: '160×120 JPEG preview — 8.9 KB', sensitivity: 'content', removable: true });

    const edited = await bytesOf(await tiffHandler.write!(Source.fromBytes(src, 't.tif'), edits({ 'tiff:thumbnail': REMOVE })));
    expect(containsText(edited, THUMB_SECRET)).toBe(false);
    expect(etProblems(await exiftool(edited, 't.tif'))).toEqual([]);
    const e = await read(edited);
    expect(field(e, 'tiff:thumbnail')).toBeUndefined();
    expect(field(e, ARTIST)?.value).toBe('Jane Doe');
    checkImage(edited, src);

    const out = await bytesOf(await tiffHandler.strip!(Source.fromBytes(src, 't.tif'), strip()));
    expect(containsText(out, THUMB_SECRET)).toBe(false);
    expect(etProblems(await exiftool(out, 't.tif'))).toEqual([]);
    expect(allFields(await read(out)).map((f) => f.id)).toEqual(['exif:ifd0:0112', 'tiff:icc']);
    checkImage(out, src, false);
  });

  it('drops thumbnails on further pages, in place too, but keeps old-style JPEG image data', async () => {
    const src = withThumbnail(fixtureBytes('images/multipage.tif'), fixtureBytes('jpeg/camera.jpg'), 1);
    const m = await read(src);
    expect(field(m, 'tiff:thumbnail')).toMatchObject({ removable: false }); // edits rewrite IFD0 only
    const out = await bytesOf(await tiffHandler.strip!(Source.fromBytes(src, 'm.tif'), strip()));
    expect(containsText(out, THUMB_SECRET)).toBe(false);
    expect(field(await read(out), 'tiff:thumbnail')).toBeUndefined();
    expect((await exiftool(out, 'm.tif'))['IFD1:ImageWidth']).toBe(6);
    checkImage(out, src, false);

    // unknown strip size on page 1: stripped in place, the thumbnail bytes are zeroed
    const damaged = src.slice();
    const dv = new DataView(damaged.buffer);
    const ifd0 = dv.getUint32(4);
    for (let i = 0; i < dv.getUint16(ifd0); i++) if (dv.getUint16(ifd0 + 2 + i * 12) === 0x117) dv.setUint16(ifd0 + 2 + i * 12, 0x9117);
    const inPlace = await bytesOf(await tiffHandler.strip!(Source.fromBytes(damaged, 'm.tif'), strip()));
    expect(inPlace.length).toBeGreaterThan(damaged.length);
    expect(containsText(inPlace, THUMB_SECRET)).toBe(false);
    expect(containsText(inPlace, 'JFIF')).toBe(false);

    // Compression 6: JPEGInterchangeFormat is the page's image data, not a thumbnail
    const old = withThumbnail(fixtureBytes('images/multipage.tif'), fixtureBytes('jpeg/camera.jpg'), 1, 6);
    expect(field(await read(old), 'tiff:thumbnail')).toBeUndefined();
    const kept = await bytesOf(await tiffHandler.strip!(Source.fromBytes(old, 'm.tif'), strip()));
    const t = parseTiffFile(kept); // big-endian
    const v = new DataView(kept.buffer);
    const page2 = v.getUint32(t.ifd0.offset + 2 + t.ifd0.entries.length * 12);
    const tags = Array.from({ length: v.getUint16(page2) }, (_, i) => v.getUint16(page2 + 2 + i * 12));
    expect(tags).toEqual(expect.arrayContaining([0x0103, 0x0201, 0x0202]));
    expect(containsText(kept, THUMB_SECRET)).toBe(true);
  });
});

describe('tiff: hostile directories', () => {
  /** Little-endian TIFF: header, then `body` at offset 8; IFD0 at `ifd0`. */
  const tiff = (body: Uint8Array, ifd0: number) => {
    const b = new Uint8Array(8 + body.length);
    b.set([0x49, 0x49, 0x2a, 0], 0);
    new DataView(b.buffer).setUint32(4, ifd0, true);
    b.set(body, 8);
    return b;
  };
  /** Write a directory of `entries` [tag, type, count, value] at `at` in `v`. */
  const dir = (v: DataView, at: number, entries: Array<[number, number, number, number]>, next = 0) => {
    v.setUint16(at, entries.length, true);
    entries.forEach(([tag, type, count, value], i) => {
      const p = at + 2 + i * 12;
      v.setUint16(p, tag, true);
      v.setUint16(p + 2, type, true);
      v.setUint32(p + 4, count, true);
      if (type === 3 && count === 1) v.setUint16(p + 8, value, true);
      else v.setUint32(p + 8, value, true);
    });
    v.setUint32(at + 2 + entries.length * 12, next, true);
  };

  it('reads 5,000 tags pointing at one 1 MB region without copying it for each', async () => {
    const MB = 1 << 20;
    const body = new Uint8Array(MB + 2 + 5000 * 12 + 4);
    const v = new DataView(body.buffer);
    dir(
      v,
      MB,
      Array.from({ length: 5000 }, (_, i): [number, number, number, number] => [0xc000 + i, 7, MB, 8]),
    );
    const file = tiff(body, 8 + MB); // the directory sits right after the region
    const m = await tiffHandler.read(Source.fromBytes(file, 'many.tif'));
    expect(m.format.id).toBe('tiff');
  });

  it('refuses directory chains with more entries than any real file', async () => {
    const pages = 20;
    const per = 60_000; // 1.2 million entries in all
    const size = 2 + per * 12 + 4;
    const body = new Uint8Array(pages * size);
    const v = new DataView(body.buffer);
    for (let k = 0; k < pages; k++) {
      dir(
        v,
        k * size,
        Array.from({ length: per }, (): [number, number, number, number] => [0x0100, 3, 1, 16]),
        k + 1 < pages ? 8 + (k + 1) * size : 0,
      );
    }
    await expect(tiffHandler.read(Source.fromBytes(tiff(body, 8), 'pages.tif'))).rejects.toThrow(/more directory entries than can be processed/);
  });

  it('keeps overlapping strips in place when stripping instead of copying each', async () => {
    const MB = 1 << 20;
    const strips = 512;
    const ifdAt = MB + 2 * strips * 4;
    const body = new Uint8Array(ifdAt + 2 + 9 * 12 + 4);
    const v = new DataView(body.buffer);
    // StripOffsets 8, 9, 10…, each strip almost 1 MB long: half a gigabyte if copied one by one.
    for (let i = 0; i < strips; i++) {
      v.setUint32(MB + i * 4, 8 + i, true);
      v.setUint32(MB + strips * 4 + i * 4, MB - strips, true);
    }
    dir(v, ifdAt, [
      [0x0100, 3, 1, 2048], // ImageWidth
      [0x0101, 3, 1, strips], // ImageLength
      [0x0102, 3, 1, 8], // BitsPerSample
      [0x0103, 3, 1, 1], // Compression: none
      [0x0106, 3, 1, 1], // Photometric: BlackIsZero
      [0x0111, 4, strips, 8 + MB], // StripOffsets
      [0x0116, 3, 1, 1], // RowsPerStrip
      [0x0117, 4, strips, 8 + MB + strips * 4], // StripByteCounts
      [0x0131, 2, 4, 0x00636261], // Software "abc"
    ]);
    const file = tiff(body, 8 + ifdAt);
    const out = await tiffHandler.strip!(Source.fromBytes(file, 'overlap.tif'), strip());
    expect(out.size).toBeLessThan(2 * file.length);
  });
});
