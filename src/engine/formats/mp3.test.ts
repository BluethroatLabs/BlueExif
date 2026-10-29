import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { Source, groupKey, type DetectContext, type ImageValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARK, contains, decode, ffprobeTags } from './audio.testlib';
import { parseId3v2 } from './id3';
import { mp3Handler, mp3Parts } from './mp3';

const ctx = (rel: string, name = rel.split('/').pop()!): DetectContext => {
  const b = fixtureBytes(rel);
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return { head: b.subarray(0, 65536), name, ext, size: b.length };
};
const reread = (b: Blob, name = 'out.mp3') => mp3Handler.read(new Source(b, name));
const info = (m: { info: { label: string; value: string }[] }, label: string) => m.info.find((i) => i.label === label)?.value;

/** Audio frames byte-identical, decode cleanly and (without kept trailing tags) to the same PCM. */
async function sameAudio(out: Blob, rel: string, pcm = true): Promise<void> {
  const a = await mp3Parts(fixture(rel));
  const b = await mp3Parts(new Source(out));
  expect(Buffer.from(b.audio).equals(Buffer.from(a.audio))).toBe(true);
  const bytes = await bytesOf(out);
  const d = decode(bytes, 'x.mp3');
  expect(d.errors).toBe('');
  // Reference: the bare audio frames (ffmpeg decodes APE/Lyrics3 trailers as junk).
  if (pcm) expect(d.md5).toBe(decode(a.audio, 'x.mp3').md5);
}

describe('mp3', () => {
  it('detects MPEG audio, looking past ID3 tags', () => {
    expect(mp3Handler.detect(ctx('audio/plain.mp3'))).toBe(3);
    expect(mp3Handler.detect(ctx('audio/v23.mp3'))).toBe(3);
    expect(mp3Handler.detect(ctx('audio/v22.mp3', 'file'))).toBe(3);
    expect(mp3Handler.detect(ctx('audio/id3.flac'))).toBe(0);
    expect(mp3Handler.detect(ctx('audio/plain.wav'))).toBe(0);
  });

  it('reads an ffmpeg ID3v2.3 + ID3v1 file', async () => {
    const m = await mp3Handler.read(fixture('audio/v23.mp3'));
    expect(m.format.id).toBe('mp3');
    expect(info(m, 'Format')).toBe('MPEG-1 Layer III');
    expect(info(m, 'Sample rate')).toBe('32000 Hz');
    expect(info(m, 'Channels')).toBe('Mono');
    expect(info(m, 'Duration')).toMatch(/^0\.[45]\d s$/);
    expect(info(m, 'Encoder')).toMatch(/^Lav/);
    expect(field(m, 'id3:TIT2')?.value).toBe('Test Song');
    expect(field(m, 'id3:TPE1')?.value).toBe('Zoë Smith');
    expect(field(m, 'id3:TPE1')?.sensitivity).toBe('identity');
    expect(field(m, 'id3:TDRC')?.value).toBe('2024-05-01');
    expect(field(m, 'id3:TCON')?.value).toBe('Rock');
    expect(field(m, 'id3:TRCK')?.value).toBe('3/12');
    expect(field(m, 'id3:TXXX:comment')?.value).toBe(MARK);
    expect(field(m, 'id3:TENC')?.sensitivity).toBe('identity');
    expect(field(m, 'id3:TSSE')?.sensitivity).toBe('software');
    const pic = field(m, 'id3:APIC:0')?.value as ImageValue;
    expect(pic.mime).toBe('image/jpeg');
    expect(pic.width).toBe(64);
    expect(field(m, 'id3v1:title')?.value).toBe('Test Song');
    expect(field(m, 'id3v1:track')?.value).toBe(3);
    expect(m.groups.find((g) => g.id === 'id3')?.source).toBe('ID3v2.3');
    expect(m.warnings).toEqual([]);
  });

  it('reads a VBR ID3v2.4 file', async () => {
    const m = await mp3Handler.read(fixture('audio/v24.mp3'));
    expect(info(m, 'Format')).toBe('MPEG-2 Layer III');
    expect(info(m, 'Bitrate')).toMatch(/^~\d+ kbps \(VBR\)$/);
    expect(info(m, 'Duration')).toMatch(/^0\.[45]\d s$/);
    expect(m.groups.find((g) => g.id === 'id3')?.source).toBe('ID3v2.4');
    expect(field(m, 'id3:TDRC')?.value).toBe('2024-05-01');
    expect(field(m, 'id3:TPE1')?.value).toBe('Zoë Smith');
    const out = await mp3Handler.write!(fixture('audio/v24.mp3'), edits({ 'id3:TDRC': '2001-02-03T04:05:06' }));
    const et = await exiftool(out, 'out.mp3');
    expect(etProblems(et)).toEqual([]);
    expect(et['ID3v2_4:RecordingTime']).toBe('2001:02:03 04:05:06');
    await sameAudio(out, 'audio/v24.mp3');
  });

  it('reads unsynchronised, compressed and exotic frames plus APE, Lyrics3 and ID3v1', async () => {
    const m = await mp3Handler.read(fixture('audio/rich.mp3'));
    expect(m.warnings).toEqual([]);
    expect(field(m, 'id3:TIT2')?.value).toBe('Rich Title');
    expect(field(m, 'id3:TPE1')?.value).toBe('Zoë Smith');
    expect(field(m, 'id3:TIT3')?.value).toBe('A compressed subtitle');
    expect(field(m, 'id3:TDRC')?.value).toBe('2023-12-24T20:15');
    expect(field(m, 'id3:TCON')?.value).toBe('Rock');
    expect(field(m, 'id3:TOWN')?.sensitivity).toBe('identity');
    expect(field(m, 'id3:COMM')?.value).toBe(`Comment ${MARK}`);
    expect(field(m, 'id3:COMM:iTunNORM')?.label).toBe('Comment (iTunNORM)');
    expect(field(m, 'id3:USLT')?.value).toBe('Some lyrics\nline two');
    expect(field(m, 'id3:TXXX:MusicBrainz Album Id')?.value).toBe('abc-123');
    expect(field(m, 'id3:WOAR')?.value).toBe('https://artist.example');
    expect(field(m, 'id3:WXXX:shop')?.value).toBe('https://shop.example');
    const pic = field(m, 'id3:APIC:0')?.value as ImageValue;
    expect(pic.pictureType).toBe(3);
    expect(pic.description).toBe('front');
    expect(pic.data[0]).toBe(0xff); // unsynchronisation undone
    expect(field(m, 'id3:POPM:0')?.display).toContain('jane@example.com');
    expect(field(m, 'id3:POPM:0')?.sensitivity).toBe('identity');
    expect(field(m, 'id3:PRIV:0')?.label).toContain('www.amazon.com');
    expect(field(m, 'id3:PRIV:0')?.sensitivity).toBe('identity');
    expect(field(m, 'id3:UFID:0')?.display).toContain('musicbrainz');
    expect(field(m, 'id3:GEOB:0')?.kind).toBe('raw');
    expect(field(m, 'ape:Artist')?.value).toBe(`Ape ${MARK}`);
    expect(field(m, 'mp3:lyrics3')?.kind).toBe('raw');
    expect(field(m, 'id3v1:comment')?.value).toBe(`V1 ${MARK}`);
    expect(field(m, 'id3v1:genre')?.display).toBe('Rock');
  });

  it('reads ID3v2.2 and merges a stacked tag', async () => {
    const m = await mp3Handler.read(fixture('audio/v22.mp3'));
    expect(m.groups.find((g) => g.id === 'id3')?.source).toBe('ID3v2.2');
    expect(field(m, 'id3:TIT2')?.value).toBe('Old Title');
    expect(field(m, 'id3:TCON')?.value).toBe('Pop');
    expect(field(m, 'id3:TDRC')?.value).toBe('1999');
    expect(field(m, 'id3:COMM')?.value).toBe(`Old ${MARK}`);
    expect(field(m, 'id3:TPE2')?.value).toBe('Stacked Album Artist');
    expect((field(m, 'id3:APIC:0')?.value as ImageValue).mime).toBe('image/jpeg');
    expect(m.warnings.join()).toMatch(/2 stacked ID3v2 tags/);
  });

  it('reads ID3v2.4 with extended header, frame unsync, data length indicator and multi-values', async () => {
    const m = await mp3Handler.read(fixture('audio/v24-unsync.mp3'));
    expect(m.warnings).toEqual([]);
    expect(field(m, 'id3:TPE1')?.value).toEqual(['Anna', 'Bert']);
    expect(field(m, 'id3:TCON')?.value).toEqual(['Rock', 'Synthwave']);
    expect(field(m, 'id3:TDRC')?.value).toBe('2022-03-04T05:06:07');
    expect(field(m, 'id3:TXXX:MOOD')?.value).toBe('calm');
    const rich = await mp3Handler.read(fixture('audio/rich.mp3'));
    const a = field(m, 'id3:APIC:0')?.value as ImageValue;
    const b = field(rich, 'id3:APIC:0')?.value as ImageValue;
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it('edits an ID3v2.3 tag; ExifTool, ffprobe and the ID3v1 mirror agree', async () => {
    const out = await mp3Handler.write!(
      fixture('audio/v23.mp3'),
      edits({
        'id3:TIT2': 'Neuer Titel',
        'id3:TPE1': ['Анна', 'Bob'],
        'id3:TDRC': '2020-02-03T04:05:00',
        'id3:TXXX:comment': REMOVE,
        'id3:COMM': 'Hello there',
        'id3:TXXX:Mood': 'happy',
        'id3:TCOM': 'Composer Name',
        'id3:APIC:new': { mime: 'image/jpeg', data: fixtureBytes('jpeg/plain.jpg'), pictureType: 4, description: 'back' },
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mp3');
    expect(etProblems(et)).toEqual([]);
    expect(et['ID3v2_3:Title']).toBe('Neuer Titel');
    expect(et['ID3v2_3:Artist']).toBe('Анна/Bob');
    expect(et['ID3v2_3:Year']).toBe(2020);
    expect(String(et['ID3v2_3:Date'])).toBe('0302');
    expect(String(et['ID3v2_3:Time'])).toBe('0405');
    expect(et['ID3v2_3:Comment']).toBe('Hello there');
    expect(et['ID3v2_3:Mood']).toBe('happy');
    expect(et['ID3v2_3:Composer']).toBe('Composer Name');
    expect(et['ID3v2_3:Album']).toBe('Demo Album');
    expect(et['ID3v1:Title']).toBe('Neuer Titel');
    expect(et['ID3v1:Comment']).toBe('Hello there');
    expect(et['ID3v1:Year']).toBe(2020);
    expect(contains(bytes, MARK)).toBe(false);
    const probe = ffprobeTags(bytes, 'out.mp3');
    expect(probe.title).toBe('Neuer Titel');
    expect(probe.album).toBe('Demo Album');
    await sameAudio(out, 'audio/v23.mp3');

    const m = await reread(out);
    expect(field(m, 'id3:TPE1')?.value).toEqual(['Анна', 'Bob']);
    expect(field(m, 'id3:TDRC')?.value).toBe('2020-02-03T04:05');
    expect(field(m, 'id3:APIC:1')?.label).toBe('Back cover — back');
    expect((field(m, 'id3:APIC:1')?.value as ImageValue).width).toBe(160);
    expect(field(m, 'id3:TXXX:comment')).toBeUndefined();
    expect(m.groups.find((g) => g.id === 'id3')?.source).toBe('ID3v2.3');
  });

  it('rewrites the rich tag without unsync, keeps APE/Lyrics3 edits and removes ID3v1', async () => {
    const out = await mp3Handler.write!(
      fixture('audio/rich.mp3'),
      edits({ 'ape:Title': 'New Ape', 'id3:PRIV:0': REMOVE, 'id3:POPM:0': REMOVE, [groupKey('id3v1')]: REMOVE, 'id3:COMM:iTunNORM': REMOVE }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mp3');
    expect(etProblems(et)).toEqual([]);
    expect(et['ID3v2_3:Title']).toBe('Rich Title');
    expect(et['ID3v2_3:Subtitle']).toBe('A compressed subtitle');
    expect(et['ID3v2_3:Comment']).toBe(`Comment ${MARK}`);
    expect(et['ID3v2_3:Picture']).toBeDefined();
    expect(et['ID3v2_3:Private']).toBeUndefined();
    expect(et['ID3v2_3:Popularimeter']).toBeUndefined();
    expect(et['APE:Title']).toBe('New Ape');
    expect(et['APE:Artist']).toBe(`Ape ${MARK}`);
    expect(et['Lyrics3:Lyrics']).toBe(`Lyrics3 ${MARK}`);
    expect(etFind(et, 'Title').filter((v) => v === 'V1 Title')).toEqual([]);
    await sameAudio(out, 'audio/rich.mp3', false);
    const m = await reread(out);
    expect((field(m, 'id3:APIC:0')?.value as ImageValue).data.length).toBe(1376);
  });

  it('keeps ID3v2.4 as v2.4 and moves an appended tag to the front', async () => {
    const out = await mp3Handler.write!(fixture('audio/v24-unsync.mp3'), edits({ 'id3:TPE1': 'Ünïcødé ✓', 'id3:TCON': 'Jazz' }));
    const et = await exiftool(out, 'out.mp3');
    expect(etProblems(et)).toEqual([]);
    expect(et['ID3v2_4:Artist']).toBe('Ünïcødé ✓');
    expect(et['ID3v2_4:Genre']).toBe('Jazz');
    expect(et['ID3v2_4:RecordingTime']).toBe('2022:03:04 05:06:07');
    expect(et['ID3v2_4:Picture']).toBeDefined();
    await sameAudio(out, 'audio/v24-unsync.mp3');

    const m0 = await mp3Handler.read(fixture('audio/appended.mp3'));
    expect(field(m0, 'id3:TIT2')?.value).toBe('Appended');
    const out2 = await mp3Handler.write!(fixture('audio/appended.mp3'), edits({ 'id3:TIT2': 'Moved' }));
    const et2 = await exiftool(out2, 'out.mp3');
    expect(etProblems(et2)).toEqual([]);
    expect(et2['ID3v2_4:Title']).toBe('Moved');
    expect(et2['ID3v2_4:Artist']).toBe(`Tail ${MARK}`);
    expect(et2['ID3v1:Title']).toBe('Moved');
    await sameAudio(out2, 'audio/appended.mp3');
  });

  it('converts ID3v2.2 to v2.3 and drops the stacked tag', async () => {
    const out = await mp3Handler.write!(fixture('audio/v22.mp3'), edits({ 'id3:TALB': 'Updated' }));
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mp3');
    expect(etProblems(et)).toEqual([]);
    expect(et['ID3v2_3:Title']).toBe('Old Title');
    expect(et['ID3v2_3:Album']).toBe('Updated');
    expect(et['ID3v2_3:Band']).toBe('Stacked Album Artist');
    expect(et['ID3v2_3:PictureMIMEType']).toBe('image/jpeg');
    expect(et['ID3v2_3:Comment']).toBe(`Old ${MARK}`);
    expect(Object.keys(et).filter((k) => k.startsWith('ID3v2_2'))).toEqual([]);
    const m = await reread(out);
    expect(m.warnings).toEqual([]);
    await sameAudio(out, 'audio/v22.mp3');
  });

  it('creates a new ID3v2.3 tag (UTF-16 for non-Latin text) and removes it again', async () => {
    const out = await mp3Handler.write!(fixture('audio/plain.mp3'), edits({ 'id3:TIT2': '東京', 'id3:TPE1': 'Jane', 'id3:TDRC': '2021' }));
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mp3');
    expect(etProblems(et)).toEqual([]);
    expect(et['ID3v2_3:Title']).toBe('東京');
    expect(et['ID3v2_3:Artist']).toBe('Jane');
    expect(et['ID3v2_3:Year']).toBe(2021);
    expect(ffprobeTags(bytes, 'out.mp3').title).toBe('東京');
    await sameAudio(out, 'audio/plain.mp3');

    const gone = await mp3Handler.write!(new Source(out), edits({ [groupKey('id3')]: REMOVE }));
    const et2 = await exiftool(gone, 'out.mp3');
    expect(Object.keys(et2).filter((k) => k.startsWith('ID3'))).toEqual([]);
    expect(Buffer.from(await bytesOf(gone)).equals(Buffer.from(fixtureBytes('audio/plain.mp3')))).toBe(true);
  });

  it('strips every tag but keeps the audio', async () => {
    for (const rel of ['audio/rich.mp3', 'audio/v23.mp3', 'audio/v22.mp3', 'audio/appended.mp3']) {
      const out = await mp3Handler.strip!(fixture(rel), strip());
      const bytes = await bytesOf(out);
      expect(contains(bytes, MARK)).toBe(false);
      const et = await exiftool(bytes, 'out.mp3');
      expect(etProblems(et)).toEqual([]);
      expect(etMetaKeys(et).filter((k) => !k.startsWith('MPEG:'))).toEqual([]);
      const m = await reread(out);
      expect(allFields(m)).toEqual([]);
      await sameAudio(out, rel);
    }
  });

  it('keeps only the cover art when asked', async () => {
    const out = await mp3Handler.strip!(fixture('audio/rich.mp3'), strip({ keepCoverArt: true }));
    const bytes = await bytesOf(out);
    expect(contains(bytes, MARK)).toBe(false);
    const et = await exiftool(bytes, 'out.mp3');
    expect(etProblems(et)).toEqual([]);
    expect(etMetaKeys(et).filter((k) => !k.startsWith('MPEG:')).sort()).toEqual([
      'ID3v2_3:Picture',
      'ID3v2_3:PictureDescription',
      'ID3v2_3:PictureMIMEType',
      'ID3v2_3:PictureType',
    ]);
    const m = await reread(out);
    expect(allFields(m).map((f) => f.id)).toEqual(['id3:APIC:0']);
    await sameAudio(out, 'audio/rich.mp3');
  });
});

describe('id3: compressed frames', () => {
  it('inflates them within one budget per tag', () => {
    // ID3v2.3 PRIV frames flagged as compressed: decompressed size, then zlib data of 40 MB of zeros.
    const body = Buffer.concat([Buffer.from([0x02, 0x80, 0, 0]), zlibSync(new Uint8Array(40 << 20))]);
    const frame = Buffer.alloc(10);
    frame.write('PRIV', 0, 'latin1');
    frame.writeUInt32BE(body.length, 4);
    frame.writeUInt16BE(0x0080, 8);
    const frames = Buffer.concat([frame, body, frame, body]);
    const size = frames.length;
    const syncsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
    const tag = parseId3v2(new Uint8Array(Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe]), frames])));
    expect(tag.frames.map((f) => f.data.length)).toEqual([40 << 20, body.length]); // the second stays compressed, as raw data
    expect(tag.warnings).toEqual(['Compressed ID3 frame PRIV could not be decompressed: compressed data expands to more than 24 MB']);
  });
});
