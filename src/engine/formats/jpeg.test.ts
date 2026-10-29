import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Source, groupKey, type GpsValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARKER, containsText, decodeErrors, hasTool, pixelHash } from './images.testutil';
import { ASCII, MAKERNOTE, UNDEFINED, emptyExif, makeAscii, makeBytes, parseTiff, writeTiff } from '../exif/tiff';
import { jpegHandler, parseJpeg } from './jpeg';
import { readMetadata } from '../index';

const ARTIST = 'exif:ifd0:013b';
const GPS = 'exif:gps:location';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const XMP_SUBJECT = 'xmp:http://purl.org/dc/elements/1.1/|subject';

describe('jpeg', () => {
  it('detects and reads a camera JPEG', async () => {
    const src = fixture('jpeg/camera.jpg');
    const m = await readMetadata(src.blob, 'camera.jpg');
    expect(m.format.id).toBe('jpeg');
    expect(m.info.find((i) => i.label === 'Dimensions')?.value).toBe('160 × 120');
    expect(field(m, ARTIST)?.value).toBe('Jane Doe');
    expect(field(m, 'exif:ifd0:010f')?.value).toBe('Apple');
    expect(field(m, 'exif:ifd0:0112')?.value).toBe('6');
    expect(field(m, 'exif:exif:9003')?.value).toBe('2024-05-01T18:29:59');
    expect(field(m, 'exif:exif:829a')?.display).toBe('1/125 s');
    expect(field(m, 'exif:exif:829d')?.display).toBe('f/1.8');
    expect(field(m, 'exif:exif:9286')?.value).toBe('Shot from the north tower');
    expect(field(m, 'exif:ifd0:9c9b')?.value).toBe('Brücke');
    const gps = field(m, GPS)?.value as GpsValue;
    expect(gps.lat).toBeCloseTo(37.8199, 4);
    expect(gps.lon).toBeCloseTo(-122.4783, 4);
    expect(gps.alt).toBeCloseTo(67.5, 1);
    expect(field(m, XMP_TITLE)?.value).toBe('Golden Gate');
    expect(field(m, XMP_SUBJECT)?.value).toEqual(['bridge', 'sunset', 'San Francisco']);
    expect(field(m, 'iptc:2:25')?.value).toEqual(['bridge', 'sunset']);
    expect(field(m, 'iptc:2:90')?.value).toBe('San Francisco');
    expect(field(m, 'jpeg:com:0')?.value).toBe('Edited with secret-tool v1');
    expect(m.warnings).toEqual([]);
  });

  it('edits EXIF, GPS, XMP, IPTC and comments; ExifTool agrees and validates', async () => {
    const src = fixture('jpeg/camera.jpg');
    const out = await jpegHandler.write!(
      src,
      edits({
        [ARTIST]: 'Zoë Smith',
        [GPS]: REMOVE,
        'exif:ifd0:4746': 4,
        'exif:exif:9003': '2023-12-24T20:15:00+01:00',
        [XMP_TITLE]: 'New title',
        [XMP_SUBJECT]: ['one', 'two'],
        'iptc:2:90': REMOVE,
        'iptc:2:120': 'Updated caption — ünïcödé',
        'jpeg:com:0': REMOVE,
        'jpeg:com:new': 'hello',
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.jpg');
    expect(etProblems(et)).toEqual([]);
    expect(et['IFD0:Artist']).toBe('Zoë Smith');
    expect(et['IFD0:Rating']).toBe(4);
    expect(et['ExifIFD:DateTimeOriginal']).toBe('2023:12:24 20:15:00');
    expect(et['ExifIFD:OffsetTimeOriginal']).toBe('+01:00');
    expect(etFind(et, 'GPSLatitude')).toEqual([]);
    expect(et['XMP-dc:Title']).toBe('New title');
    expect(et['XMP-dc:Subject']).toEqual(['one', 'two']);
    expect(et['IPTC:City']).toBeUndefined();
    expect(et['IPTC:Caption-Abstract']).toBe('Updated caption — ünïcödé');
    expect(et['IPTC:Keywords']).toEqual(['bridge', 'sunset']);
    expect(et['File:Comment']).toBe('hello');
    // untouched values survive
    expect(et['IFD0:Make']).toBe('Apple');
    expect(et['ExifIFD:SerialNumber']).toBe('F2LXK1234567');
    expect(et['XMP-photoshop:City']).toBe('San Francisco');

    // image data is untouched
    const a = parseJpeg(fixtureBytes('jpeg/camera.jpg'));
    const b = parseJpeg(bytes);
    expect(Buffer.from(b.bytes.subarray(b.scanStart, b.scanEnd)).equals(Buffer.from(a.bytes.subarray(a.scanStart, a.scanEnd)))).toBe(true);

    // and our own reader sees the same thing
    const m = await jpegHandler.read(fixture('jpeg/camera.jpg'));
    expect(field(m, ARTIST)?.value).toBe('Jane Doe');
  });

  it('adds GPS and metadata to a file without EXIF/XMP', async () => {
    const out = await jpegHandler.write!(
      fixture('jpeg/plain.jpg'),
      edits({
        [GPS]: { lat: -33.8568, lon: 151.2153, alt: -2.5 },
        [ARTIST]: 'Someone',
        [XMP_TITLE]: 'Opera House',
        'iptc:2:25': ['harbour', 'sydney'],
      }),
    );
    const et = await exiftool(out, 'out.jpg', ['-n']);
    expect(etProblems(et)).toEqual([]);
    expect(et['GPS:GPSLatitude']).toBeCloseTo(33.8568, 4);
    expect(et['GPS:GPSLatitudeRef']).toBe('S');
    expect(et['GPS:GPSLongitude']).toBeCloseTo(151.2153, 4);
    expect(et['GPS:GPSAltitudeRef']).toBe(1);
    expect(et['GPS:GPSAltitude']).toBeCloseTo(2.5, 2);
    expect(et['IFD0:Artist']).toBe('Someone');
    expect(et['XMP-dc:Title']).toBe('Opera House');
    expect(et['IPTC:Keywords']).toEqual(['harbour', 'sydney']);
    const m = await jpegHandler.read(new (await import('../core/types')).Source(out));
    const g = field(m, GPS)?.value as GpsValue;
    expect(g.lat).toBeCloseTo(-33.8568, 5);
    expect(g.alt).toBeCloseTo(-2.5, 2);
  });

  it('keeps little-endian EXIF little-endian', async () => {
    const out = await jpegHandler.write!(fixture('jpeg/le.jpg'), edits({ [ARTIST]: 'LE' }));
    const et = await exiftool(out, 'le.jpg');
    expect(etProblems(et)).toEqual([]);
    expect(et['IFD0:Artist']).toBe('LE');
    expect(et['IFD0:Model']).toBe('EOS R5');
    expect(et['ExifIFD:ISO']).toBe(400);
    expect(String(et['File:ExifByteOrder'])).toMatch(/Little/);
  });

  it('keeps a maker note that uses absolute offsets where it was when other values grow', async () => {
    const out = await bytesOf(await jpegHandler.write!(Source.fromBytes(canonJpeg(), 'canon.jpg'), edits({ 'exif:ifd0:010e': 'x'.repeat(3000) })));
    const et = await exiftool(out, 'canon.jpg');
    expect(etProblems(et)).toEqual([]);
    expect(String(et['IFD0:ImageDescription'])).toHaveLength(3000);
    expect(et['Canon:CanonFirmwareVersion']).toBe('Firmware Version 1.0.0');
    expect(et['Canon:OwnerName']).toBe('Ada Lovelace');
  });

  it('removes whole groups', async () => {
    const out = await jpegHandler.write!(
      fixture('jpeg/camera.jpg'),
      edits({ [groupKey('xmp')]: REMOVE, [groupKey('iptc')]: REMOVE }),
    );
    const et = await exiftool(out, 'x.jpg');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => k.startsWith('XMP') || k.startsWith('IPTC'))).toEqual([]);
    expect(et['IFD0:Artist']).toBe('Jane Doe');
  });

  it('strips everything except orientation and ICC', async () => {
    const out = await jpegHandler.strip!(fixture('jpeg/camera.jpg'), strip());
    const et = await exiftool(out, 's.jpg');
    expect(etProblems(et)).toEqual([]);
    const meta = etMetaKeys(et).filter((k) => !k.startsWith('JFIF:'));
    expect(meta).toEqual(['IFD0:Orientation']);
    const m = await jpegHandler.read(new (await import('../core/types')).Source(out));
    expect(m.groups.flatMap((g) => g.fields).map((f) => f.id)).toEqual(['exif:ifd0:0112']);
  });

  it('strips orientation too when asked', async () => {
    const out = await jpegHandler.strip!(fixture('jpeg/camera.jpg'), strip({ keepOrientation: false }));
    const et = await exiftool(out, 's.jpg');
    expect(etMetaKeys(et).filter((k) => !k.startsWith('JFIF:'))).toEqual([]);
    expect(etProblems(et)).toEqual([]);
  });
});

// ------------------------------------------------------------ hidden data

const enc = (t: string) => new TextEncoder().encode(t);
const cat = (...parts: Array<Uint8Array | number[]>) => Buffer.concat(parts.map((p) => Buffer.from(p as Uint8Array)));

/** A marker segment: FF marker, length, payload. */
function segment(marker: number, payload: Uint8Array | number[]): Uint8Array {
  const b = Buffer.from(payload as Uint8Array);
  return cat([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 0xff], b);
}

/**
 * plain.jpg with Canon EXIF. Like Canon's own, the maker note points at its
 * values by offsets from the start of the EXIF block, so it breaks if moved.
 */
function canonJpeg(): Uint8Array {
  const note = (base: number) => {
    const b = new Uint8Array(30 + 24 + 32);
    const v = new DataView(b.buffer);
    v.setUint16(0, 2, true);
    [
      [0x0007, 24, 30], // CanonFirmwareVersion
      [0x0009, 32, 54], // OwnerName
    ].forEach(([tag, count, at], i) => {
      v.setUint16(2 + i * 12, tag, true);
      v.setUint16(4 + i * 12, ASCII, true);
      v.setUint32(6 + i * 12, count, true);
      v.setUint32(10 + i * 12, base + at, true);
    });
    b.set(Buffer.from('Firmware Version 1.0.0', 'latin1'), 30);
    b.set(Buffer.from('Ada Lovelace', 'latin1'), 54);
    return b;
  };
  const d = emptyExif(true);
  d.ifd0.entries.push(makeAscii(0x010f, 'Canon'), makeAscii(0x0110, 'Canon EOS 5D'));
  d.exif = { entries: [makeBytes(MAKERNOTE, note(0), UNDEFINED)] };
  d.makerNoteOffset = parseTiff(writeTiff(d)).makerNoteOffset;
  d.exif.entries[0] = makeBytes(MAKERNOTE, note(d.makerNoteOffset!), UNDEFINED);
  return insert(fixtureBytes('jpeg/plain.jpg'), 2, segment(0xe1, cat(Buffer.from('Exif\0\0', 'latin1'), writeTiff(d))));
}

/** Insert `what` at `at`. */
const insert = (b: Uint8Array, at: number, ...what: Uint8Array[]) => new Uint8Array(cat(b.subarray(0, at), ...what, b.subarray(at)));

/** SOS..EOI of a JPEG. */
function scanOf(b: Uint8Array): Buffer {
  const j = parseJpeg(b);
  return Buffer.from(b.subarray(j.scanStart, j.scanEnd));
}

/** Offset of the marker that ends the first scan's entropy-coded data (FF00, fill bytes and RSTn do not). */
function endOfFirstScan(b: Uint8Array): number {
  const j = parseJpeg(b);
  let q = j.scanStart + 2 + ((b[j.scanStart + 2] << 8) | b[j.scanStart + 3]);
  for (;;) {
    q = b.indexOf(0xff, q);
    const m = b[q + 1];
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) q += 2;
    else if (m === 0xff) q++;
    else return q;
  }
}

/** The header EXIF segment of camera.jpg (GPS, artist, serial number). */
function cameraExif(): Uint8Array {
  const j = parseJpeg(fixtureBytes('jpeg/camera.jpg'));
  const s = j.segments.find((x) => x.kind === 'exif')!;
  return segment(0xe1, s.data);
}

const ids = async (b: Uint8Array) => allFields(await jpegHandler.read(Source.fromBytes(b, 'x.jpg'))).map((f) => f.id);

describe('jpeg: data the header walk does not see', () => {
  it('finds APPn/COM among the scans without mistaking stuffed bytes, fill bytes or RSTn for markers', async () => {
    const com = segment(0xfe, enc(`note ${MARKER}`));
    const app = segment(0xe1, enc('Exif\0\0junk'));
    const head = cat([0xff, 0xd8], segment(0xdb, new Array(65).fill(1)), segment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]));
    const sos = segment(0xda, [1, 1, 0, 0, 63, 0]);
    // entropy-coded data: stuffed FF00 (followed by what looks like a COM marker byte), RST0, fill bytes before RST1
    const data1 = [0x12, 0xff, 0x00, 0xfe, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78];
    const dht = segment(0xc4, [0x00, ...new Array(16).fill(0)]);
    const dri = segment(0xdd, [0, 4]);
    const body = cat(head, sos, data1, [0xff], com, dht, dri, sos, [0xff, 0x00, 0xab], app, [0xff, 0xd9]);
    const j = parseJpeg(body);
    expect(j.late.map((s) => [s.kind, s.offset])).toEqual([
      ['com', head.length + sos.length + data1.length + 1],
      ['exif', body.length - 2 - app.length],
    ]);
    expect(j.scanEnd).toBe(body.length);

    const m = await jpegHandler.read(Source.fromBytes(body, 'x.jpg'));
    expect(field(m, 'jpeg:late:0')).toMatchObject({ label: 'Comment inside the image data', display: `“note ${MARKER}”`, sensitivity: 'content', removable: true });
    expect(field(m, 'jpeg:late:1')).toMatchObject({ label: 'EXIF inside the image data', sensitivity: 'device' }); // unreadable: judged by kind

    const out = await bytesOf(await jpegHandler.strip!(Source.fromBytes(body, 'x.jpg'), strip()));
    expect(containsText(out, MARKER)).toBe(false);
    // every byte of the scans, tables and restart markers is kept, in order
    expect(scanOf(out).equals(cat(sos, data1, [0xff], dht, dri, sos, [0xff, 0x00, 0xab], [0xff, 0xd9]))).toBe(true);
    expect(parseJpeg(out).late).toEqual([]);
  });

  it('shows, removes and strips segments stored after the scan of a real photo', async () => {
    const src = fixtureBytes('jpeg/camera.jpg');
    const eoi = parseJpeg(src).scanEnd - 2;
    const bytes = insert(src, eoi, segment(0xfe, enc(`hidden ${MARKER}`)), cameraExif());
    expect(decodeErrors(bytes, 'jpg')).toBe('');

    const m = await jpegHandler.read(Source.fromBytes(bytes, 'x.jpg'));
    expect(field(m, 'jpeg:late:0')?.display).toBe(`“hidden ${MARKER}”`);
    expect(field(m, 'jpeg:late:1')).toMatchObject({ label: 'EXIF inside the image data', sensitivity: 'location' });
    expect(field(m, 'exif:ifd0:013b')?.value).toBe('Jane Doe'); // the header EXIF is still the one shown

    const edited = await bytesOf(await jpegHandler.write!(Source.fromBytes(bytes, 'x.jpg'), edits({ 'jpeg:late:0': REMOVE, [ARTIST]: 'Someone' })));
    expect(containsText(edited, MARKER)).toBe(false);
    expect(field(await jpegHandler.read(Source.fromBytes(edited, 'x.jpg')), 'jpeg:late:0')?.label).toBe('EXIF inside the image data');
    expect(pixelHash(edited, 'jpg')).toBe(pixelHash(src, 'jpg'));

    const out = await bytesOf(await jpegHandler.strip!(Source.fromBytes(bytes, 'x.jpg'), strip({ keepOrientation: false })));
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Jane Doe')).toBe(false);
    expect(containsText(out, 'F2LXK1234567')).toBe(false);
    expect(await ids(out)).toEqual([]);
    expect(scanOf(out).equals(scanOf(src))).toBe(true);
    expect(decodeErrors(out, 'jpg')).toBe('');
    expect(pixelHash(out, 'jpg')).toBe(pixelHash(src, 'jpg'));
  });

  it.skipIf(!hasTool('jpegtran'))('strips segments between progressive scans, keeping every scan, table and restart marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blueexif-jpeg-'));
    let prog: Uint8Array;
    try {
      const file = join(dir, 'in.jpg');
      writeFileSync(file, fixtureBytes('jpeg/camera.jpg'));
      execFileSync('jpegtran', ['-progressive', '-restart', '1', '-copy', 'all', '-outfile', join(dir, 'out.jpg'), file]);
      prog = new Uint8Array(readFileSync(join(dir, 'out.jpg')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const j = parseJpeg(prog);
    expect(j.sof?.marker).toBe(0xc2);
    expect(scanOf(prog).includes(Buffer.from([0xff, 0xd0]))).toBe(true); // restart markers in the data
    const at = endOfFirstScan(prog);
    const bytes = insert(prog, at, segment(0xfe, enc(`between scans ${MARKER}`)), cameraExif());
    expect(decodeErrors(bytes, 'jpg')).toBe('');
    expect(pixelHash(bytes, 'jpg')).toBe(pixelHash(prog, 'jpg'));

    const m = await jpegHandler.read(Source.fromBytes(bytes, 'p.jpg'));
    expect(m.info).toContainEqual({ label: 'Encoding', value: 'Progressive' });
    expect(field(m, 'jpeg:late:0')?.display).toBe(`“between scans ${MARKER}”`);
    expect(field(m, 'jpeg:late:1')?.sensitivity).toBe('location');

    const out = await bytesOf(await jpegHandler.strip!(Source.fromBytes(bytes, 'p.jpg'), strip()));
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'F2LXK1234567')).toBe(false);
    expect(await ids(out)).toEqual(['exif:ifd0:0112']);
    expect(scanOf(out).equals(scanOf(prog))).toBe(true);
    expect(decodeErrors(out, 'jpg')).toBe('');
    expect(pixelHash(out, 'jpg')).toBe(pixelHash(prog, 'jpg'));
    const et = await exiftool(out, 'p.jpg');
    expect(etProblems(et)).toEqual([]);
  });

  it('drops the JFIF thumbnail (keeping JFIF) and JFXX thumbnails', async () => {
    const plain = fixtureBytes('jpeg/plain.jpg');
    const first = parseJpeg(plain).segments[0];
    expect(first.kind).toBe('jfif');
    // JFIF 1.02, 72×72 dpi, with a 2×2 RGB thumbnail
    const rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    const jfif = segment(0xe0, [...enc('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 2, 2, ...rgb]);
    const jfxx = segment(0xe0, [...enc('JFXX\0'), 0x10, ...plain]);
    const bytes = new Uint8Array(cat([0xff, 0xd8], jfif, jfxx, plain.subarray(first.offset + 4 + first.data.length)));
    expect(decodeErrors(bytes, 'jpg')).toBe('');
    const before = await exiftool(bytes, 't.jpg');
    expect(before['JFIF:ThumbnailWidth']).toBe(2);

    const m = await jpegHandler.read(Source.fromBytes(bytes, 't.jpg'));
    expect(field(m, 'jpeg:jfifthumb')).toMatchObject({ display: '2 × 2 pixels, uncompressed — 12 B', sensitivity: 'content', removable: true });
    expect(field(m, 'jpeg:jfxx')?.display).toMatch(/^Thumbnail \(JFXX, JPEG\) — 4\.\d KB$/);
    expect(m.info).toContainEqual({ label: 'JFIF', value: 'v1.02, 72×72 dpi' });

    const check = async (out: Uint8Array) => {
      const j = parseJpeg(out);
      expect(j.segments[0].kind).toBe('jfif');
      expect([...j.segments[0].data]).toEqual([...enc('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0]);
      expect(j.segments.some((s) => s.kind === 'jfxx')).toBe(false);
      expect(scanOf(out).equals(scanOf(plain))).toBe(true);
      expect(pixelHash(out, 'jpg')).toBe(pixelHash(plain, 'jpg'));
      const et = await exiftool(out, 't.jpg');
      expect(etProblems(et)).toEqual([]);
      expect(etFind(et, 'ThumbnailWidth')).toEqual([]);
      expect(et['JFIF:XResolution']).toBe(72);
    };
    const edited = await bytesOf(await jpegHandler.write!(Source.fromBytes(bytes, 't.jpg'), edits({ 'jpeg:jfifthumb': REMOVE, 'jpeg:jfxx': REMOVE })));
    await check(edited);
    expect(await ids(edited)).toEqual(['jpeg:com:0']);
    const out = await bytesOf(await jpegHandler.strip!(Source.fromBytes(bytes, 't.jpg'), strip()));
    await check(out);
    expect(await ids(out)).toEqual([]);
  });
});
