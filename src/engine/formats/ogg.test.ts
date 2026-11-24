import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { concat, crc32 } from '../core/binary';
import { Source, groupKey, type DetectContext, type ImageValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { MARK, contains, decode, ffprobeTags } from './audio.testlib';
import { buildPage, oggHandler } from './ogg';

const ctx = (rel: string): DetectContext => {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return { head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length };
};
const info = (m: { info: { label: string; value: string }[] }, label: string) => m.info.find((i) => i.label === label)?.value;

/** Bit-by-bit Ogg CRC (independent of the table-driven one in ogg.ts). */
function crcSlow(b: Uint8Array): number {
  let crc = 0;
  for (const byte of b) {
    crc ^= byte << 24;
    for (let k = 0; k < 8; k++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

interface PageInfo {
  flags: number;
  granule: bigint;
  seq: number;
  segs: number[];
}

/** Walk all pages: valid CRCs, consecutive sequence numbers, single serial. */
function pages(b: Uint8Array): PageInfo[] {
  const out: PageInfo[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  let serial = -1;
  while (p < b.length) {
    expect(Buffer.from(b.subarray(p, p + 4)).toString('latin1')).toBe('OggS');
    const n = b[p + 26];
    const segs = [...b.subarray(p + 27, p + 27 + n)];
    const len = 27 + n + segs.reduce((a, c) => a + c, 0);
    const page = b.slice(p, p + len);
    const stored = v.getUint32(p + 22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    expect(crcSlow(page)).toBe(stored);
    const s = v.getUint32(p + 14, true);
    if (serial < 0) serial = s;
    expect(s).toBe(serial);
    out.push({ flags: b[p + 5], granule: v.getBigInt64(p + 6, true), seq: v.getUint32(p + 18, true), segs });
    p += len;
  }
  out.forEach((pg, i) => expect(pg.seq).toBe(i));
  return out;
}

async function sameAudio(out: Blob, rel: string): Promise<void> {
  const bytes = await bytesOf(out);
  pages(bytes);
  const d = decode(bytes, rel.split('/').pop()!);
  expect(d.errors).toBe('');
  expect(d.md5).toBe(decode(fixtureBytes(rel), rel.split('/').pop()!).md5);
}

/** A large (incompressible, stored) PNG so the comment header spans several pages. */
function bigPicture(): Uint8Array {
  const w = 256;
  const h = 256;
  const raw = new Uint8Array(h * (1 + w * 3));
  let x = 12345;
  for (let i = 0; i < raw.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    raw[i] = i % (1 + w * 3) === 0 ? 0 : x >>> 24;
  }
  const chunk = (type: string, data: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(t, 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(concat([t, data])));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 0 })), chunk('IEND', new Uint8Array(0))]);
}

const BIG = bigPicture();

describe('ogg', () => {
  it('detects Vorbis, Opus and Ogg FLAC', () => {
    expect(oggHandler.detect(ctx('audio/vorbis.ogg'))).toBe(3);
    expect(oggHandler.detect(ctx('audio/opus.opus'))).toBe(3);
    expect(oggHandler.detect(ctx('audio/flac.oga'))).toBe(3);
    expect(oggHandler.detect(ctx('audio/plain.mp3'))).toBe(0);
  });

  it('reads Ogg Vorbis comments, pictures and stream info', async () => {
    const m = await oggHandler.read(fixture('audio/vorbis.ogg'));
    expect(m.format.name).toBe('Ogg Vorbis audio');
    expect(info(m, 'Codec')).toBe('Vorbis');
    expect(info(m, 'Channels')).toBe('2');
    expect(info(m, 'Sample rate')).toBe('8000 Hz');
    expect(info(m, 'Duration')).toBe('0.50 s');
    expect(field(m, 'vorbis:TITLE')?.value).toBe('Test Song');
    expect(field(m, 'vorbis:ARTIST')?.value).toBe('Zoë Smith');
    expect(field(m, 'vorbis:LOCATION')?.sensitivity).toBe('location');
    expect(field(m, 'vorbis:DESCRIPTION')?.value).toBe(MARK);
    expect(field(m, 'vorbis:METADATA_BLOCK_PICTURE')).toBeUndefined();
    const pic = field(m, 'vorbis:picture:0')?.value as ImageValue;
    expect(pic.description).toBe('Cover');
    expect(pic.width).toBe(64);
    expect(field(m, 'vorbis:vendor')?.display).toMatch(/^Lavf/);
    expect(m.canWrite).toBe(true);
    expect(m.warnings).toEqual([]);
  });

  it('reads Opus and Ogg FLAC', async () => {
    const o = await oggHandler.read(fixture('audio/opus.opus'));
    expect(o.format.name).toBe('Ogg Opus audio');
    expect(info(o, 'Sample rate')).toBe('48000 Hz (input 8000 Hz)');
    expect(info(o, 'Duration')).toBe('0.50 s');
    expect(field(o, 'vorbis:ALBUM')?.value).toBe('Demo Album');
    expect((field(o, 'vorbis:picture:0')?.value as ImageValue).mime).toBe('image/jpeg');
    const f = await oggHandler.read(fixture('audio/flac.oga'));
    expect(info(f, 'Codec')).toBe('FLAC');
    expect(info(f, 'Duration')).toBe('0.50 s');
    expect(field(f, 'vorbis:TITLE')?.value).toBe('Test Song');
  });

  it('edits Vorbis comments in place (same page count)', async () => {
    const out = await oggHandler.write!(
      fixture('audio/vorbis.ogg'),
      edits({ 'vorbis:TITLE': 'Neu', 'vorbis:DESCRIPTION': REMOVE, 'vorbis:ARTIST': ['Анна', 'Bob'] }),
    );
    const bytes = await bytesOf(out);
    expect(contains(bytes, MARK)).toBe(false);
    const et = await exiftool(bytes, 'out.ogg');
    expect(etProblems(et)).toEqual([]);
    expect(et['Vorbis:Title']).toBe('Neu');
    expect(et['Vorbis:Artist']).toEqual(['Анна', 'Bob']);
    expect(et['Vorbis:Album']).toBe('Demo Album');
    expect(ffprobeTags(bytes, 'out.ogg').title).toBe('Neu');
    await sameAudio(out, 'audio/vorbis.ogg');
    const m = await oggHandler.read(new Source(out));
    expect(field(m, 'vorbis:ARTIST')?.value).toEqual(['Анна', 'Bob']);
    expect(field(m, 'vorbis:picture:0')).toBeDefined();
  });

  it('re-paginates and renumbers when the comment header grows over several pages', async () => {
    for (const rel of ['audio/vorbis.ogg', 'audio/opus.opus', 'audio/flac.oga']) {
      const out = await oggHandler.write!(
        fixture(rel),
        edits({ 'vorbis:picture:new': { mime: 'image/png', data: BIG, description: 'big' }, 'vorbis:TITLE': 'grown' }),
      );
      const bytes = await bytesOf(out);
      const pg = pages(bytes);
      expect(pg.length).toBeGreaterThan(pages(fixtureBytes(rel)).length + 2);
      expect(pg[0].flags).toBe(2);
      expect(pg[0].segs.length).toBe(1);
      // header pages: granule 0 when a packet ends there, -1 otherwise
      const headerPages = pg.slice(1).filter((p) => p.granule === 0n || p.granule === -1n);
      expect(headerPages.length).toBeGreaterThan(3);
      const et = await exiftool(bytes, rel.split('/').pop()!);
      // ExifTool cannot follow Ogg FLAC header packets that span pages (ffmpeg's own output triggers the same warning).
      expect(etProblems(et).filter((w) => !(rel.endsWith('.oga') && w === 'Format error in FLAC file'))).toEqual([]);
      if (!rel.endsWith('.oga')) expect(et['Vorbis:Title']).toBe('grown');
      expect(ffprobeTags(bytes, rel.split('/').pop()!).title).toBe('grown');
      await sameAudio(out, rel);
      const m = await oggHandler.read(new Source(out));
      const pics = allFields(m).filter((f) => f.kind === 'image');
      expect((pics[pics.length - 1].value as ImageValue).width).toBe(256);
      expect((pics[pics.length - 1].value as ImageValue).data.length).toBe(BIG.length);
      expect(info(m, 'Duration')).toBe('0.50 s');

      // and shrinking back again
      const back = await oggHandler.write!(new Source(out), edits({ [`vorbis:picture:${pics.length - 1}`]: REMOVE }));
      await sameAudio(back, rel);
      expect(pages(await bytesOf(back)).length).toBe(pages(fixtureBytes(rel)).length);
    }
  });

  it('edits Opus and Ogg FLAC tags', async () => {
    const out = await oggHandler.write!(fixture('audio/opus.opus'), edits({ 'vorbis:ARTIST': 'Opus Person', 'vorbis:picture:0': REMOVE }));
    const et = await exiftool(out, 'out.opus');
    expect(etProblems(et)).toEqual([]);
    expect(et['Vorbis:Artist']).toBe('Opus Person');
    await sameAudio(out, 'audio/opus.opus');
    const fl = await oggHandler.write!(
      fixture('audio/flac.oga'),
      edits({ 'vorbis:ALBUM': 'FLAC Album', 'vorbis:picture:new': { mime: 'image/jpeg', data: fixtureBytes('jpeg/plain.jpg') } }),
    );
    const et2 = await exiftool(fl, 'out.oga');
    expect(etProblems(et2)).toEqual([]);
    expect(et2['Vorbis:Album']).toBe('FLAC Album');
    await sameAudio(fl, 'audio/flac.oga');
    const m = await oggHandler.read(new Source(fl));
    expect((field(m, 'vorbis:picture:0')?.value as ImageValue).width).toBe(160);
    expect(field(m, 'vorbis:ALBUM')?.value).toBe('FLAC Album');
  });

  it('strips all comments (keeping cover art when asked)', async () => {
    for (const rel of ['audio/vorbis.ogg', 'audio/opus.opus', 'audio/flac.oga']) {
      const name = rel.split('/').pop()!;
      const out = await oggHandler.strip!(fixture(rel), strip());
      const bytes = await bytesOf(out);
      expect(contains(bytes, MARK)).toBe(false);
      expect(contains(bytes, 'Lavf')).toBe(false);
      const et = await exiftool(bytes, name);
      expect(etProblems(et)).toEqual([]);
      expect(
        etMetaKeys(et).filter((k) => k.startsWith('Vorbis:') && !/^Vorbis:(VorbisVersion|AudioChannels|SampleRate|Nominal|Maximum|Minimum|Vendor)/.test(k)),
      ).toEqual([]);
      const m = await oggHandler.read(new Source(out));
      expect(allFields(m)).toEqual([]);
      await sameAudio(out, rel);
    }
    const kept = await oggHandler.strip!(fixture('audio/vorbis.ogg'), strip({ keepCoverArt: true }));
    const m = await oggHandler.read(new Source(kept));
    expect(allFields(m).map((f) => f.id)).toEqual(['vorbis:picture:0']);
    await sameAudio(kept, 'audio/vorbis.ogg');
  });

  it('moves audio that shares the last header page onto its own page', async () => {
    // Merge page 1 (comment + setup) and page 2 (audio) of the Vorbis fixture into one page.
    const b = fixtureBytes('audio/vorbis.ogg');
    const v = new DataView(b.buffer, b.byteOffset);
    const at: number[] = [];
    for (let p = 0; p < b.length; ) {
      at.push(p);
      const n = b[p + 26];
      p += 27 + n + [...b.subarray(p + 27, p + 27 + n)].reduce((x, y) => x + y, 0);
    }
    expect(at.length).toBe(3);
    const seg = (p: number) => b.subarray(p + 27, p + 27 + b[p + 26]);
    const body = (p: number, end: number) => b.subarray(p + 27 + b[p + 26], end);
    const merged = buildPage(
      4,
      b.subarray(at[2] + 6, at[2] + 14),
      v.getUint32(14, true),
      1,
      concat([seg(at[1]), seg(at[2])]),
      concat([body(at[1], at[2]), body(at[2], b.length)]),
    );
    const src = concat([b.subarray(0, at[1]), merged]);
    expect(decode(src, 'm.ogg').md5).toBe(decode(b, 'x.ogg').md5);
    const out = await oggHandler.write!(new Source(new Blob([src as BlobPart])), edits({ 'vorbis:TITLE': 'Split' }));
    const pg = pages(await bytesOf(out));
    expect(pg.length).toBe(3);
    expect(pg[1].granule).toBe(0n);
    expect(pg[2].granule).toBe(4032n);
    await sameAudio(out, 'audio/vorbis.ogg');
  });

  it('treats chained and multiplexed files as read-only', async () => {
    const a = fixtureBytes('audio/vorbis.ogg');
    const b = fixtureBytes('audio/opus.opus');
    const firstPage = (x: Uint8Array) => 27 + x[26] + [...x.subarray(27, 27 + x[26])].reduce((m, n) => m + n, 0);
    const chained = new Source(new Blob([concat([a, b]) as BlobPart]), 'c.ogg');
    const muxed = new Source(
      new Blob([concat([a.subarray(0, firstPage(a)), b.subarray(0, firstPage(b)), a.subarray(firstPage(a)), b.subarray(firstPage(b))]) as BlobPart]),
      'm.ogg',
    );
    for (const src of [chained, muxed]) {
      const m = await oggHandler.read(src);
      expect(m.canWrite).toBe(false);
      expect(m.warnings.join()).toMatch(/chained|multiplexed/);
      expect(field(m, 'vorbis:TITLE')?.value).toBe('Test Song');
      await expect(oggHandler.write!(src, edits({ 'vorbis:TITLE': 'x' }))).rejects.toThrow(/can only be viewed/);
      await expect(oggHandler.strip!(src, strip())).rejects.toThrow(/can only be viewed/);
    }
  });

  it('removes the whole tag group', async () => {
    const out = await oggHandler.write!(fixture('audio/vorbis.ogg'), edits({ [groupKey('vorbis')]: REMOVE }));
    const m = await oggHandler.read(new Source(out));
    expect(allFields(m).map((f) => f.id)).toEqual(['vorbis:picture:0']);
    await sameAudio(out, 'audio/vorbis.ogg');
  });
});
