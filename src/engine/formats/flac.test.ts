import { describe, expect, it } from 'vitest';
import { Source, groupKey, type DetectContext, type ImageValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARK, contains, decode, ffprobeTags } from './audio.testlib';
import { flacAudio, flacHandler } from './flac';

const ctx = (rel: string): DetectContext => {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return { head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length };
};
const info = (m: { info: { label: string; value: string }[] }, label: string) => m.info.find((i) => i.label === label)?.value;

async function sameAudio(out: Blob, rel: string): Promise<void> {
  const a = await flacAudio(fixture(rel));
  const b = await flacAudio(new Source(out));
  expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  const d = decode(await bytesOf(out), 'x.flac');
  expect(d.errors).toBe('');
  expect(d.md5).toBe(decode(fixtureBytes(rel), 'x.flac').md5);
}

describe('flac', () => {
  it('detects FLAC, also behind an ID3 tag', () => {
    expect(flacHandler.detect(ctx('audio/tagged.flac'))).toBe(3);
    expect(flacHandler.detect(ctx('audio/id3.flac'))).toBe(3);
    expect(flacHandler.detect(ctx('audio/v23.mp3'))).toBe(0);
    expect(flacHandler.detect(ctx('audio/flac.oga'))).toBe(0);
  });

  it('reads stream info, Vorbis comments and pictures', async () => {
    const m = await flacHandler.read(fixture('audio/tagged.flac'));
    expect(m.format.id).toBe('flac');
    expect(info(m, 'Sample rate')).toBe('8000 Hz');
    expect(info(m, 'Channels')).toBe('Mono');
    expect(info(m, 'Bits per sample')).toBe('16');
    expect(info(m, 'Duration')).toBe('0.50 s');
    expect(info(m, 'Audio MD5')).toMatch(/^[0-9a-f]{32}$/);
    expect(field(m, 'vorbis:TITLE')?.value).toBe('Test Song');
    expect(field(m, 'vorbis:ARTIST')?.value).toBe('Zoë Smith');
    expect(field(m, 'vorbis:ARTIST')?.sensitivity).toBe('identity');
    expect(field(m, 'vorbis:DATE')?.value).toBe('2024-05-01');
    expect(field(m, 'vorbis:DATE')?.kind).toBe('datetime');
    expect(field(m, 'vorbis:TRACKNUMBER')?.value).toBe('3/12');
    expect(field(m, 'vorbis:DESCRIPTION')?.value).toBe(MARK);
    expect(field(m, 'vorbis:LOCATION')?.sensitivity).toBe('location');
    expect(field(m, 'vorbis:CONTACT')?.sensitivity).toBe('identity');
    expect(field(m, 'vorbis:ENCODER')?.sensitivity).toBe('software');
    expect(field(m, 'vorbis:vendor')?.display).toMatch(/^Lavf/);
    const pic = field(m, 'vorbis:picture:0')?.value as ImageValue;
    expect(pic.mime).toBe('image/jpeg');
    expect(pic.width).toBe(64);
    expect(m.warnings).toEqual([]);
  });

  it('reads a prepended ID3 tag, repeated keys and application blocks', async () => {
    const m = await flacHandler.read(fixture('audio/id3.flac'));
    expect(m.warnings.join()).toMatch(/ID3/);
    expect(field(m, 'id3:TIT2')?.value).toBe('ID3 in FLAC');
    expect(field(m, 'vorbis:ARTIST')?.value).toEqual(['First Artist', 'Second Artist']);
    expect(field(m, 'vorbis:DATE')?.value).toBe('2021');
    expect(field(m, 'flac:block:3')?.label).toBe('Application data (ATCH)');
    expect((field(m, 'vorbis:picture:0')?.value as ImageValue).pictureType).toBe(4);
  });

  it('edits comments and pictures; ExifTool and ffprobe agree, audio untouched', async () => {
    const out = await flacHandler.write!(
      fixture('audio/tagged.flac'),
      edits({
        'vorbis:TITLE': 'Neuer Titel',
        'vorbis:ARTIST': ['Анна', 'Bob'],
        'vorbis:DESCRIPTION': REMOVE,
        'vorbis:LOCATION': REMOVE,
        'vorbis:ORGANIZATION': 'ACME',
        'vorbis:DATE': '2020-02-03T04:05:00',
        'vorbis:picture:0': REMOVE,
        'vorbis:picture:new': { mime: 'image/jpeg', data: fixtureBytes('jpeg/plain.jpg'), pictureType: 3, description: 'front' },
      }),
    );
    const bytes = await bytesOf(out);
    expect(contains(bytes, MARK)).toBe(false);
    const et = await exiftool(bytes, 'out.flac');
    expect(etProblems(et)).toEqual([]);
    expect(et['Vorbis:Title']).toBe('Neuer Titel');
    expect(et['Vorbis:Artist']).toEqual(['Анна', 'Bob']);
    expect(et['Vorbis:Organization']).toBe('ACME');
    expect(et['Vorbis:Date']).toBe('2020-02-03T04:05:00');
    expect(et['Vorbis:Location']).toBeUndefined();
    expect(et['Vorbis:Album']).toBe('Demo Album');
    expect(et['FLAC:PictureWidth']).toBe(160);
    expect(et['FLAC:PictureType']).toBe('Front Cover');
    expect(et['FLAC:PictureDescription']).toBe('front');
    const probe = ffprobeTags(bytes, 'out.flac');
    expect(probe.title).toBe('Neuer Titel');
    expect(probe.album).toBe('Demo Album');
    await sameAudio(out, 'audio/tagged.flac');
    const m = await flacHandler.read(new Source(out));
    expect(field(m, 'vorbis:ARTIST')?.value).toEqual(['Анна', 'Bob']);
    expect(allFields(m).filter((f) => f.kind === 'image')).toHaveLength(1);
  });

  it('removes the prepended ID3 tag and application block, replacing repeated keys', async () => {
    const out = await flacHandler.write!(fixture('audio/id3.flac'), edits({ [groupKey('id3')]: REMOVE, 'flac:block:3': REMOVE, 'vorbis:ARTIST': 'Only One' }));
    const bytes = await bytesOf(out);
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x66, 0x4c, 0x61, 0x43]));
    const et = await exiftool(bytes, 'out.flac');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => k.startsWith('ID3'))).toEqual([]);
    expect(et['FLAC:ApplicationUnknown']).toBeUndefined();
    expect(et['FLAC:SeekTable']).toBeDefined();
    expect(et['Vorbis:Artist']).toBe('Only One');
    expect(et['Vorbis:Title']).toBe('Multi');
    await sameAudio(out, 'audio/id3.flac');

    const kept = await flacHandler.write!(fixture('audio/id3.flac'), edits({ 'id3:TIT2': 'Edited ID3' }));
    const et2 = await exiftool(kept, 'out.flac');
    expect(etProblems(et2)).toEqual([]);
    expect(et2['ID3v2_3:Title']).toBe('Edited ID3');
    expect(et2['Vorbis:Title']).toBe('Multi');
  });

  it('adds tags to a file with only a vendor string', async () => {
    const out = await flacHandler.write!(
      fixture('audio/plain.flac'),
      edits({ 'vorbis:TITLE': 'Fresh', 'vorbis:picture:new': { mime: 'image/jpeg', data: fixtureBytes('jpeg/plain.jpg') } }),
    );
    const et = await exiftool(out, 'out.flac');
    expect(etProblems(et)).toEqual([]);
    expect(et['Vorbis:Title']).toBe('Fresh');
    expect(et['FLAC:PictureType']).toBe('Front Cover');
    await sameAudio(out, 'audio/plain.flac');
  });

  it('strips everything but stream info (and cover art when asked)', async () => {
    for (const rel of ['audio/tagged.flac', 'audio/id3.flac']) {
      const out = await flacHandler.strip!(fixture(rel), strip());
      const bytes = await bytesOf(out);
      expect(contains(bytes, MARK)).toBe(false);
      const et = await exiftool(bytes, 'out.flac');
      expect(etProblems(et)).toEqual([]);
      expect(
        etMetaKeys(et).filter((k) => !/^FLAC:(BlockSize|FrameSize|SampleRate|Channels|BitsPerSample|TotalSamples|MD5Signature|Padding|SeekTable)/.test(k)),
      ).toEqual([]);
      const m = await flacHandler.read(new Source(out));
      expect(allFields(m)).toEqual([]);
      expect(m.warnings).toEqual([]);
      await sameAudio(out, rel);
    }
    const out = await flacHandler.strip!(fixture('audio/tagged.flac'), strip({ keepCoverArt: true }));
    const et = await exiftool(out, 'out.flac');
    expect(et['FLAC:Picture']).toBeDefined();
    expect(Object.keys(et).filter((k) => k.startsWith('Vorbis'))).toEqual([]);
  });
});

describe('flac: tags written by MP3 tools', () => {
  const tagged = fixtureBytes('audio/tagged.flac');
  /** ID3v1: "TAG", title, artist, album (30 bytes each), year, comment, genre. */
  const id3v1 = (title: string, artist: string) => {
    const b = new Uint8Array(128);
    b.set(Buffer.from('TAG', 'latin1'));
    b.set(Buffer.from(title, 'latin1'), 3);
    b.set(Buffer.from(artist, 'latin1'), 33);
    b[127] = 255;
    return b;
  };
  /** APEv2 with one text item, footer only. */
  const ape = (key: string, value: string) => {
    const item = Buffer.concat([Buffer.alloc(8), Buffer.from(`${key}\0${value}`, 'latin1')]);
    item.writeUInt32LE(value.length, 0);
    const footer = Buffer.alloc(32);
    footer.write('APETAGEX', 0, 'latin1');
    footer.writeUInt32LE(2000, 8);
    footer.writeUInt32LE(item.length + 32, 12);
    footer.writeUInt32LE(1, 16);
    return new Uint8Array(Buffer.concat([item, footer]));
  };

  it('reads, removes and strips ID3v1 and APEv2 tags appended after the audio', async () => {
    const b = new Uint8Array(Buffer.concat([tagged, ape('Artist', `Jane ${MARK}`), id3v1('Song', `Jane ${MARK}`)]));
    const src = () => Source.fromBytes(b, 'x.flac');
    const m = await flacHandler.read(src());
    expect(m.warnings.join('\n')).toMatch(/appended after the audio/);
    expect(
      allFields(m)
        .filter((f) => f.id.startsWith('flac:trailer:'))
        .map((f) => f.label),
    ).toEqual(['APEv2 tag', 'ID3v1 tag']);
    expect(field(m, 'flac:trailer:1')?.display).toBe(`Song · Jane ${MARK}`);
    expect(info(m, 'Duration')).toBe(info(await flacHandler.read(fixture('audio/tagged.flac')), 'Duration'));

    // An unrelated edit keeps them; removing one drops only that one.
    const kept = await bytesOf(await flacHandler.write!(src(), edits({ 'vorbis:TITLE': 'New' })));
    expect(Buffer.from(kept.subarray(kept.length - 128)).equals(Buffer.from(b.subarray(b.length - 128)))).toBe(true);
    const one = await flacHandler.write!(src(), edits({ 'flac:trailer:1': REMOVE }));
    expect(
      allFields(await flacHandler.read(new Source(one)))
        .filter((f) => f.id.startsWith('flac:trailer:'))
        .map((f) => f.label),
    ).toEqual(['APEv2 tag']);

    const out = await flacHandler.strip!(src(), strip());
    expect(contains(await bytesOf(out), MARK)).toBe(false);
    await sameAudio(out, 'audio/tagged.flac');
  });

  it('reads a file whose leading ID3 tag is followed by zero padding', async () => {
    const id3 = fixtureBytes('audio/id3.flac');
    const at = Buffer.from(id3).indexOf('fLaC');
    expect(at).toBeGreaterThan(0);
    const padded = new Uint8Array(Buffer.concat([id3.subarray(0, at), Buffer.alloc(1000), id3.subarray(at)]));
    expect(flacHandler.detect({ head: padded.subarray(0, 65536), name: 'x.flac', ext: 'flac', size: padded.length })).toBe(3);
    const m = await flacHandler.read(Source.fromBytes(padded, 'x.flac'));
    expect(m.format.id).toBe('flac');
    await sameAudio(await flacHandler.strip!(Source.fromBytes(padded, 'x.flac'), strip()), 'audio/id3.flac');
  });
});
