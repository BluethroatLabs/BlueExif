import { describe, expect, it } from 'vitest';
import { Source, groupKey } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etProblems, exiftool, field, fieldByLabel, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARKER, containsText, decodeErrors, detectScore, etAllProblems, etValues, frameCount } from './images.testutil';
import { gifHandler, parseGif } from './gif';

const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const XMP_CREATOR = 'xmp:http://purl.org/dc/elements/1.1/|creator';
const XMP_SUBJECT = 'xmp:http://purl.org/dc/elements/1.1/|subject';

/** Graphic control extensions + image blocks: everything that draws pixels. */
function frames(bytes: Uint8Array): Buffer {
  const g = parseGif(bytes);
  return Buffer.concat(g.blocks.filter((b) => b.type === 0x2c || b.label === 0xf9).map((b) => Buffer.from(bytes.subarray(b.start, b.end))));
}
const header = (b: Uint8Array) => Buffer.from(b.subarray(0, parseGif(b).headerEnd));
const apps = (b: Uint8Array) => parseGif(b).blocks.flatMap((x) => (x.app ? [x.app] : []));
const read = async (b: Uint8Array) => gifHandler.read(new Source(new Blob([b as BlobPart])));

function checkImage(out: Uint8Array, src: Uint8Array) {
  expect(frames(out).equals(frames(src))).toBe(true);
  expect(header(out).equals(header(src))).toBe(true);
  expect(out[out.length - 1] === 0x3b || parseGif(out).hasTrailer).toBe(true);
  expect(decodeErrors(out, 'gif')).toBe('');
  expect(frameCount(out, 'gif')).toBe(frameCount(src, 'gif'));
}

describe('gif', () => {
  it('detects and reads comments, XMP, ICC and private blocks', async () => {
    expect(detectScore(gifHandler, fixtureBytes('images/rich.gif'), 'x')).toBe(3);
    const m = await gifHandler.read(fixture('images/rich.gif'));
    expect(m.format.name).toBe('Animated GIF');
    expect(m.info).toEqual(
      expect.arrayContaining([
        { label: 'Dimensions', value: '32 × 24' },
        { label: 'Frames', value: '3' },
        { label: 'Loop', value: 'Forever' },
        { label: 'Duration', value: '0.6 s' },
        { label: 'Color profile', value: 'Display P3' },
      ]),
    );
    expect(field(m, 'gif:comment:0')?.value).toBe(`Made by Jane ${MARKER}`);
    expect(field(m, XMP_TITLE)?.value).toBe('Test pattern');
    expect(field(m, XMP_CREATOR)?.value).toEqual(['Jane Doe']);
    expect(field(m, 'gif:icc')?.display).toMatch(/^Display P3/);
    expect(fieldByLabel(m, 'Photoshop resources (ImageMagick)')?.kind).toBe('raw');
    expect(fieldByLabel(m, 'Plain text overlay')?.display).toBe(`caption ${MARKER}`);
    expect(field(m, 'gif:trailer')).toBeDefined();
    expect(m.warnings).toEqual([]);

    const still = await gifHandler.read(fixture('images/still.gif'));
    expect(still.format.name).toBe('GIF image');
    expect(still.groups.find((g) => g.id === 'gif.comments')?.addable?.[0].id).toBe('gif:comment:new');
  });

  it('edits comments and XMP; ExifTool agrees', async () => {
    const src = fixtureBytes('images/rich.gif');
    const before = await gifHandler.read(fixture('images/rich.gif'));
    const out = await bytesOf(
      await gifHandler.write!(
        fixture('images/rich.gif'),
        edits({
          'gif:comment:0': 'Edited — ünïcödé',
          'gif:comment:new': 'Second comment',
          [XMP_TITLE]: 'New title',
          [XMP_SUBJECT]: ['a', 'b'],
          [XMP_CREATOR]: REMOVE,
          [fieldByLabel(before, 'Photoshop resources (ImageMagick)')!.id]: REMOVE,
          'gif:trailer': REMOVE,
        }),
      ),
    );
    const et = await exiftool(out, 'out.gif');
    expect(etProblems(et)).toEqual([]);
    expect(await etAllProblems(out, 'out.gif')).toEqual([]);
    expect(et['XMP-dc:Title']).toBe('New title');
    expect(et['XMP-dc:Subject']).toEqual(['a', 'b']);
    expect(et['XMP-dc:Creator']).toBeUndefined();
    expect(et['XMP-dc:Rights']).toBe(MARKER);
    expect(await etValues(out, 'out.gif', 'Comment')).toEqual(['Edited — ünïcödé', 'Second comment']);
    expect(et['GIF:AnimationIterations']).toBe('Infinite');
    expect(apps(out)).toEqual(['ICCRGBG1012', 'NETSCAPE2.0', 'XMP DataXMP']);
    checkImage(out, src);

    const m = await read(out);
    expect(allFields(m).filter((f) => f.id.startsWith('gif:comment:')).map((f) => f.value)).toEqual(['Edited — ünïcödé', 'Second comment']);
    expect(field(m, XMP_TITLE)?.value).toBe('New title');
    expect(fieldByLabel(m, 'Plain text overlay')).toBeDefined();
    expect(field(m, 'gif:trailer')).toBeUndefined();
    expect(m.warnings).toEqual([]);
  });

  it('adds a comment and XMP to a bare GIF', async () => {
    const src = fixtureBytes('images/still.gif');
    const out = await bytesOf(await gifHandler.write!(fixture('images/still.gif'), edits({ 'gif:comment:new': 'hello', [XMP_TITLE]: 'Added' })));
    const et = await exiftool(out, 'out.gif');
    expect(await etAllProblems(out, 'out.gif')).toEqual([]);
    expect(et['File:Comment']).toBe('hello');
    expect(et['XMP-dc:Title']).toBe('Added');
    // after the NETSCAPE loop extension, before the first frame
    const g = parseGif(out);
    expect(g.blocks.map((b) => b.app ?? b.label.toString(16)).slice(0, 4)).toEqual([...apps(src).slice(0, 1), 'XMP DataXMP', 'fe', 'f9'].filter(Boolean));
    checkImage(out, src);
  });

  it('removes whole groups', async () => {
    const out = await bytesOf(await gifHandler.write!(fixture('images/rich.gif'), edits({ [groupKey('xmp')]: REMOVE, [groupKey('gif.comments')]: REMOVE })));
    const et = await exiftool(out, 'x.gif');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => k.startsWith('XMP') || k === 'File:Comment')).toEqual([]);
    const m = await read(out);
    expect(m.groups.find((g) => g.id === 'gif.comments')?.fields).toEqual([]);
    expect(fieldByLabel(m, 'Plain text overlay')).toBeDefined();
  });

  it('strips everything except looping and the ICC profile', async () => {
    const src = fixtureBytes('images/rich.gif');
    const out = await bytesOf(await gifHandler.strip!(fixture('images/rich.gif'), strip()));
    expect(containsText(out, MARKER)).toBe(false);
    expect(containsText(out, 'Jane')).toBe(false);
    expect(apps(out)).toEqual(['ICCRGBG1012', 'NETSCAPE2.0']);
    const et = await exiftool(out, 's.gif');
    expect(etProblems(et)).toEqual([]);
    expect(et['GIF:AnimationIterations']).toBe('Infinite');
    expect(allFields(await read(out)).map((f) => f.id)).toEqual(['gif:icc']);
    checkImage(out, src);

    const bare = await bytesOf(await gifHandler.strip!(fixture('images/rich.gif'), strip({ keepColorProfile: false })));
    expect(apps(bare)).toEqual(['NETSCAPE2.0']);
    // identical to ffmpeg's original output: nothing was added along the way
    expect(Buffer.from(bare).equals(Buffer.from(fixtureBytes('images/anim.gif')))).toBe(true);
  });
});
