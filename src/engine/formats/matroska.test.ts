import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { concat, indexOfBytes } from '../core/binary';
import { MetadataError, Source, groupKey, type ImageValue, type Metadata } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { UNKNOWN_SIZE, element, encodeId, encodeSize, floatElement, parseChildren, readHeader, readUint, stringElement, uintElement } from './ebml';
import { NEUTRAL_APP, matroskaHandler } from './matroska';

const MARK = 'SECRET-MARKER-42';
const tmp = mkdtempSync(join(tmpdir(), 'blueexif-mkv-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function save(bytes: Uint8Array, ext: string): string {
  const p = join(tmp, `f${n++}.${ext}`);
  writeFileSync(p, bytes);
  return p;
}

interface Probe {
  format: { duration?: string; tags?: Record<string, string> };
  streams: Array<{ codec_name?: string; codec_type: string; tags?: Record<string, string> }>;
  chapters: unknown[];
}

function ffprobe(bytes: Uint8Array, ext: string): Probe {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', save(bytes, ext)], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(r.stderr).toBe('');
  return JSON.parse(r.stdout) as Probe;
}

/** pts/dts/size/flags of every timed packet: identical lists mean the payload is untouched. */
function packets(bytes: Uint8Array, ext: string, allowErrors = false): string {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=stream_index,pts,dts,size,flags', '-of', 'csv', save(bytes, ext)], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (!allowErrors) expect(r.stderr).toBe('');
  return r.stdout
    .split('\n')
    .filter((l) => !l.includes(',N/A,N/A,')) // attached pictures
    .join('\n');
}

/** Full decode plus a seek; returns ffmpeg's error output (must be empty). */
function decodeErrors(bytes: Uint8Array, ext: string): string {
  const p = save(bytes, ext);
  const full = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 });
  const seek = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', p, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 });
  return `${full.stderr}${seek.stderr}${full.status || seek.status ? 'exit status != 0' : ''}`;
}

const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_SEEKHEAD = 0x114d9b74;
const LEVEL1 = new Set([ID_SEEKHEAD, 0x1549a966, 0x1654ae6b, ID_CLUSTER, ID_CUES, 0x1043a770, 0x1254c367, 0x1941a469]);

interface Top {
  id: number;
  pos: number;
  dataPos: number;
  end: number;
  unknown: boolean;
}

/**
 * Independent structural check: every SeekHead entry points at an element
 * with the announced id, every CueClusterPosition at a Cluster and every
 * CueRelativePosition at a block. Returns the level-1 elements.
 */
function checkStructure(b: Uint8Array): { top: Top[]; segData: number } {
  const eh = readHeader(b, 0)!;
  const sp = eh.headerSize + eh.size;
  const sh = readHeader(b, sp)!;
  expect(sh.id).toBe(ID_SEGMENT);
  const segData = sp + sh.headerSize;
  const segEnd = sh.size === UNKNOWN_SIZE ? b.length : segData + sh.size;
  expect(segEnd).toBeLessThanOrEqual(b.length);
  const top: Top[] = [];
  let p = segData;
  while (p < segEnd) {
    const h = readHeader(b, p)!;
    expect(h).not.toBeNull();
    let end = p + h.headerSize + h.size;
    if (h.size === UNKNOWN_SIZE) {
      expect(h.id).toBe(ID_CLUSTER);
      let q = p + h.headerSize;
      while (q < segEnd) {
        const c = readHeader(b, q)!;
        if (LEVEL1.has(c.id)) break;
        q += c.headerSize + c.size;
      }
      end = q;
    }
    top.push({ id: h.id, pos: p, dataPos: p + h.headerSize, end, unknown: h.size === UNKNOWN_SIZE });
    p = end;
  }
  expect(p).toBe(segEnd);
  const at = (rel: number) => top.find((t) => t.pos === segData + rel);
  for (const s of top.filter((t) => t.id === ID_SEEKHEAD)) {
    for (const seek of parseChildren(b, s.dataPos, s.end).filter((e) => e.id === 0x4dbb)) {
      const kids = parseChildren(seek.data);
      const id = readUint(kids.find((k) => k.id === 0x53ab)!.data);
      const pos = readUint(kids.find((k) => k.id === 0x53ac)!.data);
      expect(at(pos)?.id).toBe(id);
    }
  }
  for (const c of top.filter((t) => t.id === ID_CUES)) {
    for (const cp of parseChildren(b, c.dataPos, c.end).filter((e) => e.id === 0xbb)) {
      for (const tp of parseChildren(cp.data).filter((e) => e.id === 0xb7)) {
        const kids = parseChildren(tp.data);
        const cluster = at(readUint(kids.find((k) => k.id === 0xf1)!.data));
        expect(cluster?.id).toBe(ID_CLUSTER);
        const rel = kids.find((k) => k.id === 0xf0);
        if (rel && cluster) expect([0xa3, 0xa0]).toContain(readHeader(b, cluster.dataPos + readUint(rel.data))?.id);
      }
    }
  }
  return { top, segData };
}

const has = (bytes: Uint8Array, s: string) => indexOfBytes(bytes, s) >= 0;
const read = async (b: Blob | Uint8Array, name = 'out.mkv'): Promise<Metadata> =>
  matroskaHandler.read(b instanceof Blob ? new Source(b, name) : Source.fromBytes(b, name));

describe('matroska', () => {
  it('detects and reads a tagged Matroska file', async () => {
    const head = fixtureBytes('video/tagged.mkv').subarray(0, 65536);
    expect(matroskaHandler.detect({ head, name: 'x.bin', ext: 'bin', size: head.length })).toBe(3);
    const m = await matroskaHandler.read(fixture('video/tagged.mkv'));
    expect(m.format.id).toBe('matroska');
    expect(m.format.category).toBe('video');
    expect(m.format.mime).toBe('video/x-matroska');
    expect(m.warnings).toEqual([]);
    const info = Object.fromEntries(m.info.map((i) => [i.label, i.value]));
    expect(info.Container).toBe('Matroska');
    expect(info.Dimensions).toBe('64 × 48');
    expect(info.Duration).toBe('1.02 s');
    expect(info['Track 1']).toBe(`Video · H.264 (AVC) · 64 × 48 · 10 fps · “Main video ${MARK}”`);
    expect(info['Track 2']).toBe('Audio · AAC · 48000 Hz · 1 ch · “Commentary” · fra');
    expect(info.Chapters).toBe('2');

    expect(field(m, 'mkv:title')?.value).toBe(`Movie ${MARK}`);
    expect(field(m, 'mkv:date')?.value).toBe('2024-05-01T10:00:00Z');
    expect(field(m, 'mkv:date')?.sensitivity).toBe('time');
    expect(String(field(m, 'mkv:muxingapp')?.value)).toMatch(/^Lavf/);
    expect(field(m, 'mkv:segmentuid')?.kind).toBe('raw');
    expect(field(m, 'mkv:track:1:name')?.value).toBe(`Main video ${MARK}`);
    expect(field(m, 'mkv:track:2:name')?.value).toBe('Commentary');
    expect(field(m, 'mkv:tag:50:ARTIST')?.value).toBe(`Jane ${MARK}`);
    expect(field(m, 'mkv:tag:50:ARTIST')?.sensitivity).toBe('identity');
    expect(field(m, 'mkv:tag:50:COMMENT')?.kind).toBe('multiline');
    expect(field(m, 'mkv:tag:50:DATE_RELEASED')).toMatchObject({ kind: 'datetime', value: '2024-05-01', label: 'Release date' });
    expect(field(m, 'mkv:tag:50:ENCODER')?.sensitivity).toBe('software');
    const trackEncoder = allFields(m).filter((f) => /^mkv:tag:track\d+:ENCODER$/.test(f.id));
    expect(trackEncoder.map((f) => f.value)).toEqual([expect.stringMatching(/libx264$/), expect.stringMatching(/aac$/)]);
    const groups = m.groups.map((g) => g.label);
    expect(groups).toContain('Tags — track 1 (video)');

    const cover = allFields(m).find((f) => f.kind === 'image');
    expect(cover?.label).toBe('Cover art');
    expect((cover?.value as ImageValue).mime).toBe('image/jpeg');
    expect((cover?.value as ImageValue).width).toBe(32);
    const font = allFields(m).find((f) => f.label === 'Font “font.ttf”');
    expect(font?.kind).toBe('raw');
    expect(font?.display).toMatch(/application\/x-truetype-font/);
    // The global tag group offers addable tags
    const tagsGroup = m.groups.find((g) => g.id === 'mkv.tags.50');
    expect(tagsGroup?.addable?.map((a) => a.id)).toContain('mkv:tag:50:TITLE');
    expect(tagsGroup?.addable?.map((a) => a.id)).not.toContain('mkv:tag:50:ARTIST');
  });

  it('edits info, track names and tags; ExifTool, ffprobe and ffmpeg agree', async () => {
    const orig = fixtureBytes('video/tagged.mkv');
    const before = await read(orig);
    const videoTag = allFields(before).find((f) => /^mkv:tag:track\d+:ENCODER$/.test(f.id))!.id;
    const out = await matroskaHandler.write!(
      fixture('video/tagged.mkv'),
      edits({
        'mkv:title': 'Neuer Titel — ünïcödé ✓',
        'mkv:date': '2023-12-24T20:15:00+01:00',
        'mkv:muxingapp': 'MyMuxer',
        'mkv:track:1:name': 'Renamed video',
        'mkv:track:2:name': REMOVE,
        'mkv:tag:50:ARTIST': 'Zoë',
        'mkv:tag:50:COMMENT': REMOVE,
        'mkv:tag:50:KEYWORDS': 'k1, k2',
        'mkv:tag:50:DESCRIPTION': 'Line 1\nLine 2',
        'mkv:tag:50:ARTIST/SORT_WITH': 'Zoe',
        [videoTag]: 'custom encoder',
      }),
    );
    const bytes = await bytesOf(out);
    checkStructure(bytes);

    const m = await read(bytes);
    expect(m.warnings).toEqual([]);
    expect(field(m, 'mkv:title')?.value).toBe('Neuer Titel — ünïcödé ✓');
    expect(field(m, 'mkv:date')?.value).toBe('2023-12-24T19:15:00Z');
    expect(field(m, 'mkv:muxingapp')?.value).toBe('MyMuxer');
    expect(field(m, 'mkv:track:1:name')?.value).toBe('Renamed video');
    expect(field(m, 'mkv:track:2:name')).toBeUndefined();
    expect(field(m, 'mkv:tag:50:ARTIST')?.value).toBe('Zoë');
    expect(field(m, 'mkv:tag:50:ARTIST/SORT_WITH')?.value).toBe('Zoe');
    expect(field(m, 'mkv:tag:50:COMMENT')).toBeUndefined();
    expect(field(m, 'mkv:tag:50:KEYWORDS')?.value).toBe('k1, k2');
    expect(field(m, 'mkv:tag:50:DESCRIPTION')?.value).toBe('Line 1\nLine 2');
    expect(field(m, videoTag)?.value).toBe('custom encoder');
    // untouched values survive
    expect(field(m, 'mkv:tag:50:COPYRIGHT')?.value).toBe('(c) 2024 Jane');
    expect(field(m, 'mkv:segmentuid')?.display).toBe(field(before, 'mkv:segmentuid')?.display);
    expect(allFields(m).filter((f) => f.kind === 'image')).toHaveLength(1);

    const et = await exiftool(bytes, 'out.mkv');
    expect(etProblems(et)).toEqual([]);
    expect(et['Matroska:Title']).toBe('Neuer Titel — ünïcödé ✓');
    expect(et['Matroska:DateTimeOriginal']).toBe('2023:12:24 19:15:00Z');
    expect(et['Matroska:MuxingApp']).toBe('MyMuxer');
    expect(et['Track1:TrackName']).toBe('Renamed video');
    expect(et['Track2:TrackName']).toBeUndefined();
    expect(et['Matroska:SortWith']).toBe('Zoe'); // ExifTool reports only the nested name
    expect(et['Matroska:Description']).toBe('Line 1\nLine 2');
    expect(etFind(et, 'Comment')).toEqual([]);

    const p = ffprobe(bytes, 'mkv');
    const p0 = ffprobe(orig, 'mkv');
    expect(p.format.tags?.title).toBe('Neuer Titel — ünïcödé ✓');
    expect(p.format.tags?.ARTIST).toBe('Zoë');
    expect(p.format.tags?.['ARTIST/SORT_WITH']).toBe('Zoe');
    expect(p.format.tags?.creation_time).toBe('2023-12-24T19:15:00.000000Z');
    expect(p.format.duration).toBe(p0.format.duration);
    expect(p.streams.map((s) => s.codec_name)).toEqual(p0.streams.map((s) => s.codec_name));
    expect(p.streams[0].tags?.title).toBe('Renamed video');
    expect(p.streams[0].tags?.ENCODER).toBe('custom encoder');
    expect(p.streams[1].tags?.title).toBeUndefined();
    expect(p.chapters).toHaveLength(2);
    expect(packets(bytes, 'mkv')).toBe(packets(orig, 'mkv'));
    expect(decodeErrors(bytes, 'mkv')).toBe('');
  });

  it('keeps Cues in front of the clusters and patches their positions', async () => {
    const orig = fixtureBytes('video/front.mkv');
    const s0 = checkStructure(orig);
    const firstCluster = (t: Top[]) => t.findIndex((e) => e.id === ID_CLUSTER);
    expect(s0.top.findIndex((e) => e.id === ID_CUES)).toBeLessThan(firstCluster(s0.top));

    const out = await bytesOf(await matroskaHandler.write!(fixture('video/front.mkv'), edits({ 'mkv:title': 'x'.repeat(5000), 'mkv:tag:50:ARTIST': REMOVE })));
    const s1 = checkStructure(out);
    expect(s1.top.findIndex((e) => e.id === ID_CUES)).toBeLessThan(firstCluster(s1.top));
    expect(s1.top[firstCluster(s1.top)].pos).toBeGreaterThan(s0.top[firstCluster(s0.top)].pos + 4000);
    const et = await exiftool(out, 'front.mkv');
    expect(etProblems(et)).toEqual([]);
    expect(et['Matroska:Title']).toBe('x'.repeat(5000));
    expect(etFind(et, 'Artist')).toEqual([]);
    expect(packets(out, 'mkv')).toBe(packets(orig, 'mkv'));
    expect(decodeErrors(out, 'mkv')).toBe('');
  });

  it('finds Tags after the clusters via SeekHead and moves them to the front', async () => {
    const orig = fixtureBytes('video/tags-at-end.mkv');
    const m = await read(orig);
    expect(field(m, 'mkv:tag:50:ARTIST')?.value).toBe(`Jane ${MARK}`);
    expect(field(m, 'mkv:tag:50:COMMENT')?.value).toBe(`Late ${MARK}`);

    const out = await bytesOf(await matroskaHandler.write!(fixture('video/tags-at-end.mkv'), edits({ 'mkv:tag:50:COMMENT': 'Edited late tag' })));
    const { top } = checkStructure(out);
    const ids = top.map((t) => t.id);
    expect(ids.filter((id) => id === 0x1254c367)).toHaveLength(1);
    expect(ids.indexOf(0x1254c367)).toBeLessThan(ids.indexOf(ID_CLUSTER));
    const et = await exiftool(out, 'e.mkv');
    expect(etProblems(et)).toEqual([]);
    expect(et['Matroska:Comment']).toBe('Edited late tag');
    expect(et['Matroska:Artist']).toBe(`Jane ${MARK}`);
    expect(packets(out, 'mkv')).toBe(packets(orig, 'mkv'));
    expect(decodeErrors(out, 'mkv')).toBe('');

    const s = await bytesOf(await matroskaHandler.strip!(fixture('video/tags-at-end.mkv'), strip()));
    expect(has(s, MARK)).toBe(false);
    checkStructure(s);
  });

  it('strips everything identifying but keeps fonts, chapters and payload', async () => {
    const orig = fixtureBytes('video/tagged.mkv');
    const out = await bytesOf(await matroskaHandler.strip!(fixture('video/tagged.mkv'), strip()));
    expect(has(orig, MARK)).toBe(true);
    expect(has(out, MARK)).toBe(false);
    expect(has(out, 'Lavf')).toBe(false); // no MuxingApp/ENCODER leftovers
    checkStructure(out);

    const et = await exiftool(out, 's.mkv');
    expect(etProblems(et)).toEqual([]);
    expect(et['Matroska:Title']).toBeUndefined();
    expect(et['Matroska:DateTimeOriginal']).toBeUndefined();
    expect(et['Matroska:MuxingApp']).toBe(NEUTRAL_APP);
    expect(etFind(et, 'TrackName')).toEqual([]);
    expect(etFind(et, 'Artist')).toEqual([]);
    expect(et['Matroska:AttachedFileName']).toBe('font.ttf');

    const m = await read(out);
    expect(allFields(m).map((f) => f.id)).toEqual(['mkv:muxingapp', 'mkv:writingapp', 'mkv:segmentuid', expect.stringMatching(/^mkv:attachment:\d+$/)]);
    const p = ffprobe(out, 'mkv');
    expect(p.chapters).toHaveLength(2);
    expect(p.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac', 'ttf']);
    expect(packets(out, 'mkv')).toBe(packets(orig, 'mkv'));
    expect(decodeErrors(out, 'mkv')).toBe('');

    // keepCoverArt keeps the image attachment
    const kept = await read(await matroskaHandler.strip!(fixture('video/tagged.mkv'), strip({ keepCoverArt: true })));
    expect(allFields(kept).filter((f) => f.kind === 'image')).toHaveLength(1);
  });

  it('drops attachments other than fonts (notes, documents) when stripping', async () => {
    const notes = join(tmp, 'notes.txt');
    writeFileSync(notes, `Shot by Jane Doe ${MARK}`);
    const withNotes = join(tmp, 'notes.mkv');
    const r = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        save(fixtureBytes('video/tagged.mkv'), 'mkv'),
        '-attach',
        notes,
        '-metadata:s:4',
        'mimetype=text/plain',
        '-map',
        '0',
        '-c',
        'copy',
        withNotes,
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(r.stderr).toBe('');
    const src = new Source(new Blob([readFileSync(withNotes)]), 'notes.mkv');
    const m = await read(new Uint8Array(readFileSync(withNotes)));
    expect(allFields(m).find((f) => f.label === 'Attachment “notes.txt”')?.sensitivity).toBe('content');
    const out = await bytesOf(await matroskaHandler.strip!(src, strip()));
    expect(has(out, MARK)).toBe(false);
    const after = allFields(await read(out)).map((f) => f.label);
    expect(after).toContain('Font “font.ttf”');
    expect(after).not.toContain('Attachment “notes.txt”');
    checkStructure(out);
  });

  it('adds, replaces and removes cover art; removes tag groups', async () => {
    const before = await read(fixtureBytes('video/tagged.mkv'));
    const coverId = allFields(before).find((f) => f.kind === 'image')!.id;
    const png = fixturePng();
    const out = await matroskaHandler.write!(
      fixture('video/tagged.mkv'),
      edits({ [coverId]: { mime: 'image/png', data: png }, [groupKey('mkv.tags.50')]: REMOVE }),
    );
    const m = await read(out);
    const cover = field(m, coverId);
    expect((cover?.value as ImageValue).mime).toBe('image/png');
    expect(cover?.display).toMatch(/^cover\.png/);
    expect(allFields(m).some((f) => f.id.startsWith('mkv:tag:50:'))).toBe(false);
    expect(field(m, 'mkv:title')?.value).toBe(`Movie ${MARK}`); // Info title is not a tag
    const et = await exiftool(out, 'c.mkv');
    expect(etProblems(et)).toEqual([]);
    expect(etFind(et, 'Artist')).toEqual([]);

    // remove the cover, then add a new one to the stripped file
    const removed = await read(await matroskaHandler.write!(fixture('video/tagged.mkv'), edits({ [coverId]: REMOVE })));
    expect(allFields(removed).filter((f) => f.kind === 'image')).toEqual([]);
    expect(removed.groups.find((g) => g.id === 'mkv.attachments')?.addable?.[0].id).toBe('mkv:attachment:cover');
    const stripped = await matroskaHandler.strip!(fixture('video/tagged.mkv'), strip());
    const added = await matroskaHandler.write!(new Source(stripped, 's.mkv'), edits({ 'mkv:attachment:cover': { mime: 'image/png', data: png } }));
    const m2 = await read(added);
    expect(allFields(m2).find((f) => f.kind === 'image')?.label).toBe('Cover art');
    const p = ffprobe(await bytesOf(added), 'mkv');
    expect(p.streams.find((s) => s.tags?.filename === 'cover.png')?.tags?.mimetype).toBe('image/png');
    expect(decodeErrors(await bytesOf(added), 'mkv')).toBe('');
  });

  it('handles WebM: read, edit, strip; refuses attachments', async () => {
    const orig = fixtureBytes('video/tagged.webm');
    const m = await read(orig, 'tagged.webm');
    expect(m.format).toMatchObject({ name: 'WebM video', mime: 'video/webm', category: 'video' });
    expect(field(m, 'mkv:title')?.value).toBe(`Movie ${MARK}`);
    expect(field(m, 'mkv:track:1:name')?.value).toBe(`Camera ${MARK}`);
    expect(m.groups.find((g) => g.id === 'mkv.attachments')).toBeUndefined();

    const out = await bytesOf(await matroskaHandler.write!(fixture('video/tagged.webm'), edits({ 'mkv:title': 'WebM title', 'mkv:tag:50:GENRE': 'Docu' })));
    checkStructure(out);
    const et = await exiftool(out, 'o.webm');
    expect(etProblems(et)).toEqual([]);
    expect(et['Matroska:Title']).toBe('WebM title');
    expect(et['Matroska:Genre']).toBe('Docu');
    expect(packets(out, 'webm')).toBe(packets(orig, 'webm'));
    expect(decodeErrors(out, 'webm')).toBe('');

    const s = await bytesOf(await matroskaHandler.strip!(fixture('video/tagged.webm'), strip()));
    expect(has(s, MARK)).toBe(false);
    checkStructure(s);
    expect(etProblems(await exiftool(s, 's.webm'))).toEqual([]);
    expect(packets(s, 'webm')).toBe(packets(orig, 'webm'));
    expect(decodeErrors(s, 'webm')).toBe('');

    await expect(
      matroskaHandler.write!(fixture('video/tagged.webm'), edits({ 'mkv:attachment:cover': { mime: 'image/png', data: fixturePng() } })),
    ).rejects.toThrow(MetadataError);
  });

  it('treats audio-only Matroska as audio', async () => {
    const orig = fixtureBytes('video/audio.mka');
    const m = await read(orig, 'audio.mka');
    expect(m.format).toMatchObject({ name: 'Matroska audio', mime: 'audio/x-matroska', category: 'audio' });
    expect(field(m, 'mkv:title')?.value).toBe(`Song ${MARK}`);
    expect(field(m, 'mkv:tag:50:ARTIST')?.value).toBe(`Singer ${MARK}`);
    expect(allFields(m).find((f) => f.kind === 'image')?.label).toBe('Cover art');

    const s = await bytesOf(await matroskaHandler.strip!(fixture('video/audio.mka'), strip()));
    expect(has(s, MARK)).toBe(false);
    expect(allFields(await read(s)).some((f) => f.kind === 'image')).toBe(false);
    expect(etProblems(await exiftool(s, 's.mka'))).toEqual([]);
    expect(packets(s, 'mka')).toBe(packets(orig, 'mka'));
    expect(decodeErrors(s, 'mka')).toBe('');
  });

  it('copes with unknown-size Segment and Clusters (live recordings)', async () => {
    const orig = fixtureBytes('video/live.webm');
    const s0 = checkStructure(orig);
    expect(s0.top.filter((t) => t.id === ID_CLUSTER).every((t) => t.unknown)).toBe(true);
    const m = await read(orig, 'live.webm');
    expect(field(m, 'mkv:title')?.value).toBe(`Live ${MARK}`);

    const out = await bytesOf(await matroskaHandler.write!(fixture('video/live.webm'), edits({ 'mkv:title': 'Edited live', 'mkv:tag:50:ARTIST': 'Someone' })));
    const s1 = checkStructure(out);
    expect(s1.top.filter((t) => t.id === ID_CLUSTER)).toHaveLength(s0.top.filter((t) => t.id === ID_CLUSTER).length);
    expect(field(await read(out), 'mkv:title')?.value).toBe('Edited live');
    const et = await exiftool(out, 'l.webm');
    expect(etProblems(et)).toEqual([]);
    expect(et['Matroska:Title']).toBe('Edited live');
    expect(packets(out, 'webm')).toBe(packets(orig, 'webm'));
    expect(decodeErrors(out, 'webm')).toBe('');

    const s = await bytesOf(await matroskaHandler.strip!(fixture('video/live.webm'), strip()));
    expect(has(s, MARK)).toBe(false);
    expect(packets(s, 'webm')).toBe(packets(orig, 'webm'));
  });

  it('patches Cluster Position elements and Cues in a hand-built file', async () => {
    const b = syntheticMkv();
    checkStructure(b);
    const out = await bytesOf(await matroskaHandler.write!(Source.fromBytes(b, 's.mkv'), edits({ 'mkv:title': 'A much longer title than before' })));
    const { top, segData } = checkStructure(out);
    const clusters = top.filter((t) => t.id === ID_CLUSTER);
    expect(clusters).toHaveLength(2);
    for (const c of clusters) {
      const pos = parseChildren(out, c.dataPos, c.end).find((e) => e.id === 0xa7)!;
      expect(readUint(pos.data)).toBe(c.pos - segData);
    }
    expect(field(await read(out), 'mkv:title')?.value).toBe('A much longer title than before');
  });

  it('rewrites interrupted recordings, refuses damaged metadata', async () => {
    // last cluster cut off: still writable, Segment becomes unknown-size
    const full = fixtureBytes('video/front.mkv');
    const cut = full.subarray(0, full.length - 100);
    const m = await read(cut);
    expect(m.warnings).toEqual(['The file appears to be truncated (incomplete recording?).']);
    expect(field(m, 'mkv:title')?.value).toBe(`Front ${MARK}`);
    const out = await bytesOf(await matroskaHandler.strip!(Source.fromBytes(cut, 'cut.mkv'), strip()));
    expect(has(out, MARK)).toBe(false);
    expect(readHeader(out, readHeader(out, 0)!.headerSize + readHeader(out, 0)!.size)!.size).toBe(UNKNOWN_SIZE);
    expect(packets(out, 'mkv', true)).toBe(packets(cut, 'mkv', true));

    // a cut inside the Tags element cannot be rewritten safely
    const b = fixtureBytes('video/tagged.mkv');
    const tags = checkStructure(b).top.find((t) => t.id === 0x1254c367)!;
    const broken = b.subarray(0, tags.pos + 40);
    expect(field(await read(broken), 'mkv:title')?.value).toBe(`Movie ${MARK}`);
    await expect(matroskaHandler.strip!(Source.fromBytes(broken, 'broken.mkv'), strip())).rejects.toThrow(MetadataError);
  });
});

/** Smallest valid PNG (1×1). */
function fixturePng(): Uint8Array {
  return Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
}

/** Matroska with Cluster Position elements, Cues and an unknown-size-free layout. */
function syntheticMkv(): Uint8Array {
  const ebml = element(0x1a45dfa3, uintElement(0x4286, 1), stringElement(0x4282, 'matroska'), uintElement(0x4287, 4), uintElement(0x4285, 2));
  const info = element(0x1549a966, uintElement(0x2ad7b1, 1_000_000), stringElement(0x4d80, 'x'), stringElement(0x5741, 'x'), floatElement(0x4489, 200));
  const tracks = element(
    0x1654ae6b,
    element(
      0xae,
      uintElement(0xd7, 1),
      uintElement(0x73c5, 1),
      uintElement(0x83, 1),
      stringElement(0x86, 'V_UNCOMPRESSED'),
      element(0xe0, uintElement(0xb0, 2), uintElement(0xba, 2)),
    ),
  );
  const block = (t: number) => element(0xa3, new Uint8Array([0x81, 0, t, 0x80, 1, 2, 3, 4]));
  const cluster = (ts: number, pos: number) => element(ID_CLUSTER, uintElement(0xe7, ts), uintElement(0xa7, pos, 4), block(0));
  const head = info.length + tracks.length;
  const c1 = cluster(0, head);
  const c2 = cluster(100, head + c1.length);
  const cue = (t: number, pos: number) =>
    element(0xbb, uintElement(0xb3, t), element(0xb7, uintElement(0xf7, 1), uintElement(0xf1, pos), uintElement(0xf0, 9)));
  const cues = element(ID_CUES, cue(0, head), cue(100, head + c1.length));
  const body = [info, tracks, c1, c2, cues];
  const size = body.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(ebml.length + 12 + size);
  out.set(ebml);
  out.set(encodeId(ID_SEGMENT), ebml.length);
  out.set(encodeSize(size, 8), ebml.length + 4);
  let p = ebml.length + 12;
  for (const x of body) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

describe('matroska: hostile nesting', () => {
  it('reads and strips 50,000 nested SimpleTags without overflowing the stack', async () => {
    const D = 50_000;
    const size4 = (n: number) => [0x10 | ((n >> 24) & 0x0f), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    // Each SimpleTag: id (2), size (4), TagName "A" (4), then the next one inside it.
    const nested = new Uint8Array(D * 10);
    for (let k = 0; k < D; k++) nested.set([0x67, 0xc8, ...size4((D - k) * 10 - 6), 0x45, 0xa3, 0x81, 0x41], k * 10);
    const tags = element(0x1254c367, element(0x7373, nested));
    const info = element(0x1549a966, stringElement(0x4d80, 'x'), stringElement(0x5741, 'x'));
    const file = concat([element(0x1a45dfa3, stringElement(0x4282, 'matroska')), element(ID_SEGMENT, info, tags)]);
    const m = await matroskaHandler.read(Source.fromBytes(file, 'deep.mkv'));
    expect(allFields(m).some((f) => f.id.startsWith('mkv:tag:'))).toBe(true);
    const out = await bytesOf(await matroskaHandler.strip!(Source.fromBytes(file, 'deep.mkv'), strip()));
    expect(indexOfBytes(out, new Uint8Array([0x12, 0x54, 0xc3, 0x67]))).toBe(-1);
  });
});
