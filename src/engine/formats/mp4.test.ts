import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupKey, Source, type GpsValue, type ImageValue, type Metadata } from '../core/types';
import { Reader, Writer, encodeLatin1, indexOfBytes } from '../core/binary';
import {
  assemble,
  child,
  childrenOf,
  container,
  findPath,
  fullHead,
  handlerType,
  leaf,
  parseBoxes,
  patchChunkOffsets,
  relocator,
  scanTopLevel,
  trackId,
  type BoxNode,
  type Piece,
} from '../core/isobmff';
import { REMOVE, allFields, bytesOf, edits, etFind, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { mp4Handler } from './mp4';

const MARKER = 'SECRET-MARKER-42';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const KEY = (k: string) => `mp4:mdta:com.apple.quicktime.${k}`;

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** ffmpeg view of a file: packet checksum (stream copy) and decode errors. */
function ffcheck(bytes: Uint8Array, name: string): { md5: string; errors: string; streams: string } {
  const dir = mkdtempSync(join(tmpdir(), 'blueexif-mp4-'));
  try {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    // Cover art shows up as an attached-picture stream ("v"); compare real streams ("V") only.
    const map = ['-map', '0:V?', '-map', '0:a?', '-map', '0:s?'];
    const md5 = spawnSync('ffmpeg', ['-v', 'error', '-i', p, ...map, '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' });
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', p, ...map, '-f', 'null', '-'], { encoding: 'utf8' });
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,sample_rate,channels,nb_frames:stream_disposition=attached_pic', '-of', 'compact', p],
      { encoding: 'utf8' },
    );
    const streams = probe.stdout
      .trim()
      .split('\n')
      .filter((l) => !l.includes('attached_pic=1'))
      .join('\n');
    return { md5: md5.stdout.trim() + md5.stderr.trim(), errors: dec.stderr.trim(), streams };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Payload must be bit-identical and decode cleanly. */
function expectSamePayload(out: Uint8Array, original: Uint8Array, name: string): void {
  if (!hasFfmpeg) return;
  const a = ffcheck(original, name);
  const b = ffcheck(out, name);
  expect(b.errors).toBe('');
  expect(b.md5).toBe(a.md5);
  expect(b.streams).toBe(a.streams);
}

const has = (bytes: Uint8Array, s: string) => indexOfBytes(bytes, s) >= 0;

/** ExifTool problems in `out` that the untouched file does not already have. */
async function newProblems(out: Uint8Array, original: Uint8Array, name: string): Promise<string[]> {
  const before = new Set(etProblems(await exiftool(original, name)));
  return etProblems(await exiftool(out, name)).filter((w) => !before.has(w));
}
const reread = async (b: Blob | Uint8Array, name: string): Promise<Metadata> =>
  mp4Handler.read(new Source(b instanceof Blob ? b : new Blob([b as BlobPart]), name));

/** Run ffmpeg on `files` written to a temp dir; returns the bytes of `out`. */
function ffmpeg(files: Record<string, Uint8Array | string>, out: string, args: (path: (name: string) => string) => string[]): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'blueexif-mp4-'));
  try {
    for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args((n) => join(dir, n))], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(join(dir, out)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MOOV_CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl', 'dinf', 'udta', 'tref']);

async function moovOf(bytes: Uint8Array): Promise<BoxNode> {
  const box = (await scanTopLevel(Source.fromBytes(bytes))).boxes.find((b) => b.type === 'moov')!;
  const tree = parseBoxes(bytes.subarray(box.start + box.headerSize, box.end), 0, box.size - box.headerSize, (t) => (MOOV_CONTAINERS.has(t) ? 0 : null), ['moov']);
  return { type: 'moov', children: tree.boxes, tail: tree.tail };
}

/** Rewrite the moov of a file in a test (chunk offsets follow if it changes size, unless `raw`). */
async function editMoov(bytes: Uint8Array, fn: (moov: BoxNode) => void, raw = false): Promise<Uint8Array> {
  const src = Source.fromBytes(bytes);
  const { boxes } = await scanTopLevel(src);
  const moov = await moovOf(bytes);
  fn(moov);
  const pieces: Piece[] = boxes.map((b) => (b.type === 'moov' ? { node: moov } : { copy: [b.start, b.end] }));
  if (!raw) patchChunkOffsets(moov, relocator(pieces));
  return bytesOf(assemble(src, pieces));
}

/** Total size of a track's samples (stsz). */
function sampleBytes(trak: BoxNode | undefined): number {
  const d = findPath(trak, 'mdia/minf/stbl/stsz')!.data!;
  const r = new Reader(d);
  let n = 0;
  for (let i = 0; i < r.u32(8); i++) n += r.u32(4) || r.u32(12 + i * 4);
  return n;
}

function retype(n: BoxNode, at: number, fourcc: string): void {
  n.data = n.data!.slice();
  n.data.set(encodeLatin1(fourcc), at);
}

const u32s = (...ns: number[]) => {
  const w = new Writer(false, ns.length * 4);
  for (const n of ns) w.u32(n);
  return w.finish();
};

/** Initial object descriptor listing the given tracks (ES_ID_Inc). */
function iods(...tracks: number[]): BoxNode {
  const body = [0x00, 0x4f, 0xff, 0xff, 0xff, 0xff, 0xff, ...tracks.flatMap((t) => [0x0e, 4, ...u32s(t)])];
  return leaf('iods', fullHead(0), new Uint8Array([0x10, body.length, ...body]));
}

const TELEMETRY = `GPS ${MARKER} TELEMETRY`;
const SRT = `1\n00:00:00,000 --> 00:00:00,500\n${TELEMETRY} 37.7749 -122.4194\n\n2\n00:00:00,500 --> 00:00:01,000\n${TELEMETRY} 37.7750 -122.4195\n`;

const trakByHandler = (moov: BoxNode, ...h: string[]) => childrenOf(moov, 'trak').find((t) => h.includes(handlerType(findPath(t, 'mdia/hdlr')) ?? ''));

/**
 * A fixture remuxed with a third track: a mov_text subtitle whose samples
 * hold TELEMETRY, turned into a timed-metadata track (handler 'meta', sample
 * entry `entry`). Unless `fixedSize`, the track is also linked like camera
 * files do: it references the video (tref cdsc), the video references it
 * (tref sync / cdep) and an iods lists it.
 */
async function withTelemetry(base: string, entry: string, movflags: string[], fixedSize = false): Promise<Uint8Array> {
  const ext = base.split('.').pop()!;
  const muxed = ffmpeg({ [`in.${ext}`]: fixtureBytes(`isobmff/${base}`), 'gps.srt': SRT }, `out.${ext}`, (p) => [
    '-i', p(`in.${ext}`), '-i', p('gps.srt'), '-map', '0:v', '-map', '0:a', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', ...movflags, p(`out.${ext}`),
  ]);
  return editMoov(muxed, (moov) => {
    const trak = trakByHandler(moov, 'sbtl', 'text')!;
    const hdlr = findPath(trak, 'mdia/hdlr')!;
    retype(hdlr, 8, 'meta');
    retype(findPath(trak, 'mdia/minf/stbl/stsd')!, 12, entry);
    if (fixedSize) return;
    // handler name: C string in ISO files, Pascal string in QuickTime
    hdlr.data = new Uint8Array([...hdlr.data!.subarray(0, 24), ...encodeLatin1(ext === 'mov' ? '\x09GoPro MET' : 'GoPro MET\0')]);
    trak.children!.splice(1, 0, container('tref', [leaf('cdsc', u32s(1))]));
    const video = trakByHandler(moov, 'vide')!;
    video.children!.splice(1, 0, container('tref', [leaf('sync', u32s(3)), leaf('cdep', u32s(2, 3))]));
    if (ext === 'mp4') moov.children!.splice(1, 0, iods(1, 2, 3));
  });
}

const moovBytes = async (bytes: Uint8Array) => {
  const b = (await scanTopLevel(Source.fromBytes(bytes))).boxes.find((x) => x.type === 'moov')!;
  return bytes.subarray(b.start, b.end);
};

const mdatPayload = async (bytes: Uint8Array) => {
  const b = (await scanTopLevel(Source.fromBytes(bytes))).boxes.find((x) => x.type === 'mdat')!;
  return bytes.subarray(b.start + b.headerSize, b.end);
};

/** Media data of `out` equals that of `input` except for bytes blanked to zero; returns how many were. */
async function blankedBytes(out: Uint8Array, input: Uint8Array): Promise<number> {
  const a = await mdatPayload(input);
  const b = await mdatPayload(out);
  expect(b.length).toBe(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    expect(b[i]).toBe(0);
    n++;
  }
  return n;
}

describe('mp4: detection', () => {
  it('claims MP4/MOV/M4A/3GP by ftyp and defers HEIF brands', () => {
    const ctx = (f: string) => {
      const head = fixtureBytes(`isobmff/${f}`).subarray(0, 65536);
      return { head, name: f, ext: f.split('.').pop()!, size: head.length };
    };
    for (const f of ['tagged.mp4', 'iphone.mov', 'audio.m4a', 't.3gp', 'frag.mp4']) expect(mp4Handler.detect(ctx(f))).toBe(3);
    expect(mp4Handler.detect(ctx('camera.heic'))).toBeLessThan(3);
  });
});

describe('mp4: reading', () => {
  it('reads iTunes tags, 3GPP location, XMP and stream info from an MP4', async () => {
    const m = await mp4Handler.read(fixture('isobmff/tagged.mp4'));
    expect(m.format).toMatchObject({ id: 'mp4', name: 'MPEG-4 video', category: 'video', mime: 'video/mp4' });
    expect(m.info.find((i) => i.label === 'Video')?.value).toBe('H.264 · 64 × 48 · 10 fps');
    expect(m.info.find((i) => i.label === 'Audio')?.value).toMatch(/^AAC-LC · 22,050 Hz · mono$/);
    expect(m.info.find((i) => i.label === 'Duration')?.value).toBe('1.00 s');
    expect(field(m, 'mp4:ilst:©nam')?.value).toBe('My Title');
    expect(field(m, 'mp4:ilst:©cmt')?.value).toBe(MARKER);
    expect(field(m, 'mp4:ilst:apID')).toMatchObject({ value: 'jane@example.com', sensitivity: 'identity' });
    const loci = field(m, 'mp4:udta:loci')?.value as GpsValue;
    expect(loci.lat).toBeCloseTo(37.7749, 3);
    expect(loci.lon).toBeCloseTo(-122.4194, 3);
    expect(field(m, XMP_TITLE)?.value).toBe('XMP title');
    expect(m.warnings).toEqual([]);
  });

  it('reads QuickTime keys, user data, XMP_ and header dates from an iPhone-like MOV', async () => {
    const m = await mp4Handler.read(fixture('isobmff/iphone.mov'));
    expect(m.format).toMatchObject({ name: 'QuickTime movie', category: 'video', mime: 'video/quicktime' });
    const g = field(m, KEY('location.ISO6709'))!;
    expect(g.sensitivity).toBe('location');
    expect((g.value as GpsValue).lat).toBeCloseTo(37.3349, 4);
    expect((g.value as GpsValue).lon).toBeCloseTo(-122.009, 4);
    expect((g.value as GpsValue).alt).toBeCloseTo(20.5, 1);
    expect(field(m, KEY('make'))?.value).toBe('Apple');
    expect(field(m, KEY('model'))).toMatchObject({ value: 'iPhone 15 Pro', sensitivity: 'device' });
    expect(field(m, KEY('creationdate'))?.value).toBe('2024-05-01T18:29:59-07:00');
    expect((field(m, 'mp4:udta:©xyz')?.value as GpsValue).lat).toBeCloseTo(37.3349, 4);
    expect(field(m, 'mp4:udta:©mak')?.value).toBe('Apple');
    expect(field(m, XMP_TITLE)?.value).toBe('Golden hour');
    expect(field(m, 'mp4:mvhd:created')).toMatchObject({ kind: 'datetime', value: '2024-05-02T01:29:59Z', sensitivity: 'time' });
    expect(field(m, 'mp4:tkhd:1:created')?.value).toBe('2024-05-02T01:29:59Z');
    expect(field(m, 'mp4:mdhd:1:created')?.value).toBe('2024-05-02T01:29:59Z');
  });

  it('reads an M4A as audio with cover art and purchase atoms', async () => {
    const m = await mp4Handler.read(fixture('isobmff/audio.m4a'));
    expect(m.format).toMatchObject({ name: 'MPEG-4 audio', category: 'audio', mime: 'audio/mp4' });
    expect(m.info.find((i) => i.label === 'Audio')?.value).toBe('AAC-LC · 44,100 Hz · mono');
    const cover = field(m, 'mp4:ilst:covr:0')!;
    expect(cover.kind).toBe('image');
    expect((cover.value as ImageValue).mime).toBe('image/jpeg');
    expect((cover.value as ImageValue).width).toBe(32);
    expect(field(m, 'mp4:ilst:trkn')).toMatchObject({ value: '3/12', display: '3 of 12' });
    expect(field(m, 'mp4:ilst:disk')?.value).toBe('1/2');
    expect(field(m, 'mp4:ilst:tmpo')).toMatchObject({ kind: 'integer', value: 120 });
    expect(field(m, 'mp4:ilst:cpil')).toMatchObject({ kind: 'enum', value: '1' });
    expect(field(m, 'mp4:ilst:ownr')?.sensitivity).toBe('identity');
    expect(field(m, 'mp4:ilst:purd')?.sensitivity).toBe('time');
    const ilst = m.groups.find((g) => g.id === 'mp4.ilst')!;
    expect(ilst.addable?.some((s) => s.id === 'mp4:ilst:covr:new' && s.kind === 'image')).toBe(true);
  });

  it('reads 3GPP asset atoms', async () => {
    const m = await mp4Handler.read(fixture('isobmff/t.3gp'));
    expect(m.format).toMatchObject({ name: '3GPP video', mime: 'video/3gpp' });
    expect(field(m, 'mp4:udta:titl')?.value).toBe('3GP Title');
    expect(field(m, 'mp4:udta:auth')).toMatchObject({ value: MARKER, sensitivity: 'identity' });
    expect(field(m, 'mp4:udta:albm')?.value).toBe('Alb');
    const g = field(m, 'mp4:udta:loci')?.value as GpsValue;
    expect(g.lat).toBeCloseTo(48.8584, 3);
    expect(g.lon).toBeCloseTo(2.2945, 3);
  });

  it('reports freeform tags, vendor atoms, uuid boxes and trailers', async () => {
    const m = await mp4Handler.read(fixture('isobmff/moovlast.mp4'));
    expect(field(m, 'mp4:----:com.apple.iTunes:MY_TAG')?.value).toBe(`custom ${MARKER}`);
    expect(field(m, 'mp4:udta:smta')).toMatchObject({ kind: 'raw', label: 'Samsung metadata', removable: true });
    expect(field(m, 'mp4:box:uuid:50524f4621d24fcebb88695cfac9c740')?.kind).toBe('raw');
    expect(field(m, 'mp4:trailer')?.label).toBe('Samsung trailer (SEF)');
    expect(m.info.find((i) => i.label === 'Layout')?.value).toBe('Index after media');
  });

  it('reads fragmented files', async () => {
    const m = await mp4Handler.read(fixture('isobmff/frag.mp4'));
    expect(m.info.find((i) => i.label === 'Layout')?.value).toBe('Fragmented (2 fragments)');
    expect(field(m, 'mp4:ilst:©nam')?.value).toBe(MARKER);
  });
});

describe('mp4: writing', () => {
  it('edits tags of a fast-start MP4 and relocates chunk offsets', async () => {
    const original = fixtureBytes('isobmff/tagged.mp4');
    const pngBytes = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    const out = await mp4Handler.write!(
      fixture('isobmff/tagged.mp4'),
      edits({
        'mp4:ilst:©nam': 'Nouveau titre — ünïcödé',
        'mp4:ilst:©cmt': REMOVE,
        'mp4:ilst:©alb': 'An album',
        'mp4:ilst:trkn': '4/9',
        'mp4:ilst:covr:new': { mime: 'image/png', data: pngBytes },
        'mp4:udta:loci': { lat: -33.8568, lon: 151.2153, alt: 5 },
        [XMP_TITLE]: 'Changed XMP title',
        'mp4:mvhd:created': '2023-12-24T20:15:00+01:00',
        'mp4:ilst:©too': 'x'.repeat(5000), // grow moov a lot
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mp4');
    expect(etProblems(et)).toEqual([]);
    expect(et['ItemList:Title']).toBe('Nouveau titre — ünïcödé');
    expect(et['ItemList:Comment']).toBeUndefined();
    expect(et['ItemList:Album']).toBe('An album');
    expect(et['ItemList:TrackNumber']).toBe('4 of 9');
    expect(et['ItemList:CoverArt']).toBeDefined();
    expect(et['ItemList:AppleStoreAccount']).toBe('jane@example.com');
    expect(et['XMP-dc:Title']).toBe('Changed XMP title');
    expect(et['XMP-dc:Creator']).toBe('Jane Doe');
    expect(et['QuickTime:CreateDate']).toBe('2023:12:24 19:15:00');
    expect(et['UserData:LocationInformation']).toMatch(/Lat=-33\.856\d+ Lon=151\.215\d+ Alt=5\.00/);
    expectSamePayload(bytes, original, 'x.mp4');

    const m = await reread(bytes, 'out.mp4');
    expect(field(m, 'mp4:ilst:©nam')?.value).toBe('Nouveau titre — ünïcödé');
    expect(field(m, 'mp4:ilst:©cmt')).toBeUndefined();
    expect((field(m, 'mp4:ilst:covr:0')?.value as ImageValue).mime).toBe('image/png');
    expect(field(m, 'mp4:mvhd:created')?.value).toBe('2023-12-24T19:15:00Z');
    expect((field(m, 'mp4:udta:loci')?.value as GpsValue).lat).toBeCloseTo(-33.8568, 4);
    expect(m.warnings).toEqual([]);
  });

  it('edits QuickTime keys, user data, XMP_ and dates in a MOV', async () => {
    const original = fixtureBytes('isobmff/iphone.mov');
    const out = await mp4Handler.write!(
      fixture('isobmff/iphone.mov'),
      edits({
        [KEY('location.ISO6709')]: { lat: 48.8584, lon: 2.2945, alt: 35 },
        [KEY('make')]: REMOVE,
        [KEY('title')]: 'Eiffel',
        [KEY('creationdate')]: '2025-01-02T03:04:05+01:00',
        'mp4:udta:©xyz': REMOVE,
        'mp4:udta:©nam': 'User data title',
        [XMP_TITLE]: 'Tour Eiffel',
        'mp4:tkhd:1:created': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mov');
    expect(etProblems(et)).toEqual([]);
    expect(et['Keys:GPSCoordinates']).toMatch(/^48 deg 51' 30\.\d+" N, 2 deg 17' 40\.\d+" E, 35 m/);
    expect(et['Keys:Make']).toBeUndefined();
    expect(et['Keys:Model']).toBe('iPhone 15 Pro');
    expect(et['Keys:Title']).toBe('Eiffel');
    expect(et['Keys:CreationDate']).toBe('2025:01:02 03:04:05+01:00');
    expect(et['UserData:GPSCoordinates']).toBeUndefined();
    expect(et['UserData:Title']).toBe('User data title');
    expect(et['XMP-dc:Title']).toBe('Tour Eiffel');
    expect(et['Track1:TrackCreateDate']).toBe('0000:00:00 00:00:00');
    expect(et['Track1:MediaCreateDate']).toBe('2024:05:02 01:29:59');
    expectSamePayload(bytes, original, 'x.mov');

    const m = await reread(bytes, 'out.mov');
    expect(field(m, KEY('make'))).toBeUndefined();
    expect(field(m, KEY('description'))?.value).toBe(MARKER);
    expect(field(m, KEY('creationdate'))?.value).toBe('2025-01-02T03:04:05+01:00');
    expect(field(m, 'mp4:tkhd:1:created')).toBeUndefined();
  });

  it('edits a file whose movie header follows the media data', async () => {
    const original = fixtureBytes('isobmff/moovlast.mp4');
    const out = await mp4Handler.write!(
      fixture('isobmff/moovlast.mp4'),
      edits({
        'mp4:----:com.apple.iTunes:MY_TAG': 'changed',
        'mp4:----:com.apple.iTunes:NEW_TAG': 'brand new',
        'mp4:ilst:©ART': 'Someone',
        'mp4:udta:smta': REMOVE,
        'mp4:box:uuid:50524f4621d24fcebb88695cfac9c740': REMOVE,
        'mp4:trailer': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    expect(has(bytes, MARKER)).toBe(false);
    const et = await exiftool(bytes, 'out.mp4');
    expect(etProblems(et)).toEqual([]);
    expect(et['ItemList:Artist']).toBe('Someone');
    expect(Object.values(et)).toContain('brand new');
    expectSamePayload(bytes, original, 'x.mp4');
    const m = await reread(bytes, 'out.mp4');
    expect(field(m, 'mp4:----:com.apple.iTunes:MY_TAG')?.value).toBe('changed');
    expect(field(m, 'mp4:----:com.apple.iTunes:NEW_TAG')?.value).toBe('brand new');
    expect(m.warnings).toEqual([]);
  });

  it('creates udta/meta/ilst, keys and XMP in a file that has none', async () => {
    const bare = await bytesOf(await mp4Handler.strip!(fixture('isobmff/tagged.mp4'), strip()));
    const out = await mp4Handler.write!(
      Source.fromBytes(bare, 'bare.mp4'),
      edits({
        'mp4:ilst:©nam': 'Fresh',
        'mp4:ilst:cpil': '1',
        [KEY('location.ISO6709')]: { lat: 1.5, lon: -2.25 },
        [KEY('make')]: 'Maker',
        [XMP_TITLE]: 'Fresh XMP',
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mp4');
    expect(etProblems(et)).toEqual([]);
    expect(et['ItemList:Title']).toBe('Fresh');
    expect(et['ItemList:Compilation']).toBe('Yes');
    expect(et['Keys:Make']).toBe('Maker');
    expect(String(et['Keys:GPSCoordinates'])).toMatch(/^1 deg 30' 0\.00" N, 2 deg 15' 0\.00" W/);
    expect(et['XMP-dc:Title']).toBe('Fresh XMP');
    expectSamePayload(bytes, bare, 'x.mp4');
    const top = await scanTopLevel(Source.fromBytes(bytes));
    expect(top.boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'uuid', 'mdat']);
    const m = await reread(bytes, 'out.mp4');
    expect(field(m, 'mp4:ilst:©nam')?.value).toBe('Fresh');
    expect(field(m, KEY('make'))?.value).toBe('Maker');
  });

  it('keeps an "extends to end of file" mdat last', async () => {
    const original = fixtureBytes('isobmff/tagged.mp4').slice();
    const mdat = (await scanTopLevel(Source.fromBytes(original))).boxes.find((b) => b.type === 'mdat')!;
    original.set([0, 0, 0, 0], mdat.start);
    const out = await mp4Handler.write!(Source.fromBytes(original, 'z.mp4'), edits({ 'mp4:ilst:©nam': 'Longer title '.repeat(30) }));
    const bytes = await bytesOf(out);
    const top = await scanTopLevel(Source.fromBytes(bytes));
    expect(top.boxes.map((b) => [b.type, b.toEnd])).toEqual([['ftyp', false], ['moov', false], ['free', false], ['uuid', false], ['mdat', true]]);
    expect(await newProblems(bytes, original, 'z.mp4')).toEqual([]);
    expectSamePayload(bytes, original, 'z.mp4');
  });

  it('relocates fragment base offsets and the fragment index of fragmented MP4s', async () => {
    for (const name of ['frag.mp4', 'fragsidx.mp4']) {
      const original = fixtureBytes(`isobmff/${name}`);
      const out = await mp4Handler.write!(fixture(`isobmff/${name}`), edits({ 'mp4:ilst:©nam': 'A much longer title than before '.repeat(20) }));
      const bytes = await bytesOf(out);
      expect(bytes.length).toBeGreaterThan(original.length);
      const et = await exiftool(bytes, name);
      // ExifTool already flags ffmpeg's fragmented layout ("Duplicate tag 'traf'").
      expect(await newProblems(bytes, original, name)).toEqual([]);
      expect(String(et['ItemList:Title'])).toMatch(/^A much longer title/);
      expectSamePayload(bytes, original, name);
      // every tfra entry points at a moof
      const top = await scanTopLevel(Source.fromBytes(bytes));
      const moofs = new Set(top.boxes.filter((b) => b.type === 'moof').map((b) => b.start));
      const mfra = top.boxes.find((b) => b.type === 'mfra');
      if (mfra) {
        const r = new Reader(bytes);
        const tfra = mfra.start + 8;
        expect(r.fourcc(tfra + 4)).toBe('tfra');
        const ver = bytes[tfra + 8];
        const n = r.u32(tfra + 20);
        expect(n).toBeGreaterThan(0);
        let p = tfra + 24;
        const sizes = r.u32(tfra + 16);
        const skip = ((sizes >> 4) & 3) + ((sizes >> 2) & 3) + (sizes & 3) + 3;
        for (let i = 0; i < n; i++) {
          p += ver ? 8 : 4;
          const off = ver ? r.u64(p) : r.u32(p);
          expect(moofs.has(off)).toBe(true);
          p += (ver ? 8 : 4) + skip;
        }
      }
    }
  });

  it('removes whole groups', async () => {
    const out = await mp4Handler.write!(
      fixture('isobmff/iphone.mov'),
      edits({ [groupKey('mp4.mdta')]: REMOVE, [groupKey('mp4.udta')]: REMOVE, [groupKey('xmp')]: REMOVE, [groupKey('mp4.dates')]: REMOVE }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.mov');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => /^(Keys|UserData|XMP)/.test(k))).toEqual([]);
    expect(et['QuickTime:CreateDate']).toBe('0000:00:00 00:00:00');
    const m = await reread(bytes, 'out.mov');
    expect(m.groups.flatMap((g) => g.fields)).toEqual([]);
  });

  it('rejects invalid values', async () => {
    await expect(mp4Handler.write!(fixture('isobmff/audio.m4a'), edits({ 'mp4:ilst:trkn': 'three' }))).rejects.toThrow(/3\/12/);
    await expect(mp4Handler.write!(fixture('isobmff/audio.m4a'), edits({ 'mp4:mvhd:created': '1800-01-01' }))).rejects.toThrow(/1904/);
  });
});

describe('mp4: strip', () => {
  const cases: Array<[string, string]> = [
    ['tagged.mp4', 'x.mp4'],
    ['iphone.mov', 'x.mov'],
    ['moovlast.mp4', 'x.mp4'],
    ['audio.m4a', 'x.m4a'],
    ['t.3gp', 'x.3gp'],
    ['frag.mp4', 'x.mp4'],
    ['fragsidx.mp4', 'x.mp4'],
  ];
  for (const [f, name] of cases) {
    it(`removes all metadata from ${f}`, async () => {
      const original = fixtureBytes(`isobmff/${f}`);
      const out = await mp4Handler.strip!(fixture(`isobmff/${f}`), strip());
      const bytes = await bytesOf(out);
      expect(has(bytes, MARKER)).toBe(false);
      expect(has(bytes, 'Jane')).toBe(false);
      expect(has(bytes, 'Lavf')).toBe(false); // encoder tag (©too/©swr)
      // encoder / device fingerprints: compressor name, sample-entry vendor, handler names
      for (const s of ['libx264', 'FFMP', 'Handler']) expect(has(bytes, s)).toBe(false);
      expect(has(await moovBytes(bytes), 'Lavc')).toBe(false); // (the AAC payload itself names its encoder)
      const et = await exiftool(bytes, name);
      expect(await newProblems(bytes, original, name)).toEqual([]);
      expect(Object.keys(et).filter((k) => /^(Keys|UserData|ItemList|XMP|Meta)/.test(k))).toEqual([]);
      expect(etFind(et, 'GPSCoordinates')).toEqual([]);
      for (const k of ['QuickTime:CreateDate', 'QuickTime:ModifyDate', 'Track1:TrackCreateDate', 'Track1:MediaCreateDate']) {
        if (et[k] !== undefined) expect(et[k]).toBe('0000:00:00 00:00:00');
      }
      expectSamePayload(bytes, original, name);
      const m = await reread(bytes, name);
      expect(allFields(m).filter((x) => x.kind !== 'raw' || x.removable)).toEqual([]);
    });
  }

  it('keeps cover art when asked, also when the iTunes tags sit in moov/meta', async () => {
    // audio.m4a with its udta/meta moved up to moov/meta (and no udta left)
    const original = await editMoov(fixtureBytes('isobmff/audio.m4a'), (moov) => {
      const udta = child(moov, 'udta')!;
      moov.children = [...moov.children!.filter((c) => c !== udta), ...childrenOf(udta, 'meta')];
    });
    const before = await reread(original, 'x.m4a');
    expect((field(before, 'mp4:ilst:covr:0')?.value as ImageValue).mime).toBe('image/jpeg');
    expect(child(await moovOf(original), 'udta')).toBeUndefined();
    const keep = await bytesOf(await mp4Handler.strip!(Source.fromBytes(original, 'x.m4a'), strip({ keepCoverArt: true })));
    expect(has(keep, MARKER)).toBe(false);
    expect(has(keep, 'jane@example.com')).toBe(false);
    const et = await exiftool(keep, 'x.m4a');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => k.startsWith('ItemList:'))).toEqual(['ItemList:CoverArt']);
    const m = await reread(keep, 'x.m4a');
    expect(allFields(m).map((x) => x.id)).toEqual(['mp4:ilst:covr:0']);
    expect(field(m, 'mp4:ilst:covr:0')?.value).toEqual(field(before, 'mp4:ilst:covr:0')?.value);
    expectSamePayload(keep, original, 'x.m4a');
    const drop = await bytesOf(await mp4Handler.strip!(Source.fromBytes(original, 'x.m4a'), strip()));
    expect(allFields(await reread(drop, 'x.m4a'))).toEqual([]);
  });

  it('keeps cover art when asked', async () => {
    const out = await mp4Handler.strip!(fixture('isobmff/audio.m4a'), strip({ keepCoverArt: true }));
    const bytes = await bytesOf(out);
    expect(has(bytes, MARKER)).toBe(false);
    expect(has(bytes, 'jane@example.com')).toBe(false);
    const et = await exiftool(bytes, 'x.m4a');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => k.startsWith('ItemList:'))).toEqual(['ItemList:CoverArt']);
    const m = await reread(bytes, 'x.m4a');
    expect(allFields(m).map((x) => x.id)).toEqual(['mp4:ilst:covr:0']);
  });
});

describe.runIf(hasFfmpeg)('mp4: timed-metadata tracks', () => {
  const variants: Array<[string, string, string[]]> = [
    ['tagged.mp4', 'gpmd', ['-movflags', '+faststart']], // index first: the moov shrinks, chunk offsets move
    ['iphone.mov', 'mebx', []], // QuickTime, index after the media
  ];
  for (const [base, entry, flags] of variants) {
    const name = `x.${base.split('.').pop()}`;

    it(`shows the ${entry} track of ${base} as removable location data`, async () => {
      const input = await withTelemetry(base, entry, flags);
      expect(has(input, TELEMETRY)).toBe(true);
      const m = await reread(input, name);
      const f = field(m, 'mp4:trak:3:timed')!;
      expect(f).toMatchObject({ kind: 'raw', removable: true, sensitivity: 'location', display: '3 samples' });
      expect(f.label).toMatch(entry === 'gpmd' ? /GoPro telemetry/ : /QuickTime metadata/);
      expect(m.info.find((i) => i.label === 'Timed metadata')).toBeDefined();
      expect(m.warnings.filter((w) => /kept/.test(w))).toEqual([]);
    });

    it(`strip drops the ${entry} track of ${base}, its references and its sample bytes`, async () => {
      const input = await withTelemetry(base, entry, flags);
      const bytes = await bytesOf(await mp4Handler.strip!(Source.fromBytes(input, name), strip()));
      for (const s of [MARKER, TELEMETRY, 'GoPro MET', 'libx264', 'FFMP', 'Handler']) expect(has(bytes, s)).toBe(false);
      // samples blanked in place: the media data keeps its size, only bytes of the telemetry samples changed
      const blanked = await blankedBytes(bytes, input);
      expect(blanked).toBeGreaterThan(2 * TELEMETRY.length);
      expect(blanked).toBeLessThanOrEqual(sampleBytes(trakByHandler(await moovOf(input), 'meta')));
      const moov = await moovOf(bytes);
      expect(childrenOf(moov, 'trak').map(trackId)).toEqual([1, 2]);
      const tref = child(trakByHandler(moov, 'vide'), 'tref')!;
      expect(tref.children!.map((c) => [c.type, Array.from(c.data!)])).toEqual([['cdep', Array.from(u32s(2))]]);
      if (name.endsWith('.mp4')) expect(child(moov, 'iods')?.data).toEqual(iods(1, 2).data);
      expect(await newProblems(bytes, input, name)).toEqual([]);
      expectSamePayload(bytes, fixtureBytes(`isobmff/${base}`), name);
      const m = await reread(bytes, name);
      expect(field(m, 'mp4:trak:3:timed')).toBeUndefined();
      expect(m.info.find((i) => i.label === 'Timed metadata')).toBeUndefined();
      expect(allFields(m).filter((x) => x.kind !== 'raw' || x.removable)).toEqual([]);
    });
  }

  it('write removes a single timed-metadata track and keeps the tags', async () => {
    const input = await withTelemetry('tagged.mp4', 'gpmd', ['-movflags', '+faststart']);
    const out = await mp4Handler.write!(Source.fromBytes(input, 'x.mp4'), edits({ 'mp4:trak:3:timed': REMOVE, 'mp4:ilst:©nam': 'Kept title' }));
    const bytes = await bytesOf(out);
    expect(has(bytes, TELEMETRY)).toBe(false);
    expect(await blankedBytes(bytes, input)).toBeGreaterThan(2 * TELEMETRY.length);
    const et = await exiftool(bytes, 'x.mp4');
    expect(await newProblems(bytes, input, 'x.mp4')).toEqual([]);
    expect(et['ItemList:Title']).toBe('Kept title');
    expect(et['ItemList:Artist']).toBe('Jane Doe');
    expectSamePayload(bytes, fixtureBytes('isobmff/tagged.mp4'), 'x.mp4');
    const m = await reread(bytes, 'x.mp4');
    expect(field(m, 'mp4:trak:3:timed')).toBeUndefined();
    expect(field(m, 'mp4:ilst:©cmt')?.value).toBe(MARKER);
    // the next free track id and the other tracks are untouched
    expect(childrenOf(await moovOf(bytes), 'trak').map(trackId)).toEqual([1, 2]);
  });

  it('keeps (and reports) the track of a fragmented file instead of breaking it', async () => {
    const input = await withTelemetry('tagged.mp4', 'gpmd', ['-movflags', 'frag_keyframe+empty_moov'], true);
    const m = await reread(input, 'x.mp4');
    expect(field(m, 'mp4:trak:3:timed')).toMatchObject({ removable: false, sensitivity: 'location' });
    expect(m.warnings.join('\n')).toMatch(/GoPro telemetry.*kept when removing metadata because the file is fragmented/);
    await expect(mp4Handler.write!(Source.fromBytes(input, 'x.mp4'), edits({ 'mp4:trak:3:timed': REMOVE }))).rejects.toThrow(/fragmented/);
    const bytes = await bytesOf(await mp4Handler.strip!(Source.fromBytes(input, 'x.mp4'), strip()));
    expect(await newProblems(bytes, input, 'x.mp4')).toEqual([]);
    expectSamePayload(bytes, input, 'x.mp4');
    const after = await reread(bytes, 'x.mp4');
    expect(field(after, 'mp4:trak:3:timed')).toMatchObject({ removable: false, sensitivity: 'location' });
    expect(after.warnings.join('\n')).toMatch(/kept when removing metadata/);
  });

  // A damaged index: the first telemetry chunk overlaps the mdat header, or the first video chunk.
  const corruptions: Array<[string, RegExp, (moov: BoxNode, mdatStart: number) => number]> = [
    ['point outside the media data', /outside the media data/, (_, mdat) => mdat],
    ['overlap another track', /overlap those of another track/, (moov) => new Reader(findPath(trakByHandler(moov, 'vide'), 'mdia/minf/stbl/stco')!.data!).u32(8)],
  ];
  for (const [what, msg, at] of corruptions) {
    it(`keeps the track when its samples ${what}`, async () => {
      const input = await withTelemetry('tagged.mp4', 'gpmd', ['-movflags', '+faststart'], true);
      const mdat = (await scanTopLevel(Source.fromBytes(input))).boxes.find((b) => b.type === 'mdat')!;
      const bad = await editMoov(
        input,
        (moov) => {
          const stco = findPath(trakByHandler(moov, 'meta'), 'mdia/minf/stbl/stco')!;
          stco.data = stco.data!.slice();
          new DataView(stco.data.buffer).setUint32(8, at(moov, mdat.start));
        },
        true,
      );
      const m = await reread(bad, 'x.mp4');
      expect(field(m, 'mp4:trak:3:timed')?.removable).toBe(false);
      expect(m.warnings.join('\n')).toMatch(msg);
      await expect(mp4Handler.write!(Source.fromBytes(bad, 'x.mp4'), edits({ 'mp4:trak:3:timed': REMOVE }))).rejects.toThrow(msg);
      const bytes = await bytesOf(await mp4Handler.strip!(Source.fromBytes(bad, 'x.mp4'), strip()));
      expect(childrenOf(await moovOf(bytes), 'trak').map(trackId)).toEqual([1, 2, 3]);
      expect(await blankedBytes(bytes, bad)).toBe(0);
      expect(field(await reread(bytes, 'x.mp4'), 'mp4:trak:3:timed')?.removable).toBe(false);
    });
  }
});
