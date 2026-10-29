import { describe, expect, it } from 'vitest';
import { Source, groupKey, type DetectContext } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARK, contains, decode, ffprobeTags } from './audio.testlib';
import { id3v2Size } from './id3';
import { wavData, wavHandler } from './wav';

const ctx = (rel: string): DetectContext => {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return { head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length };
};
const info = (m: { info: { label: string; value: string }[] }, label: string) => m.info.find((i) => i.label === label)?.value;
const DC_CREATOR = 'xmp:http://purl.org/dc/elements/1.1/|creator';
const numbersOut = (ws: string[]) => ws.map((w) => w.replace(/\d+/g, 'N'));

/** Walk the RIFF structure: sizes add up and every chunk is word aligned. */
function chunkIds(b: Uint8Array): string[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ids: string[] = [];
  const rf64 = Buffer.from(b.subarray(0, 4)).toString('latin1') !== 'RIFF';
  if (!rf64) expect(v.getUint32(4, true)).toBe(b.length - 8);
  let p = 12;
  while (p < b.length) {
    const id = Buffer.from(b.subarray(p, p + 4)).toString('latin1');
    let size = v.getUint32(p + 4, true);
    if (rf64 && id === 'data' && size === 0xffffffff) size = Number(v.getBigUint64(ids.includes('ds64') ? 12 + 8 + 8 : 0, true));
    ids.push(id);
    p += 8 + size + (size & 1);
  }
  expect(p).toBe(b.length);
  return ids;
}

async function sameAudio(out: Blob, rel: string): Promise<void> {
  const a = await wavData(fixture(rel));
  const b = await wavData(new Source(out));
  expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  const bytes = await bytesOf(out);
  chunkIds(bytes);
  const d = decode(bytes, 'x.wav');
  expect(d.errors).toBe('');
  expect(d.md5).toBe(decode(fixtureBytes(rel), 'x.wav').md5);
}

describe('wav', () => {
  it('detects RIFF and RF64 WAVE', () => {
    expect(wavHandler.detect(ctx('audio/bwf.wav'))).toBe(3);
    expect(wavHandler.detect(ctx('audio/rf64.wav'))).toBe(3);
    expect(wavHandler.detect(ctx('audio/plain.mp3'))).toBe(0);
  });

  it('reads INFO, bext, ID3, XMP and other chunks', async () => {
    const m = await wavHandler.read(fixture('audio/bwf.wav'));
    expect(m.format.id).toBe('wav');
    expect(info(m, 'Format')).toBe('PCM, 16-bit');
    expect(info(m, 'Channels')).toBe('Mono');
    expect(info(m, 'Sample rate')).toBe('8000 Hz');
    expect(info(m, 'Duration')).toBe('0.50 s');
    expect(field(m, 'wav:info:INAM')?.value).toBe('Wave Title');
    expect(field(m, 'wav:info:IART')?.sensitivity).toBe('identity');
    expect(field(m, 'wav:info:ICMT')?.value).toBe(MARK);
    expect(field(m, 'wav:info:ISFT')?.sensitivity).toBe('software');
    expect(field(m, 'wav:bext:description')?.value).toBe('Field recording');
    expect(field(m, 'wav:bext:originator')?.value).toBe('Jane Doe');
    expect(field(m, 'wav:bext:originator')?.sensitivity).toBe('identity');
    expect(field(m, 'wav:bext:originatorReference')?.value).toBe(`REF-${MARK}`);
    expect(field(m, 'wav:bext:origination')?.value).toBe('2024-05-01T10:11:12');
    expect(field(m, 'wav:bext:codingHistory')?.value).toBe('A=PCM,F=8000,W=16,M=mono,T=SecretRecorder');
    expect(field(m, 'id3:TIT2')?.value).toBe('ID3 Title');
    expect(field(m, 'id3:TPE1')?.value).toBe('Zoë');
    expect(field(m, DC_CREATOR)?.value).toEqual(['Jane Doe']);
    const other = m.groups.find((g) => g.id === 'wav.other')!.fields;
    expect(other.map((f) => f.label)).toEqual(['iXML production data', 'Chunk “abcd”']);
    expect(m.warnings).toEqual([]);
  });

  it('edits every metadata chunk; ExifTool and ffprobe agree, audio untouched', async () => {
    const ixml = (await wavHandler.read(fixture('audio/bwf.wav'))).groups.find((g) => g.id === 'wav.other')!.fields[0].id;
    const out = await wavHandler.write!(
      fixture('audio/bwf.wav'),
      edits({
        'wav:info:INAM': 'New Title',
        'wav:info:ICMT': REMOVE,
        'wav:info:IKEY': 'one; two',
        'wav:bext:originator': 'Someone Else',
        'wav:bext:originatorReference': REMOVE,
        'wav:bext:origination': '2023-01-02T03:04:05',
        'wav:bext:codingHistory': 'A=PCM,F=8000',
        'id3:TIT2': 'ID3 Neu',
        'id3:COMM': REMOVE,
        [DC_CREATOR]: ['Somebody'],
        [ixml]: REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    expect(contains(bytes, MARK)).toBe(false);
    expect(chunkIds(bytes)).toEqual(['fmt ', 'bext', 'LIST', 'data', 'cue ', '_PMX', 'abcd', 'id3 ']);
    const et = await exiftool(bytes, 'out.wav');
    expect(etProblems(et)).toEqual([]);
    expect(et['RIFF:Title']).toBe('New Title');
    expect(et['RIFF:Comment']).toBeUndefined();
    expect(et['RIFF:Keywords']).toBe('one; two');
    expect(et['RIFF:Artist']).toBe('Jane Doe');
    expect(et['RIFF:Originator']).toBe('Someone Else');
    expect(et['RIFF:OriginatorReference']).toBe('');
    expect(et['RIFF:DateTimeOriginal']).toBe('2023:01:02 03:04:05');
    expect(et['RIFF:CodingHistory']).toBe('A=PCM,F=8000');
    expect(et['RIFF:Description']).toBe('Field recording');
    expect(et['ID3v2_3:Title']).toBe('ID3 Neu');
    expect(et['ID3v2_3:Artist']).toBe('Zoë');
    expect(et['XMP-dc:Creator']).toBe('Somebody');
    expect(et['XMP-xmp:CreatorTool']).toBe('Adobe Audition 24.0');
    expect(et['XML:BwfxmlProject']).toBeUndefined();
    expect(et['RIFF:CuePoints']).toBeDefined();
    const probe = ffprobeTags(bytes, 'out.wav');
    expect(probe.title).toBe('ID3 Neu'); // ffmpeg prefers the ID3 chunk over INFO
    expect(Object.values(probe).join()).not.toContain(MARK);
    await sameAudio(out, 'audio/bwf.wav');
    const m = await wavHandler.read(new Source(out));
    expect(field(m, 'wav:bext:origination')?.value).toBe('2023-01-02T03:04:05');
    expect(field(m, 'wav:bext:codingHistory')?.value).toBe('A=PCM,F=8000');
    expect(m.warnings).toEqual([]);
  });

  it('adds an INFO list to a bare file and removes groups', async () => {
    const out = await wavHandler.write!(fixture('audio/plain.wav'), edits({ 'wav:info:INAM': 'Added', 'wav:info:IART': 'Someone' }));
    const bytes = await bytesOf(out);
    expect(chunkIds(bytes)).toEqual(['fmt ', 'LIST', 'data']);
    const et = await exiftool(bytes, 'out.wav');
    expect(etProblems(et)).toEqual([]);
    expect(et['RIFF:Title']).toBe('Added');
    expect(et['RIFF:Artist']).toBe('Someone');
    expect(ffprobeTags(bytes, 'out.wav').artist).toBe('Someone');
    await sameAudio(out, 'audio/plain.wav');

    const gone = await wavHandler.write!(
      fixture('audio/bwf.wav'),
      edits({ [groupKey('wav.bext')]: REMOVE, [groupKey('xmp')]: REMOVE, [groupKey('id3')]: REMOVE, [groupKey('wav.info')]: REMOVE }),
    );
    expect(chunkIds(await bytesOf(gone))).toEqual(['fmt ', 'data', 'cue ', 'iXML', 'abcd']);
    const et2 = await exiftool(gone, 'out.wav');
    expect(etProblems(et2)).toEqual([]);
    await sameAudio(gone, 'audio/bwf.wav');
  });

  it('strips everything but the playback chunks', async () => {
    const out = await wavHandler.strip!(fixture('audio/bwf.wav'), strip());
    const bytes = await bytesOf(out);
    expect(contains(bytes, MARK)).toBe(false);
    expect(contains(bytes, 'Jane')).toBe(false);
    expect(chunkIds(bytes)).toEqual(['fmt ', 'data', 'cue ']);
    const et = await exiftool(bytes, 'out.wav');
    expect(etProblems(et)).toEqual([]);
    expect(etMetaKeys(et).sort()).toEqual(['RIFF:AvgBytesPerSec', 'RIFF:BitsPerSample', 'RIFF:CuePoints', 'RIFF:Encoding', 'RIFF:NumChannels', 'RIFF:SampleRate']);
    const m = await wavHandler.read(new Source(out));
    expect(allFields(m)).toEqual([]);
    await sameAudio(out, 'audio/bwf.wav');
  });

  it('reads, edits and strips RF64', async () => {
    const m = await wavHandler.read(fixture('audio/rf64.wav'));
    expect(info(m, 'Container')).toBe('RF64');
    expect(info(m, 'Duration')).toBe('0.50 s');
    expect(field(m, 'wav:info:INAM')?.value).toBe('RF64 Title');
    const base = await exiftool(fixtureBytes('audio/rf64.wav'), 'x.wav');
    const out = await wavHandler.write!(fixture('audio/rf64.wav'), edits({ 'wav:info:INAM': 'A much longer RF64 title than before', 'wav:info:ICMT': REMOVE }));
    const bytes = await bytesOf(out);
    expect(contains(bytes, MARK)).toBe(false);
    const et = await exiftool(bytes, 'out.wav');
    // ExifTool already complains about ffmpeg's RF64 RIFF size; nothing new may appear.
    expect(numbersOut(etProblems(et))).toEqual(numbersOut(etProblems(base)));
    expect(et['RIFF:Title']).toBe('A much longer RF64 title than before');
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    expect(Number(v.getBigUint64(20, true))).toBe(bytes.length - 8);
    await sameAudio(out, 'audio/rf64.wav');
    const s = await wavHandler.strip!(fixture('audio/rf64.wav'), strip());
    const sb = await bytesOf(s);
    expect(contains(sb, MARK)).toBe(false);
    expect(Number(new DataView(sb.buffer, sb.byteOffset).getBigUint64(20, true))).toBe(sb.length - 8);
    await sameAudio(s, 'audio/rf64.wav');
  });
});

describe('wav: damaged files', () => {
  const plain = fixtureBytes('audio/plain.wav');
  const fmt = plain.subarray(12, 36);
  const audio = plain.subarray(44);
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const latin = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
  /** A RIFF/WAVE file around `body`; `riffSize` defaults to the true size. */
  const wav = (body: Uint8Array[], riffSize?: number) => {
    const b = Buffer.concat(body);
    return new Uint8Array(Buffer.concat([latin('RIFF'), u32(riffSize ?? 4 + b.length), latin('WAVE'), b]));
  };
  const src = (b: Uint8Array) => Source.fromBytes(b, 'x.wav');

  async function keepsAudio(b: Uint8Array): Promise<void> {
    const m = await wavHandler.read(src(b));
    expect(m.warnings.join('\n')).toMatch(/audio was taken to run to the end/);
    expect(info(m, 'Duration')).toBe(info(await wavHandler.read(fixture('audio/plain.wav')), 'Duration'));
    const out = await wavHandler.strip!(src(b), strip());
    expect(chunkIds(await bytesOf(out))).toEqual(['fmt ', 'data']);
    expect(Buffer.from(await wavData(new Source(out))).equals(Buffer.from(audio))).toBe(true);
  }

  it('keeps the audio when the data size was never written (interrupted recording)', async () => {
    const zero = [fmt, latin('data'), u32(0), audio];
    await keepsAudio(wav(zero)); // RIFF size right, data size 0
    await keepsAudio(wav(zero, 4 + fmt.length + 8)); // neither size updated after the headers
    await keepsAudio(wav([fmt, latin('data'), u32(1000), audio])); // data size stale
  });

  it('reads chunks written without their pad byte', async () => {
    const b = wav([fmt, latin('note'), u32(3), latin('abc'), latin('data'), u32(audio.length), audio]);
    const m = await wavHandler.read(src(b));
    expect(m.warnings).toEqual([]);
    // Unknown edit ids are ignored: this rewrites every chunk as it is, now padded.
    const out = await bytesOf(await wavHandler.write!(src(b), edits({ 'wav:none': 'x' })));
    expect(chunkIds(out)).toEqual(['fmt ', 'note', 'data']);
    expect(Buffer.from(await wavData(Source.fromBytes(out))).equals(Buffer.from(audio))).toBe(true);
    const s = await bytesOf(await wavHandler.strip!(src(b), strip()));
    expect(chunkIds(s)).toEqual(['fmt ', 'data']);
  });

  it('keeps only the cover of an ID3 chunk, and drops one it cannot read', async () => {
    const mp3 = fixtureBytes('audio/rich.mp3');
    const tag = mp3.subarray(0, id3v2Size(mp3));
    const chunk = (body: Uint8Array) => [latin('id3 '), u32(body.length), body, new Uint8Array(body.length & 1)];
    const good = await bytesOf(await wavHandler.strip!(src(wav([fmt, ...chunk(tag), latin('data'), u32(audio.length), audio])), strip({ keepCoverArt: true })));
    expect(chunkIds(good)).toEqual(['fmt ', 'id3 ', 'data']);
    expect(contains(good, MARK)).toBe(false);
    expect(allFields(await wavHandler.read(src(good))).map((f) => f.id)).toEqual(['id3:APIC:0']);

    const damaged = wav([fmt, ...chunk(latin(`ID3\xff\0\0${MARK}`)), latin('data'), u32(audio.length), audio]);
    expect((await wavHandler.read(src(damaged))).warnings.join('\n')).toMatch(/ID3 chunk could not be read/);
    const out = await bytesOf(await wavHandler.strip!(src(damaged), strip({ keepCoverArt: true })));
    expect(chunkIds(out)).toEqual(['fmt ', 'data']);
    expect(Buffer.from(await wavData(Source.fromBytes(out))).equals(Buffer.from(audio))).toBe(true);
  });

  it('refuses to rewrite a file whose audio it cannot find', async () => {
    const b = wav([fmt, new Uint8Array(8), latin('data'), u32(audio.length), audio]);
    expect((await wavHandler.read(src(b))).warnings.join('\n')).toMatch(/Unreadable data/);
    await expect(wavHandler.strip!(src(b), strip())).rejects.toThrow(/audio data could not be located/);
  });
});
