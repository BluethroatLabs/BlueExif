import { describe, expect, it } from 'vitest';
import { Source, groupKey, type DetectContext } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARK, contains, decode, ffprobeTags } from './audio.testlib';
import { aiffHandler, aiffSound } from './aiff';
import { id3v2Size } from './id3';

const ctx = (rel: string): DetectContext => {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return { head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length };
};
const info = (m: { info: { label: string; value: string }[] }, label: string) => m.info.find((i) => i.label === label)?.value;

/** Walk the FORM structure: sizes add up and chunks are word aligned. */
function chunkIds(b: Uint8Array): string[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(v.getUint32(4)).toBe(b.length - 8);
  const ids: string[] = [];
  let p = 12;
  while (p < b.length) {
    ids.push(Buffer.from(b.subarray(p, p + 4)).toString('latin1'));
    const size = v.getUint32(p + 4);
    p += 8 + size + (size & 1);
  }
  expect(p).toBe(b.length);
  return ids;
}

async function sameAudio(out: Blob, rel: string): Promise<void> {
  const a = await aiffSound(fixture(rel));
  const b = await aiffSound(new Source(out));
  expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  const bytes = await bytesOf(out);
  chunkIds(bytes);
  const name = rel.split('/').pop()!;
  const d = decode(bytes, name);
  expect(d.errors).toBe('');
  expect(d.md5).toBe(decode(fixtureBytes(rel), name).md5);
}

describe('aiff', () => {
  it('detects AIFF and AIFF-C', () => {
    expect(aiffHandler.detect(ctx('audio/tagged.aiff'))).toBe(3);
    expect(aiffHandler.detect(ctx('audio/sowt.aifc'))).toBe(3);
    expect(aiffHandler.detect(ctx('audio/bwf.wav'))).toBe(0);
  });

  it('reads text chunks, comments, ID3 and application data', async () => {
    const m = await aiffHandler.read(fixture('audio/tagged.aiff'));
    expect(m.format.name).toBe('AIFF audio');
    expect(info(m, 'Format')).toBe('AIFF, 16-bit');
    expect(info(m, 'Channels')).toBe('Mono');
    expect(info(m, 'Sample rate')).toBe('8000 Hz');
    expect(info(m, 'Duration')).toBe('0.50 s');
    expect(field(m, 'aiff:NAME')?.value).toBe('Test Song');
    expect(field(m, 'aiff:AUTH')?.value).toBe('Jane Doe');
    expect(field(m, 'aiff:AUTH')?.sensitivity).toBe('identity');
    expect(field(m, 'aiff:COPY')?.value).toBe('2024 Jane Doe');
    expect(field(m, 'aiff:ANNO:0')?.value).toBe(MARK);
    expect(field(m, 'aiff:ANNO:1')?.value).toBe('Second annotation');
    expect(field(m, 'aiff:COMT:0')?.value).toBe(`Note ${MARK}`);
    expect(field(m, 'aiff:COMT:0')?.display).toContain('2024-05-31 11:33:20');
    expect(field(m, 'id3:TIT2')?.value).toBe('Test Song');
    expect(field(m, 'id3:TPE1')?.value).toBe('Zoë Smith');
    expect(m.groups.find((g) => g.id === 'id3')?.source).toBe('ID3v2.4');
    expect(m.groups.find((g) => g.id === 'aiff.other')?.fields.map((f) => f.label)).toEqual(['Application data (pdos)']);
    expect(m.warnings).toEqual([]);
    const c = await aiffHandler.read(fixture('audio/sowt.aifc'));
    expect(info(c, 'Format')).toMatch(/^AIFF-C \(.+\), 16-bit$/);
    expect(field(c, 'aiff:NAME')?.value).toBe('AIFC Title');
  });

  it('edits text, comments and ID3; ExifTool and ffprobe agree, audio untouched', async () => {
    const out = await aiffHandler.write!(
      fixture('audio/tagged.aiff'),
      edits({
        'aiff:NAME': 'Neuer Name',
        'aiff:AUTH': REMOVE,
        'aiff:ANNO:0': REMOVE,
        'aiff:ANNO:new': 'Added note',
        'aiff:COMT:0': 'Edited comment',
        'id3:TIT2': 'ID3 Neu',
        'id3:COMM': REMOVE,
        'id3:TXXX:comment': REMOVE,
        'aiff:chunk:6': REMOVE, // APPL
      }),
    );
    const bytes = await bytesOf(out);
    expect(contains(bytes, MARK)).toBe(false);
    expect(chunkIds(bytes)).toEqual(['NAME', '(c) ', 'COMM', 'COMT', 'ANNO', 'ANNO', 'SSND', 'ID3 ']);
    const et = await exiftool(bytes, 'out.aiff');
    expect(etProblems(et)).toEqual([]);
    expect(et['AIFF:Name']).toBe('Neuer Name');
    expect(et['AIFF:Author']).toBeUndefined();
    expect(et['AIFF:Annotation']).toBe('Added note');
    expect(et['AIFF:Comment']).toBe('Edited comment');
    expect(et['AIFF:CommentTime']).toBe('2024:05:31 11:33:20');
    expect(et['AIFF:ApplicationData']).toBeUndefined();
    expect(et['ID3v2_4:Title']).toBe('ID3 Neu');
    expect(et['ID3v2_4:Album']).toBe('Demo Album');
    expect(ffprobeTags(bytes, 'out.aiff').title).toBe('ID3 Neu');
    await sameAudio(out, 'audio/tagged.aiff');
    const m = await aiffHandler.read(new Source(out));
    expect(field(m, 'aiff:ANNO:1')?.value).toBe('Added note');
    expect(m.warnings).toEqual([]);
  });

  it('adds text chunks to a bare file and removes groups', async () => {
    const out = await aiffHandler.write!(fixture('audio/plain.aiff'), edits({ 'aiff:NAME': 'Fresh', 'aiff:AUTH': 'Someone' }));
    const bytes = await bytesOf(out);
    expect(chunkIds(bytes)).toEqual(['COMM', 'NAME', 'AUTH', 'SSND']);
    const et = await exiftool(bytes, 'out.aiff');
    expect(etProblems(et)).toEqual([]);
    expect(et['AIFF:Name']).toBe('Fresh');
    expect(et['AIFF:Author']).toBe('Someone');
    await sameAudio(out, 'audio/plain.aiff');

    const gone = await aiffHandler.write!(fixture('audio/tagged.aiff'), edits({ [groupKey('aiff.text')]: REMOVE, [groupKey('id3')]: REMOVE }));
    expect(chunkIds(await bytesOf(gone))).toEqual(['COMM', 'APPL', 'SSND']);
    await sameAudio(gone, 'audio/tagged.aiff');
  });

  it('strips everything but the sound and format chunks', async () => {
    for (const rel of ['audio/tagged.aiff', 'audio/sowt.aifc']) {
      const out = await aiffHandler.strip!(fixture(rel), strip());
      const bytes = await bytesOf(out);
      expect(contains(bytes, MARK)).toBe(false);
      const et = await exiftool(bytes, rel.split('/').pop()!);
      expect(etProblems(et)).toEqual([]);
      expect(etMetaKeys(et).filter((k) => !/^AIFF:(NumChannels|NumSampleFrames|SampleSize|SampleRate|FormatVersionTime|CompressionType|CompressorName)$/.test(k))).toEqual([]);
      const m = await aiffHandler.read(new Source(out));
      expect(allFields(m)).toEqual([]);
      await sameAudio(out, rel);
    }
  });
});

describe('aiff: damaged files', () => {
  const plain = fixtureBytes('audio/plain.aiff');
  const comm = plain.subarray(12, 38);
  const sound = plain.subarray(46); // SSND payload: offset + block size, then the samples
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return b;
  };
  const latin = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
  /** A FORM/AIFF file around `body`; `formSize` defaults to the true size. */
  const aiff = (body: Uint8Array[], formSize?: number) => {
    const b = Buffer.concat(body);
    return new Uint8Array(Buffer.concat([latin('FORM'), u32(formSize ?? 4 + b.length), latin('AIFF'), b]));
  };
  const src = (b: Uint8Array) => Source.fromBytes(b, 'x.aiff');

  async function keepsAudio(b: Uint8Array): Promise<void> {
    const m = await aiffHandler.read(src(b));
    expect(m.warnings.join('\n')).toMatch(/audio was taken to run to the end/);
    const out = await aiffHandler.strip!(src(b), strip());
    expect(chunkIds(await bytesOf(out))).toEqual(['COMM', 'SSND']);
    expect(Buffer.from(await aiffSound(new Source(out))).equals(Buffer.from(sound))).toBe(true);
  }

  it('keeps the audio when the SSND size was never written (interrupted recording)', async () => {
    await keepsAudio(aiff([comm, latin('SSND'), u32(0), sound])); // FORM size right
    await keepsAudio(aiff([comm, latin('SSND'), u32(8), sound], 4 + comm.length + 16)); // neither size updated
    await keepsAudio(aiff([comm, latin('SSND'), u32(1000), sound])); // SSND size stale
  });

  it('reads chunks written without their pad byte', async () => {
    const b = aiff([comm, latin('NAME'), u32(3), latin('abc'), latin('SSND'), u32(sound.length), sound]);
    expect((await aiffHandler.read(src(b))).warnings).toEqual([]);
    const out = await bytesOf(await aiffHandler.write!(src(b), edits({ 'aiff:none': 'x' })));
    expect(chunkIds(out)).toEqual(['COMM', 'NAME', 'SSND']);
    expect(Buffer.from(await aiffSound(Source.fromBytes(out))).equals(Buffer.from(sound))).toBe(true);
  });

  it('keeps only the cover of an ID3 chunk, and drops one it cannot read', async () => {
    const mp3 = fixtureBytes('audio/rich.mp3');
    const tag = mp3.subarray(0, id3v2Size(mp3));
    const chunk = (body: Uint8Array) => [latin('ID3 '), u32(body.length), body, new Uint8Array(body.length & 1)];
    const good = await bytesOf(await aiffHandler.strip!(src(aiff([comm, ...chunk(tag), latin('SSND'), u32(sound.length), sound])), strip({ keepCoverArt: true })));
    expect(chunkIds(good)).toEqual(['COMM', 'ID3 ', 'SSND']);
    expect(contains(good, MARK)).toBe(false);
    expect(allFields(await aiffHandler.read(src(good))).map((f) => f.id)).toEqual(['id3:APIC:0']);

    const damaged = aiff([comm, ...chunk(latin(`ID3\xff\0\0${MARK}`)), latin('SSND'), u32(sound.length), sound]);
    expect((await aiffHandler.read(src(damaged))).warnings.join('\n')).toMatch(/ID3 chunk could not be read/);
    const out = await bytesOf(await aiffHandler.strip!(src(damaged), strip({ keepCoverArt: true })));
    expect(chunkIds(out)).toEqual(['COMM', 'SSND']);
    expect(Buffer.from(await aiffSound(Source.fromBytes(out))).equals(Buffer.from(sound))).toBe(true);
  });

  it('refuses to rewrite a file whose audio it cannot find', async () => {
    const b = aiff([comm, new Uint8Array(8), latin('SSND'), u32(sound.length), sound]);
    await expect(aiffHandler.strip!(src(b), strip())).rejects.toThrow(/audio data could not be located/);
  });
});
