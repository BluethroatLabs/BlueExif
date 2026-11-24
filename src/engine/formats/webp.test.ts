import { describe, expect, it } from 'vitest';
import { Source, groupKey, type GpsValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etProblems, exiftool, field, fieldByLabel, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARKER, containsText, decodeErrors, detectScore, etAllProblems, frameCount, hasTool, runOn } from './images.testutil';
import { parseWebp, webpHandler } from './webp';

const ARTIST = 'exif:ifd0:013b';
const GPS = 'exif:gps:location';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const XMP_SUBJECT = 'xmp:http://purl.org/dc/elements/1.1/|subject';

const ids = (b: Uint8Array) => parseWebp(b).chunks.map((c) => c.id);
const flags = (b: Uint8Array) => parseWebp(b).chunks.find((c) => c.id === 'VP8X')?.data[0];
/** The image payload: every VP8/VP8L/ALPH/ANIM/ANMF chunk, in order. */
const payload = (b: Uint8Array) =>
  Buffer.concat(
    parseWebp(b)
      .chunks.filter((c) => ['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF'].includes(c.id))
      .map((c) => Buffer.from(c.data)),
  );
const read = async (b: Uint8Array) => webpHandler.read(new Source(new Blob([b as BlobPart])));

/** libwebp's own structural validator, when installed. */
function webpinfoOk(b: Uint8Array): boolean {
  if (!hasTool('webpinfo')) return true;
  return runOn(b, 'webp', 'webpinfo', (f) => ['-quiet', f]).status === 0;
}

function checkImage(out: Uint8Array, original: Uint8Array) {
  expect(payload(out).equals(payload(original))).toBe(true);
  // Some ffmpeg builds (Ubuntu's 8.0, for one) cannot decode animated WebP at all; they are no oracle for those files.
  if (decodeErrors(original, 'webp') === '') expect(decodeErrors(out, 'webp')).toBe('');
  expect(webpinfoOk(out)).toBe(true);
  const riffSize = Buffer.from(out).readUInt32LE(4);
  expect(riffSize + 8).toBe(out.length);
}

describe('webp', () => {
  it('detects and reads EXIF, XMP and ICC', async () => {
    const bytes = fixtureBytes('images/rich.webp');
    expect(detectScore(webpHandler, bytes, 'x')).toBe(3);
    const m = await webpHandler.read(fixture('images/rich.webp'));
    expect(m.format.id).toBe('webp');
    expect(m.info).toEqual(
      expect.arrayContaining([
        { label: 'Dimensions', value: '32 × 24' },
        { label: 'Compression', value: 'Lossy (VP8)' },
        { label: 'Transparency', value: 'No' },
        { label: 'Color profile', value: 'Display P3' },
      ]),
    );
    expect(field(m, ARTIST)?.value).toBe('Jane Doe');
    expect(field(m, 'exif:ifd0:0110')?.value).toBe('Pixel 8');
    expect(field(m, 'exif:ifd0:0112')?.value).toBe('6');
    expect((field(m, GPS)?.value as GpsValue).lat).toBeCloseTo(48.8584, 4);
    expect(field(m, XMP_TITLE)?.value).toBe('Eiffel');
    expect(field(m, 'webp:iccp')?.display).toMatch(/^Display P3/);
    expect(fieldByLabel(m, 'Private chunk “PRIV”')?.kind).toBe('raw');
    expect(m.warnings).toEqual([]);

    const plain = await webpHandler.read(fixture('images/lossless.webp'));
    expect(plain.info).toEqual(expect.arrayContaining([{ label: 'Compression', value: 'Lossless (VP8L)' }]));
    const alpha = await webpHandler.read(fixture('images/alpha.webp'));
    expect(alpha.info).toEqual(expect.arrayContaining([{ label: 'Transparency', value: 'Yes' }]));
  });

  it('reads animation info', async () => {
    const m = await webpHandler.read(fixture('images/anim.webp'));
    expect(m.format.name).toBe('Animated WebP');
    expect(m.info).toEqual(
      expect.arrayContaining([
        { label: 'Dimensions', value: '16 × 16' },
        { label: 'Frames', value: '3' },
        { label: 'Loop', value: 'Forever' },
        { label: 'Duration', value: '0.3 s' },
      ]),
    );
    expect(field(m, XMP_TITLE)?.value).toBe(`Anim ${MARKER}`);
  });

  it('edits EXIF/XMP, drops ICC and private chunks; ExifTool agrees', async () => {
    const src = fixtureBytes('images/rich.webp');
    const before = await webpHandler.read(fixture('images/rich.webp'));
    const out = await bytesOf(
      await webpHandler.write!(
        fixture('images/rich.webp'),
        edits({
          [ARTIST]: 'Zoë Smith',
          [GPS]: REMOVE,
          'exif:exif:9003': '2023-12-24T20:15:00',
          [XMP_SUBJECT]: ['paris', 'tower'],
          'webp:iccp': REMOVE,
          [fieldByLabel(before, 'Private chunk “PRIV”')!.id]: REMOVE,
        }),
      ),
    );
    const et = await exiftool(out, 'out.webp');
    expect(etProblems(et)).toEqual([]);
    expect(await etAllProblems(out, 'out.webp')).toEqual([]);
    expect(et['IFD0:Artist']).toBe('Zoë Smith');
    expect(et['ExifIFD:DateTimeOriginal']).toBe('2023:12:24 20:15:00');
    expect(etFind(et, 'GPSLatitude')).toEqual([]);
    expect(et['XMP-dc:Subject']).toEqual(['paris', 'tower']);
    expect(et['XMP-dc:Title']).toBe('Eiffel');
    expect(et['IFD0:Make']).toBe('Google');
    expect(et['RIFF:WebP_Flags']).toBe('XMP, EXIF');
    expect(ids(out)).toEqual(['VP8X', 'VP8 ', 'EXIF', 'XMP ']);
    checkImage(out, src);
    const m = await read(out);
    expect(field(m, ARTIST)?.value).toBe('Zoë Smith');
    expect(field(m, 'webp:iccp')).toBeUndefined();
  });

  it('converts simple files to the extended format when adding metadata', async () => {
    for (const name of ['lossy.webp', 'lossless.webp', 'alpha.webp']) {
      const src = fixtureBytes(`images/${name}`);
      const out = await bytesOf(
        await webpHandler.write!(fixture(`images/${name}`), edits({ [ARTIST]: 'Someone', [GPS]: { lat: 1.5, lon: -2.25 }, [XMP_TITLE]: 'Added' })),
      );
      const et = await exiftool(out, name, ['-n']);
      expect(await etAllProblems(out, name)).toEqual([]);
      expect(et['IFD0:Artist']).toBe('Someone');
      expect(et['GPS:GPSLongitude']).toBeCloseTo(2.25, 5);
      expect(et['XMP-dc:Title']).toBe('Added');
      expect(et['RIFF:ImageWidth']).toBe(32);
      expect(et['RIFF:ImageHeight']).toBe(24);
      expect(ids(out)[0]).toBe('VP8X');
      expect(flags(out)! & 0x10).toBe(name === 'alpha.webp' ? 0x10 : 0);
      expect(flags(out)! & 0x0c).toBe(0x0c);
      checkImage(out, src);
    }
  });

  it('removes whole groups and falls back to the simple format', async () => {
    const out = await bytesOf(await webpHandler.write!(fixture('images/lossy.webp'), edits({ [XMP_TITLE]: 'x' })));
    const back = await bytesOf(await webpHandler.write!(new Source(new Blob([out as BlobPart])), edits({ [groupKey('xmp')]: REMOVE })));
    expect(Buffer.from(back).equals(Buffer.from(fixtureBytes('images/lossy.webp')))).toBe(true);

    const rich = await bytesOf(await webpHandler.write!(fixture('images/rich.webp'), edits({ [groupKey('exif')]: REMOVE, [groupKey('xmp')]: REMOVE })));
    expect(ids(rich)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'PRIV']);
    expect(parseWebp(rich).chunks[3].data.length % 2).toBe(1); // odd-sized chunk keeps its pad byte
    expect(flags(rich)).toBe(0x20);
    checkImage(rich, fixtureBytes('images/rich.webp'));
    const et = await exiftool(rich, 'x.webp');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => /^(XMP|IFD0|ExifIFD|GPS)/.test(k))).toEqual([]);
  });

  it('strips everything except orientation and ICC', async () => {
    const src = fixtureBytes('images/rich.webp');
    const out = await bytesOf(await webpHandler.strip!(fixture('images/rich.webp'), strip()));
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Jane')).toBe(false);
    expect(ids(out)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'EXIF']);
    expect(flags(out)).toBe(0x28);
    const et = await exiftool(out, 's.webp');
    expect(etProblems(et)).toEqual([]);
    expect(et['IFD0:Orientation']).toBe('Rotate 90 CW');
    expect(allFields(await read(out)).map((f) => f.id)).toEqual(['exif:ifd0:0112', 'webp:iccp']);
    checkImage(out, src);

    // Without orientation and ICC nothing extended is left: back to the cwebp original.
    const bare = await bytesOf(await webpHandler.strip!(fixture('images/rich.webp'), strip({ keepOrientation: false, keepColorProfile: false })));
    expect(Buffer.from(bare).equals(Buffer.from(fixtureBytes('images/lossy.webp')))).toBe(true);
  });

  it('keeps animation on edit and strip', async () => {
    const src = fixtureBytes('images/anim.webp');
    const edited = await bytesOf(await webpHandler.write!(fixture('images/anim.webp'), edits({ [XMP_TITLE]: 'Loop', [ARTIST]: REMOVE })));
    const et = await exiftool(edited, 'a.webp');
    expect(etProblems(et)).toEqual([]);
    expect(et['XMP-dc:Title']).toBe('Loop');
    expect(et['IFD0:Artist']).toBeUndefined();
    checkImage(edited, src);
    expect(frameCount(edited, 'webp')).toBe(frameCount(src, 'webp'));

    const stripped = await bytesOf(await webpHandler.strip!(fixture('images/anim.webp'), strip()));
    expect(containsText(stripped, MARKER)).toBe(false);
    expect(ids(stripped)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF']);
    expect(flags(stripped)).toBe(0x02);
    checkImage(stripped, src);
    expect(frameCount(stripped, 'webp')).toBe(frameCount(src, 'webp'));
  });
});
