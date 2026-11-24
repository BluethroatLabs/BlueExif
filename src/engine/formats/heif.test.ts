import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concat, indexOfBytes } from '../core/binary';
import { parseBoxes, patchChunkOffsets, scanTopLevel, serializeNode, type BoxNode } from '../core/isobmff';
import { groupKey, Source, type GpsValue, type Metadata } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { heifHandler } from './heif';
import { mp4Handler } from './mp4';

const MARKER = 'SECRET-MARKER-42';
const ARTIST = 'exif:ifd0:013b';
const DESC = 'exif:ifd0:010e';
const GPS = 'exif:gps:location';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const XMP_DESC = 'xmp:http://purl.org/dc/elements/1.1/|description';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasSips = process.platform === 'darwin' && spawnSync('sips', ['--help']).status === 0;

/** Decoded-pixel fingerprints from ffmpeg and (on macOS) sips. */
function decode(bytes: Uint8Array, name: string): { ffmpeg: string; sips: string } {
  const dir = mkdtempSync(join(tmpdir(), 'blueexif-heif-'));
  try {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    const ff = hasFfmpeg ? spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-frames:v', '1', '-f', 'md5', '-'], { encoding: 'utf8' }) : null;
    let sips = '';
    if (hasSips) {
      // Render with ImageIO; hash the BMP pixel array (its header carries the EXIF resolution).
      const out = join(dir, 'out.bmp');
      const r = spawnSync('sips', ['-s', 'format', 'bmp', p, '--out', out], { encoding: 'utf8', timeout: 60_000 });
      if (r.status === 0) {
        const bmp = readFileSync(out);
        const pixels = bmp.subarray(bmp.readUInt32LE(10));
        sips = `${bmp.readInt32LE(18)}x${bmp.readInt32LE(22)} ${createHash('md5').update(pixels).digest('hex')}`;
      } else sips = `error: ${r.stderr}`;
    }
    return { ffmpeg: ff ? ff.stdout.trim() + ff.stderr.trim() : '', sips };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectSamePixels(out: Uint8Array, original: Uint8Array, name: string): void {
  const a = decode(original, name);
  const b = decode(out, name);
  expect(b.ffmpeg).toBe(a.ffmpeg);
  expect(b.sips).toBe(a.sips);
  if (hasFfmpeg) expect(b.ffmpeg).toMatch(/^MD5=/);
}

async function newProblems(out: Uint8Array, original: Uint8Array, name: string): Promise<string[]> {
  const before = new Set(etProblems(await exiftool(original, name)));
  return etProblems(await exiftool(out, name)).filter((w) => !before.has(w));
}

const has = (bytes: Uint8Array, s: string) => indexOfBytes(bytes, s) >= 0;
const reread = (b: Uint8Array, name: string): Promise<Metadata> => heifHandler.read(Source.fromBytes(b, name));
const topTypes = async (b: Uint8Array) => (await scanTopLevel(Source.fromBytes(b))).boxes.map((x) => x.type);

/**
 * An image sequence: plain.heic followed by the movie of iphone.mov (moov with
 * dated headers, QuickTime keys / user data, encoder names, and its mdat).
 */
async function heifSequence(): Promise<Uint8Array> {
  const heic = fixtureBytes('isobmff/plain.heic');
  const mov = fixtureBytes('isobmff/iphone.mov');
  const top = (await scanTopLevel(Source.fromBytes(mov))).boxes;
  expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
  const [ftyp, mb, mdat] = top;
  const payload = mov.subarray(mb.start + mb.headerSize, mb.end);
  const tree = parseBoxes(payload, 0, payload.length, (t) => (['trak', 'mdia', 'minf', 'stbl'].includes(t) ? 0 : null));
  const moov: BoxNode = { type: 'moov', children: tree.boxes, tail: tree.tail };
  patchChunkOffsets(moov, (o) => o + heic.length - ftyp.end);
  return concat([heic, serializeNode(moov), mov.subarray(mdat.start)]);
}

describe('heif: detection and reading', () => {
  it('claims HEIC/AVIF by brand and meta box, leaves MP4 alone', () => {
    const ctx = (f: string) => {
      const head = fixtureBytes(`isobmff/${f}`).subarray(0, 65536);
      return { head, name: f, ext: f.split('.').pop()!, size: head.length };
    };
    for (const f of ['camera.heic', 'plain.heic', 'camera.avif', 'plain.avif', 'grid.heic']) {
      expect(heifHandler.detect(ctx(f))).toBe(3);
      expect(mp4Handler.detect(ctx(f))).toBeLessThan(3);
    }
    expect(heifHandler.detect(ctx('tagged.mp4'))).toBe(0);
  });

  it('reads EXIF, GPS, XMP and image properties of a HEIC', async () => {
    const m = await heifHandler.read(fixture('isobmff/camera.heic'));
    expect(m.format).toMatchObject({ id: 'heif', name: 'HEIC image', mime: 'image/heic', category: 'image' });
    expect(m.info.find((i) => i.label === 'Dimensions')?.value).toBe('120 × 160 (stored 160 × 120)');
    expect(m.info.find((i) => i.label === 'Codec')?.value).toBe('HEVC');
    expect(m.info.find((i) => i.label === 'Orientation')?.value).toMatch(/^rotated 90° clockwise/);
    expect(m.info.find((i) => i.label === 'Items')?.value).toBe('3 (1 image, 2 metadata)');
    expect(field(m, ARTIST)?.value).toBe('Jane Doe');
    expect(field(m, DESC)?.value).toBe(MARKER);
    expect(field(m, 'exif:exif:a431')?.value).toBe('F2LXK1234567');
    const g = field(m, GPS)?.value as GpsValue;
    expect(g.lat).toBeCloseTo(37.8199, 4);
    expect(g.lon).toBeCloseTo(-122.4783, 4);
    expect(field(m, XMP_TITLE)?.value).toBe('Golden Gate');
    expect(m.warnings).toEqual([]);
  });

  it('reads AVIF, grid and ICC variants', async () => {
    const avif = await heifHandler.read(fixture('isobmff/camera.avif'));
    expect(avif.format).toMatchObject({ name: 'AVIF image', mime: 'image/avif' });
    expect(avif.info.find((i) => i.label === 'Codec')?.value).toBe('AV1');
    expect(field(avif, ARTIST)?.value).toBe('Jane Doe');
    const grid = await heifHandler.read(fixture('isobmff/grid.heic'));
    expect(grid.info.find((i) => i.label === 'Codec')?.value).toBe('HEVC (grid of 6 tiles)');
    expect(grid.info.find((i) => i.label === 'Dimensions')?.value).toBe('1100 × 600');
    const icc = await heifHandler.read(fixture('isobmff/icc.heic'));
    expect(icc.info.find((i) => i.label === 'Color profile')?.value).toBe('Display P3');
    expect(field(icc, 'heif:icc')?.display).toMatch(/^Display P3 — /);
    const et = await heifHandler.read(fixture('isobmff/et.avif'));
    expect(field(et, ARTIST)?.value).toBe(MARKER);
    expect((field(et, GPS)?.value as GpsValue).lat).toBeCloseTo(10.5, 5);
  });
});

describe('heif: writing', () => {
  it('rewrites a smaller EXIF/XMP payload in place', async () => {
    const original = fixtureBytes('isobmff/camera.heic');
    const out = await heifHandler.write!(
      fixture('isobmff/camera.heic'),
      edits({ [DESC]: 'short', [GPS]: REMOVE, [ARTIST]: 'Zoë', [XMP_DESC]: 'tiny', [XMP_TITLE]: REMOVE }),
    );
    const bytes = await bytesOf(out);
    expect(bytes.length).toBe(original.length);
    expect(await topTypes(bytes)).toEqual(['ftyp', 'meta', 'mdat']);
    expect(has(bytes, MARKER)).toBe(false);
    expect(has(bytes, 'Golden Gate')).toBe(false);
    expect(await newProblems(bytes, original, 'x.heic')).toEqual([]);
    const et = await exiftool(bytes, 'x.heic');
    expect(et['IFD0:Artist']).toBe('Zoë');
    expect(et['IFD0:ImageDescription']).toBe('short');
    expect(etFind(et, 'GPSLatitude')).toEqual([]);
    expect(et['ExifIFD:SerialNumber']).toBe('F2LXK1234567');
    expect(et['XMP-dc:Description']).toBe('tiny');
    expect(et['XMP-dc:Title']).toBeUndefined();
    expect(et['XMP-photoshop:City']).toBe('San Francisco');
    expectSamePixels(bytes, original, 'x.heic');
    const m = await reread(bytes, 'x.heic');
    expect(field(m, ARTIST)?.value).toBe('Zoë');
    expect(field(m, GPS)).toBeUndefined();
    expect(m.warnings).toEqual([]);
  });

  it('moves a larger payload to a new mdat and zeroes the old bytes', async () => {
    const original = fixtureBytes('isobmff/camera.heic');
    const long = 'Long comment '.repeat(400);
    const out = await heifHandler.write!(fixture('isobmff/camera.heic'), edits({ 'exif:exif:9286': long, [DESC]: 'replaced', [XMP_DESC]: 'x'.repeat(4000) }));
    const bytes = await bytesOf(out);
    expect(await topTypes(bytes)).toEqual(['ftyp', 'meta', 'mdat', 'mdat']);
    expect(has(bytes, MARKER)).toBe(false);
    expect(await newProblems(bytes, original, 'x.heic')).toEqual([]);
    const et = await exiftool(bytes, 'x.heic');
    expect(et['ExifIFD:UserComment']).toBe(long.trim());
    expect(et['IFD0:ImageDescription']).toBe('replaced');
    expect(et['IFD0:Artist']).toBe('Jane Doe');
    expect(String(et['XMP-dc:Description'])).toHaveLength(4000);
    expectSamePixels(bytes, original, 'x.heic');
  });

  for (const f of ['plain.heic', 'plain.avif', 'grid.heic']) {
    it(`adds EXIF and XMP items to ${f}`, async () => {
      const original = fixtureBytes(`isobmff/${f}`);
      const out = await heifHandler.write!(
        fixture(`isobmff/${f}`),
        edits({ [GPS]: { lat: -33.8568, lon: 151.2153, alt: 12 }, [ARTIST]: 'Someone', 'exif:ifd0:010f': 'Maker', [XMP_TITLE]: 'Added title' }),
      );
      const bytes = await bytesOf(out);
      expect(await newProblems(bytes, original, f)).toEqual([]);
      const et = await exiftool(bytes, f, ['-n']);
      expect(et['GPS:GPSLatitude']).toBeCloseTo(33.8568, 4);
      expect(et['GPS:GPSLatitudeRef']).toBe('S');
      expect(et['GPS:GPSAltitude']).toBeCloseTo(12, 2);
      expect(et['IFD0:Artist']).toBe('Someone');
      expect(et['IFD0:Make']).toBe('Maker');
      expect(et['XMP-dc:Title']).toBe('Added title');
      expectSamePixels(bytes, original, f);
      const m = await reread(bytes, f);
      expect((field(m, GPS)?.value as GpsValue).lon).toBeCloseTo(151.2153, 5);
      expect(field(m, XMP_TITLE)?.value).toBe('Added title');
      expect(m.info.find((i) => i.label === 'Items')?.value).toMatch(/2 metadata/);
      expect(m.warnings).toEqual([]);
      // and the result can be edited again
      const again = await bytesOf(await heifHandler.write!(Source.fromBytes(bytes, f), edits({ [ARTIST]: 'Again' })));
      expect((await exiftool(again, f))['IFD0:Artist']).toBe('Again');
      expectSamePixels(again, original, f);
    });
  }

  it('gives an "extends to end of file" mdat an explicit size before appending', async () => {
    const original = fixtureBytes('isobmff/plain.heic').slice();
    const mdat = (await scanTopLevel(Source.fromBytes(original))).boxes.find((b) => b.type === 'mdat')!;
    original.set([0, 0, 0, 0], mdat.start); // size 0 = to end of file
    const out = await heifHandler.write!(Source.fromBytes(original, 'z.heic'), edits({ [ARTIST]: 'Zero' }));
    const bytes = await bytesOf(out);
    expect(await topTypes(bytes)).toEqual(['ftyp', 'meta', 'mdat', 'mdat']);
    expect(await newProblems(bytes, original, 'z.heic')).toEqual([]);
    expect((await exiftool(bytes, 'z.heic'))['IFD0:Artist']).toBe('Zero');
    expectSamePixels(bytes, original, 'z.heic');
  });

  it('edits a file laid out by ExifTool (metadata before image data)', async () => {
    const original = fixtureBytes('isobmff/et.avif');
    const out = await heifHandler.write!(fixture('isobmff/et.avif'), edits({ [ARTIST]: 'Much longer artist name '.repeat(10), [XMP_TITLE]: 'T' }));
    const bytes = await bytesOf(out);
    expect(has(bytes, MARKER)).toBe(false);
    expect(await newProblems(bytes, original, 'x.avif')).toEqual([]);
    const et = await exiftool(bytes, 'x.avif');
    expect(String(et['IFD0:Artist'])).toMatch(/^Much longer artist name/);
    expect(et['XMP-dc:Title']).toBe('T');
    expectSamePixels(bytes, original, 'x.avif');
  });

  it('removes EXIF / XMP items and the ICC profile', async () => {
    const original = fixtureBytes('isobmff/icc.heic');
    const out = await heifHandler.write!(fixture('isobmff/icc.heic'), edits({ [groupKey('exif')]: REMOVE, [groupKey('xmp.dc')]: REMOVE, 'heif:icc': REMOVE }));
    const bytes = await bytesOf(out);
    // xmp.dc is not removable as a group; only EXIF goes
    const et = await exiftool(bytes, 'x.heic');
    expect(await newProblems(bytes, original, 'x.heic')).toEqual([]);
    expect(Object.keys(et).filter((k) => /^(IFD0|ExifIFD|GPS)/.test(k))).toEqual([]);
    expect(et['XMP-dc:Title']).toBe('Golden Gate');
    expect(Object.keys(et).filter((k) => k.startsWith('ICC'))).toEqual([]);
    const m = await reread(bytes, 'x.heic');
    expect(m.info.find((i) => i.label === 'Items')?.value).toBe('2 (1 image, 1 metadata)');
    expect(field(m, 'heif:icc')).toBeUndefined();
    if (hasFfmpeg) expect(decode(bytes, 'x.heic').ffmpeg).toMatch(/^MD5=/);
  });
});

describe('heif: strip', () => {
  for (const f of ['camera.heic', 'camera.avif', 'et.avif', 'icc.heic', 'plain.heic', 'grid.heic']) {
    it(`removes all metadata from ${f}`, async () => {
      const original = fixtureBytes(`isobmff/${f}`);
      const bytes = await bytesOf(await heifHandler.strip!(fixture(`isobmff/${f}`), strip()));
      for (const s of [MARKER, 'Jane Doe', 'F2LXK1234567', 'San Francisco', 'iPhone']) expect(has(bytes, s)).toBe(false);
      expect(await newProblems(bytes, original, f)).toEqual([]);
      const et = await exiftool(bytes, f);
      expect(etMetaKeys(et).filter((k) => /^(IFD|ExifIFD|GPS|XMP|IPTC|InteropIFD)/.test(k))).toEqual([]);
      const m = await reread(bytes, f);
      expect(allFields(m).filter((x) => x.id !== 'heif:icc')).toEqual([]);
      expectSamePixels(bytes, original, f);
    });
  }

  it('drops the ICC profile only when asked', async () => {
    const keep = await bytesOf(await heifHandler.strip!(fixture('isobmff/icc.heic'), strip()));
    expect((await exiftool(keep, 'x.heic'))['ICC_Profile:ProfileDescription']).toBe('Display P3');
    const drop = await bytesOf(await heifHandler.strip!(fixture('isobmff/icc.heic'), strip({ keepColorProfile: false })));
    const et = await exiftool(drop, 'x.heic');
    expect(Object.keys(et).filter((k) => k.startsWith('ICC'))).toEqual([]);
    expect(await newProblems(drop, fixtureBytes('isobmff/icc.heic'), 'x.heic')).toEqual([]);
    if (hasFfmpeg) expect(decode(drop, 'x.heic').ffmpeg).toMatch(/^MD5=/);
  });
});

describe('heif: hostile item locations', () => {
  it('refuses to remove an item that points outside the file, instead of wiping or leaving bytes', async () => {
    const b = fixtureBytes('isobmff/camera.heic').slice();
    // camera.heic: iloc v0, 4-byte lengths; the Exif item's (item 2) extent length sits at byte 537.
    const v = new DataView(b.buffer);
    expect(v.getUint32(537)).toBe(422);
    v.setUint32(537, 0xffffffff);
    const m = await heifHandler.read(Source.fromBytes(b, 'bad.heic'));
    expect(m.warnings.join('\n')).toMatch(/EXIF item data could not be located/);
    await expect(heifHandler.strip!(Source.fromBytes(b, 'bad.heic'), strip())).rejects.toThrow(/points outside the file/);
  });
});

describe('heif: image sequences', () => {
  it('shows the movie, track and media header dates', async () => {
    const m = await reread(await heifSequence(), 'seq.heic');
    expect(m.info.find((i) => i.label === 'Image sequence')).toBeDefined();
    const dates = m.groups.find((g) => g.id === 'heif.dates')!;
    expect(dates.removable).toBe(true);
    expect(field(m, 'heif:mvhd:created')).toMatchObject({ kind: 'datetime', value: '2024-05-02T01:29:59Z', sensitivity: 'time', editable: true });
    expect(field(m, 'heif:mvhd:modified')?.value).toBe('2024-05-02T01:30:00Z');
    expect(field(m, 'heif:tkhd:1:created')?.value).toBe('2024-05-02T01:29:59Z');
    expect(field(m, 'heif:mdhd:1:created')?.value).toBe('2024-05-02T01:29:59Z');
  });

  it('edits and removes header dates', async () => {
    const original = await heifSequence();
    const out = await heifHandler.write!(
      Source.fromBytes(original, 'seq.heic'),
      edits({ 'heif:mvhd:created': '2023-12-24T20:15:00+01:00', 'heif:tkhd:1:created': REMOVE, [ARTIST]: 'Someone' }),
    );
    const bytes = await bytesOf(out);
    expect(await newProblems(bytes, original, 'seq.heic')).toEqual([]);
    const et = await exiftool(bytes, 'seq.heic');
    expect(et['QuickTime:CreateDate']).toBe('2023:12:24 19:15:00');
    expect(et['Track1:TrackCreateDate']).toBe('0000:00:00 00:00:00');
    expect(et['IFD0:Artist']).toBe('Someone');
    expectSamePixels(bytes, original, 'seq.heic');
    const m = await reread(bytes, 'seq.heic');
    expect(field(m, 'heif:mvhd:created')?.value).toBe('2023-12-24T19:15:00Z');
    expect(field(m, 'heif:tkhd:1:created')).toBeUndefined();
    expect(field(m, 'heif:mdhd:1:created')?.value).toBe('2024-05-02T01:29:59Z');
    const none = await bytesOf(await heifHandler.write!(Source.fromBytes(bytes, 'seq.heic'), edits({ [groupKey('heif.dates')]: REMOVE })));
    expect(allFields(await reread(none, 'seq.heic')).filter((f) => f.kind === 'datetime' && f.id.startsWith('heif:'))).toEqual([]);
  });

  it('strip zeroes the dates and removes movie metadata and encoder names', async () => {
    const original = await heifSequence();
    for (const s of ['iPhone', 'Golden hour', 'libx264', 'FFMP', 'Handler']) expect(has(original, s)).toBe(true);
    const bytes = await bytesOf(await heifHandler.strip!(Source.fromBytes(original, 'seq.heic'), strip()));
    for (const s of [MARKER, 'iPhone', 'Golden hour', 'Apple', 'libx264', 'FFMP', 'Handler']) expect(has(bytes, s)).toBe(false);
    expect(await newProblems(bytes, original, 'seq.heic')).toEqual([]);
    const et = await exiftool(bytes, 'seq.heic');
    for (const k of [
      'QuickTime:CreateDate',
      'QuickTime:ModifyDate',
      'Track1:TrackCreateDate',
      'Track1:TrackModifyDate',
      'Track1:MediaCreateDate',
      'Track2:MediaModifyDate',
    ]) {
      expect(et[k]).toBe('0000:00:00 00:00:00');
    }
    expect(etMetaKeys(et).filter((k) => /^(Keys|UserData|ItemList|XMP|IFD|ExifIFD|GPS)/.test(k))).toEqual([]);
    expect(allFields(await reread(bytes, 'seq.heic'))).toEqual([]);
    expectSamePixels(bytes, original, 'seq.heic');
  });

  it('blanks the item handler name on strip', async () => {
    const original = fixtureBytes('isobmff/plain.avif');
    expect(has(original, 'PictureHandler')).toBe(true);
    const bytes = await bytesOf(await heifHandler.strip!(fixture('isobmff/plain.avif'), strip()));
    expect(has(bytes, 'PictureHandler')).toBe(false);
    expect(await newProblems(bytes, original, 'x.avif')).toEqual([]);
    expectSamePixels(bytes, original, 'x.avif');
  });
});
