import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { crc32 } from '../core/binary';
import { Source, groupKey, type GpsValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etProblems, exiftool, field, fieldByLabel, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARKER, containsText, decodeErrors, detectScore, etAllProblems, frameCount } from './images.testutil';
import { parsePng, pngHandler } from './png';

const ARTIST = 'exif:ifd0:013b';
const GPS = 'exif:gps:location';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const XMP_SUBJECT = 'xmp:http://purl.org/dc/elements/1.1/|subject';

/** Concatenated raw IDAT/fdAT chunks: the compressed image data. */
function imageData(bytes: Uint8Array): Buffer {
  const png = parsePng(bytes);
  return Buffer.concat(png.chunks.filter((c) => c.type === 'IDAT' || c.type === 'fdAT' || c.type === 'fcTL').map((c) => Buffer.from(c.raw)));
}

const chunkTypes = (bytes: Uint8Array) => parsePng(bytes).chunks.map((c) => c.type);

/** `png` with extra chunks right after IHDR. */
function withChunks(png: Uint8Array, chunks: Array<[string, Uint8Array]>): Uint8Array {
  const parts = chunks.map(([type, data]) => {
    const c = Buffer.alloc(12 + data.length);
    c.writeUInt32BE(data.length, 0);
    c.write(type, 4, 'latin1');
    c.set(data, 8);
    c.writeUInt32BE(crc32(c.subarray(4, 8 + data.length)), 8 + data.length);
    return c;
  });
  return new Uint8Array(Buffer.concat([png.subarray(0, 33), ...parts, png.subarray(33)]));
}
const read = async (b: Uint8Array | Blob) => pngHandler.read(new Source(b instanceof Blob ? b : new Blob([b as BlobPart])));

describe('png', () => {
  it('detects and reads text, EXIF, XMP, IPTC, tIME and ICC', async () => {
    const bytes = fixtureBytes('images/rich.png');
    expect(detectScore(pngHandler, bytes, 'x.bin')).toBe(3);
    expect(detectScore(pngHandler, new Uint8Array(16), 'a.png')).toBe(1);
    const m = await pngHandler.read(fixture('images/rich.png'));
    expect(m.format.id).toBe('png');
    expect(m.info).toEqual(
      expect.arrayContaining([
        { label: 'Dimensions', value: '32 × 24' },
        { label: 'Color', value: 'RGB, 8-bit' },
        { label: 'Color profile', value: 'Display P3' },
      ]),
    );
    expect(field(m, 'png:text:Title')?.value).toBe('Sunset over the bay');
    expect(field(m, 'png:text:Author')?.sensitivity).toBe('identity');
    expect(field(m, 'png:text:Description')?.value).toBe('Grüße ☃ from the bay');
    expect(field(m, 'png:text:Copyright')?.value).toBe('© 2024 Jane Doe');
    expect(field(m, 'png:text:parameters')?.label).toBe('Generation parameters (AI)');
    expect(field(m, 'png:tIME')?.value).toBe('2024-05-02T01:29:59Z');
    expect(field(m, ARTIST)?.value).toBe('Jane Doe');
    expect(field(m, 'exif:ifd0:0112')?.value).toBe('6');
    expect((field(m, GPS)?.value as GpsValue).lon).toBeCloseTo(-122.4783, 4);
    expect(field(m, XMP_TITLE)?.value).toBe('Golden Gate');
    expect(field(m, 'iptc:2:25')?.value).toEqual(['bridge', 'sunset']);
    expect(field(m, 'iptc:2:90')?.value).toBe('San Francisco');
    expect(field(m, 'png:iccp')?.display).toMatch(/^Display P3/);
    expect(fieldByLabel(m, 'Private chunk “prVt”')?.kind).toBe('raw');
    expect(field(m, 'png:trailer')?.removable).toBe(true);
    expect(m.groups.find((g) => g.id === 'png')?.addable?.map((s) => s.id)).toContain('png:text:Source');
    expect(m.warnings).toEqual([]);
  });

  it('edits text, tIME, EXIF, XMP and IPTC; ExifTool agrees', async () => {
    const before = await pngHandler.read(fixture('images/rich.png'));
    const prvt = fieldByLabel(before, 'Private chunk “prVt”')!.id;
    const out = await pngHandler.write!(
      fixture('images/rich.png'),
      edits({
        'png:text:Title': 'Новый заголовок',
        'png:text:Author': 'Zoë Smith',
        'png:text:Comment': REMOVE,
        'png:text:Source': 'Nikon D850',
        'png:text:Project': 'Bay series',
        'png:tIME': '2023-12-24T20:15:00+01:00',
        [ARTIST]: 'Someone Else',
        [GPS]: REMOVE,
        [XMP_SUBJECT]: ['one', 'two'],
        'iptc:2:25': ['harbour'],
        [prvt]: REMOVE,
        'png:trailer': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.png');
    expect(etProblems(et)).toEqual([]);
    expect(await etAllProblems(bytes, 'out.png')).toEqual([]);
    expect(et['PNG:Title']).toBe('Новый заголовок');
    expect(et['PNG:Author']).toBe('Zoë Smith');
    expect(et['PNG:Comment']).toBeUndefined();
    expect(et['PNG:Source']).toBe('Nikon D850');
    expect(et['PNG:Project']).toBe('Bay series');
    expect(et['PNG:ModifyDate']).toBe('2023:12:24 19:15:00');
    expect(et['IFD0:Artist']).toBe('Someone Else');
    expect(etFind(et, 'GPSLatitude')).toEqual([]);
    expect(et['XMP-dc:Subject']).toEqual(['one', 'two']);
    expect(et['XMP-dc:Title']).toBe('Golden Gate');
    expect(et['IPTC:Keywords']).toBe('harbour');
    expect(et['IPTC:City']).toBe('San Francisco');
    expect(et['IFD0:Make']).toBe('Apple');
    expect(et['PNG:Description']).toBe('Grüße ☃ from the bay');
    expect(containsText(bytes, 'TRAILER')).toBe(false);
    expect(chunkTypes(bytes)).not.toContain('prVt');
    // ASCII stays tEXt; anything else becomes UTF-8 iTXt (as ExifTool does)
    const png = parsePng(bytes);
    const kw = (c: { data: Uint8Array }) => Buffer.from(c.data.subarray(0, c.data.indexOf(0))).toString('latin1');
    expect(png.chunks.find((c) => kw(c) === 'Source')?.type).toBe('tEXt');
    expect(png.chunks.find((c) => kw(c) === 'Author')?.type).toBe('iTXt');
    expect(png.chunks.find((c) => kw(c) === 'Title')?.type).toBe('iTXt');
    // every new or rewritten chunk sits before the image data
    const types = chunkTypes(bytes);
    expect(types.lastIndexOf('tEXt')).toBeLessThan(types.indexOf('IDAT'));
    expect(types.indexOf('eXIf')).toBeLessThan(types.indexOf('IDAT'));
    expect(imageData(bytes).equals(imageData(fixtureBytes('images/rich.png')))).toBe(true);
    expect(decodeErrors(bytes, 'png')).toBe('');

    const m = await read(bytes);
    expect(field(m, 'png:text:Title')?.value).toBe('Новый заголовок');
    expect(field(m, 'png:text:Project')?.value).toBe('Bay series');
    expect(field(m, 'png:tIME')?.value).toBe('2023-12-24T19:15:00Z');
    expect(field(m, ARTIST)?.value).toBe('Someone Else');
    expect(field(m, GPS)).toBeUndefined();
    expect(m.warnings).toEqual([]);
  });

  it('adds metadata to a bare PNG', async () => {
    const out = await pngHandler.write!(
      fixture('images/plain.png'),
      edits({
        [GPS]: { lat: -33.8568, lon: 151.2153, alt: 12 },
        [ARTIST]: 'Someone',
        [XMP_TITLE]: 'Opera House',
        'png:text:Title': 'Sydney',
        'png:tIME': '2024-01-02T03:04:05Z',
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.png', ['-n']);
    expect(await etAllProblems(bytes, 'out.png')).toEqual([]);
    expect(et['GPS:GPSLatitude']).toBeCloseTo(33.8568, 4);
    expect(et['GPS:GPSLatitudeRef']).toBe('S');
    expect(et['IFD0:Artist']).toBe('Someone');
    expect(et['XMP-dc:Title']).toBe('Opera House');
    expect(et['PNG:Title']).toBe('Sydney');
    expect(et['PNG:ModifyDate']).toBe('2024:01:02 03:04:05');
    const types = chunkTypes(bytes);
    expect(types.slice(0, 2)).toEqual(['IHDR', 'pHYs']);
    expect(types.slice(-2)).toEqual(['IDAT', 'IEND']);
    expect(decodeErrors(bytes, 'png')).toBe('');
    expect(imageData(bytes).equals(imageData(fixtureBytes('images/plain.png')))).toBe(true);
  });

  it('rejects invalid and reserved keywords', async () => {
    await expect(pngHandler.write!(fixture('images/plain.png'), edits({ 'png:text: bad': 'x' }))).rejects.toThrow(/not a valid PNG keyword/);
    await expect(pngHandler.write!(fixture('images/plain.png'), edits({ 'png:text:XML:com.adobe.xmp': 'x' }))).rejects.toThrow(/reserved/);
  });

  it('reads ImageMagick raw profiles and folds them into eXIf on edit', async () => {
    const m = await pngHandler.read(fixture('images/legacy.png'));
    expect(field(m, ARTIST)?.value).toBe(`Legacy ${MARKER}`);
    expect(field(m, XMP_TITLE)?.value).toBe('Legacy title');
    expect(field(m, 'png:text:date:create')?.sensitivity).toBe('time');
    const legacy = allFields(m).filter((f) => f.label.startsWith('Legacy '));
    expect(legacy.map((f) => f.label)).toEqual(['Legacy EXIF profile', 'Legacy XMP profile']);

    const out = await pngHandler.write!(fixture('images/legacy.png'), edits({ [ARTIST]: 'New Artist' }));
    const bytes = await bytesOf(out);
    expect(chunkTypes(bytes)).toContain('eXIf');
    expect(containsText(bytes, MARKER)).toBe(false);
    const et = await exiftool(bytes, 'out.png');
    expect(etProblems(et)).toEqual([]);
    expect(et['IFD0:Artist']).toBe('New Artist');
    expect(et['IFD0:Make']).toBe('Nikon');
    expect(et['XMP-dc:Title']).toBe('Legacy title');

    // removing the raw profile field drops it
    const out2 = await pngHandler.write!(fixture('images/legacy.png'), edits({ [legacy[1].id]: REMOVE }));
    const m2 = await read(await bytesOf(out2));
    expect(field(m2, XMP_TITLE)).toBeUndefined();
    expect(field(m2, ARTIST)?.value).toBe(`Legacy ${MARKER}`);
  });

  it('stays fast and bounded on hostile text chunks', async () => {
    const plain = fixtureBytes('images/plain.png');
    // A raw profile padded with spaces once made the profile parser backtrack for minutes.
    const padded = withChunks(plain, [['tEXt', new Uint8Array(Buffer.from(`Raw profile type exif\0${' '.repeat(400_000)}`, 'latin1'))]]);
    expect((await read(padded)).format.id).toBe('png');
    await bytesOf(await pngHandler.strip!(Source.fromBytes(padded), strip()));
    // Compressed text shares one budget per file: the first 40 MB chunk fits, the second does not.
    const bomb = new Uint8Array(Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), zlibSync(new Uint8Array(40 << 20))]));
    const two = withChunks(plain, [
      ['zTXt', bomb],
      ['zTXt', bomb],
    ]);
    const m = await read(two);
    expect(m.warnings).toEqual(['Text chunk could not be read: compressed data expands to more than 24 MB']);
    expect(chunkTypes(await bytesOf(await pngHandler.strip!(Source.fromBytes(two), strip())))).not.toContain('zTXt');
  });

  it('removes whole groups', async () => {
    const out = await pngHandler.write!(
      fixture('images/rich.png'),
      edits({ [groupKey('xmp')]: REMOVE, [groupKey('exif')]: REMOVE, [groupKey('iptc')]: REMOVE, [groupKey('png')]: REMOVE }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'x.png');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => /^(XMP|IPTC|IFD0|ExifIFD|GPS)/.test(k))).toEqual([]);
    expect(Object.keys(et).filter((k) => k.startsWith('PNG:') && /Title|Author|Comment|ModifyDate|Parameters/.test(k))).toEqual([]);
    expect(chunkTypes(bytes)).toEqual(['IHDR', 'iCCP', 'pHYs', 'prVt', 'IDAT', 'IEND']);
  });

  it('strips everything except orientation and ICC', async () => {
    const src = fixtureBytes('images/rich.png');
    const out = await bytesOf(await pngHandler.strip!(fixture('images/rich.png'), strip()));
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Jane')).toBe(false);
    expect(chunkTypes(out)).toEqual(['IHDR', 'iCCP', 'pHYs', 'eXIf', 'IDAT', 'IEND']);
    const et = await exiftool(out, 's.png');
    expect(etProblems(et)).toEqual([]);
    expect(et['IFD0:Orientation']).toBe('Rotate 90 CW');
    const m = await read(out);
    expect(allFields(m).map((f) => f.id)).toEqual(['exif:ifd0:0112', 'png:iccp']);
    expect(imageData(out).equals(imageData(src))).toBe(true);
    expect(decodeErrors(out, 'png')).toBe('');

    const bare = await bytesOf(await pngHandler.strip!(fixture('images/rich.png'), strip({ keepOrientation: false, keepColorProfile: false })));
    expect(chunkTypes(bare)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect(allFields(await read(bare))).toEqual([]);
  });

  it('keeps APNG animation chunks on edit and strip', async () => {
    const m = await pngHandler.read(fixture('images/anim.png'));
    expect(m.format.name).toBe('Animated PNG');
    expect(m.info).toEqual(
      expect.arrayContaining([
        { label: 'Frames', value: '3' },
        { label: 'Loop', value: 'Forever' },
      ]),
    );
    expect(field(m, 'png:text:Title')?.value).toBe(`Anim ${MARKER}`);

    const src = fixtureBytes('images/anim.png');
    const edited = await bytesOf(await pngHandler.write!(fixture('images/anim.png'), edits({ 'png:text:Title': 'Loop', [ARTIST]: 'A' })));
    const types = chunkTypes(edited);
    expect(types.indexOf('eXIf')).toBeLessThan(types.indexOf('fcTL'));
    expect(imageData(edited).equals(imageData(src))).toBe(true);
    expect(await etAllProblems(edited, 'a.png')).toEqual([]);
    expect(frameCount(edited, 'apng')).toBe(3);

    const stripped = await bytesOf(await pngHandler.strip!(fixture('images/anim.png'), strip()));
    expect(containsText(stripped, MARKER)).toBe(false);
    expect(chunkTypes(stripped)).toEqual(['IHDR', 'pHYs', 'PLTE', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
    expect(frameCount(stripped, 'apng')).toBe(3);
    expect(decodeErrors(stripped, 'apng')).toBe('');
  });
});
