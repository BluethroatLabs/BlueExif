import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Reader, concat, indexOfBytes, latin1 } from '../core/binary';
import { MetadataError, Source, groupKey, type Metadata } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etFind, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { aviHandler } from './avi';

const MARK = 'SECRET-MARKER-42';
const tmp = mkdtempSync(join(tmpdir(), 'blueexif-avi-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function save(bytes: Uint8Array): string {
  const p = join(tmp, `f${n++}.avi`);
  writeFileSync(p, bytes);
  return p;
}

interface Probe {
  format: { duration?: string; tags?: Record<string, string> };
  streams: Array<{ codec_name?: string; tags?: Record<string, string> }>;
}

function ffprobe(bytes: Uint8Array): Probe {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', save(bytes)], { encoding: 'utf8', timeout: 30_000 });
  expect(r.stderr).toBe('');
  return JSON.parse(r.stdout) as Probe;
}

function packets(bytes: Uint8Array): string {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=stream_index,pts,dts,size,flags,pos', '-of', 'csv', save(bytes)], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(r.stderr).toBe('');
  return r.stdout;
}

function decodeErrors(bytes: Uint8Array): string {
  const p = save(bytes);
  const full = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 });
  const seek = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', p, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 });
  return `${full.stderr}${seek.stderr}${full.status || seek.status ? 'exit status != 0' : ''}`;
}

/** Top-level chunks of the first RIFF: [fourcc or LIST type, offset, size]. */
function layout(b: Uint8Array): Array<[string, number, number]> {
  const r = new Reader(b, true);
  const out: Array<[string, number, number]> = [];
  const end = 8 + r.u32(4);
  expect(end).toBeLessThanOrEqual(b.length);
  let p = 12;
  while (p + 8 <= end) {
    const id = r.fourcc(p);
    const size = r.u32(p + 4);
    out.push([id === 'LIST' ? `LIST ${r.fourcc(p + 8)}` : id, p, size]);
    p += 8 + size + (size & 1);
  }
  expect(p).toBe(end);
  return out;
}

const pos = (b: Uint8Array, name: string) => layout(b).find(([id]) => id === name)?.[1];
const has = (bytes: Uint8Array, s: string) => indexOfBytes(bytes, s) >= 0;
const read = (b: Blob | Uint8Array): Promise<Metadata> => aviHandler.read(b instanceof Blob ? new Source(b, 'x.avi') : Source.fromBytes(b, 'x.avi'));
const UTF8 = ['-charset', 'riff=utf8'];

describe('avi', () => {
  it('detects and reads RIFF INFO and stream headers', async () => {
    const head = fixtureBytes('video/tagged.avi').subarray(0, 4096);
    expect(aviHandler.detect({ head, name: 'x', ext: '', size: head.length })).toBe(3);
    const m = await aviHandler.read(fixture('video/tagged.avi'));
    expect(m.format).toMatchObject({ id: 'avi', category: 'video', mime: 'video/x-msvideo' });
    expect(m.warnings).toEqual([]);
    const info = Object.fromEntries(m.info.map((i) => [i.label, i.value]));
    expect(info).toMatchObject({
      Dimensions: '64 × 48',
      'Frame rate': '10 fps',
      Frames: '10',
      Duration: '1.00 s',
      'Stream 0 (video)': 'Motion JPEG (MJPG)',
      'Stream 1 (audio)': 'PCM · 8000 Hz · 1 ch · 8-bit',
    });
    expect(field(m, 'avi:info:INAM')).toMatchObject({ value: `Clip ${MARK}`, label: 'Title', sensitivity: 'content' });
    expect(field(m, 'avi:info:IART')).toMatchObject({ value: `Jane ${MARK}`, sensitivity: 'identity' });
    expect(field(m, 'avi:info:ICMT')?.kind).toBe('multiline');
    expect(field(m, 'avi:info:ICRD')).toMatchObject({ kind: 'datetime', value: '2024-05-01' });
    expect(String(field(m, 'avi:info:ISFT')?.value)).toMatch(/^Lavf/);
    const g = m.groups.find((x) => x.id === 'avi.info')!;
    expect(g.removable).toBe(true);
    expect(g.addable?.map((a) => a.id)).toContain('avi:info:IKEY');
    expect(g.addable?.map((a) => a.id)).not.toContain('avi:info:INAM');
  });

  it('reads camera chunks: IDIT, strd, strn', async () => {
    const m = await aviHandler.read(fixture('video/camera.avi'));
    expect(m.warnings).toEqual([]);
    expect(field(m, 'avi:idit')).toMatchObject({ kind: 'datetime', value: '2023-05-01T10:20:30', sensitivity: 'time' });
    expect(field(m, 'avi:strd:0')).toMatchObject({ kind: 'raw', sensitivity: 'device', display: 'EXIF camera data, 49 B' });
    expect(field(m, 'avi:strn:1')?.display).toBe(`Audio ${MARK}`);
  });

  it('rewrites INFO in place when it fits (movi untouched)', async () => {
    const orig = fixtureBytes('video/tagged.avi');
    const out = await bytesOf(
      await aviHandler.write!(
        fixture('video/tagged.avi'),
        edits({ 'avi:info:INAM': 'Neuer Titel — ünïcödé', 'avi:info:ICMT': REMOVE, 'avi:info:IKEY': 'beach; summer', 'avi:info:ICRD': '2020-02-02' }),
      ),
    );
    expect(out.length).toBe(orig.length);
    expect(pos(out, 'LIST movi')).toBe(pos(orig, 'LIST movi'));
    const m = await read(out);
    expect(field(m, 'avi:info:INAM')?.value).toBe('Neuer Titel — ünïcödé');
    expect(field(m, 'avi:info:ICMT')).toBeUndefined();
    expect(field(m, 'avi:info:IKEY')?.value).toBe('beach; summer');
    expect(field(m, 'avi:info:IART')?.value).toBe(`Jane ${MARK}`);

    const et = await exiftool(out, 'o.avi', UTF8);
    expect(etProblems(et)).toEqual([]);
    expect(et['RIFF:Title']).toBe('Neuer Titel — ünïcödé');
    expect(et['RIFF:Keywords']).toBe('beach; summer');
    expect(et['RIFF:DateCreated']).toBe('2020:02:02');
    expect(et['RIFF:Comment']).toBeUndefined();
    const p = ffprobe(out);
    expect(p.format.tags?.title).toBe('Neuer Titel — ünïcödé');
    expect(p.format.tags?.comment).toBeUndefined();
    expect(p.format.duration).toBe(ffprobe(orig).format.duration);
    expect(packets(out)).toBe(packets(orig));
    expect(decodeErrors(out)).toBe('');
  });

  it('absorbs a 2–6 byte remainder into the last INFO value', async () => {
    const orig = fixtureBytes('video/tagged.avi');
    const top = layout(orig);
    const info = top.find(([id]) => id === 'LIST INFO')!;
    const junk = top[top.indexOf(info) + 1];
    expect(junk[0]).toBe('JUNK');
    const room = 8 + info[2] + 8 + junk[2];
    const icmt = `Holiday ${MARK}`.length + 1;
    const base = 8 + info[2] - (8 + icmt + (icmt & 1));
    const len = room - 4 - base - 8; // value length (even) that leaves 4 spare bytes
    const text = 'c'.repeat(len - 1);
    const out = await bytesOf(await aviHandler.write!(fixture('video/tagged.avi'), edits({ 'avi:info:ICMT': text })));
    expect(out.length).toBe(orig.length);
    const after = layout(out);
    expect(after.map(([id, p]) => [id, p])).toEqual(top.filter((c) => c !== junk).map(([id, p]) => [id, p]));
    expect(8 + after.find(([id]) => id === 'LIST INFO')![2]).toBe(room);
    const et = await exiftool(out, 't.avi');
    expect(etProblems(et)).toEqual([]);
    expect(et['RIFF:Comment']).toBe(text);
    expect(field(await read(out), 'avi:info:ICMT')?.value).toBe(text);
    expect(packets(out)).toBe(packets(orig));
  });

  it('inserts a large INFO after movi without moving it', async () => {
    const orig = fixtureBytes('video/tagged.avi');
    const long = `Long comment ${'x'.repeat(3000)}`;
    const out = await bytesOf(await aviHandler.write!(fixture('video/tagged.avi'), edits({ 'avi:info:ICMT': long })));
    expect(out.length).toBeGreaterThan(orig.length + 3000);
    expect(pos(out, 'LIST movi')).toBe(pos(orig, 'LIST movi'));
    const ids = layout(out).map(([id]) => id);
    expect(ids.slice(ids.indexOf('LIST movi'))).toEqual(['LIST movi', 'LIST INFO', 'idx1']);
    // the old slot is zero-filled JUNK now
    const slot = pos(orig, 'LIST INFO')!;
    expect(latin1(out.subarray(slot, slot + 4))).toBe('JUNK');
    expect(out.subarray(slot + 8, slot + 100).every((x) => x === 0)).toBe(true);

    const m = await read(out);
    expect(field(m, 'avi:info:ICMT')?.value).toBe(long);
    expect(field(m, 'avi:info:INAM')?.value).toBe(`Clip ${MARK}`);
    const et = await exiftool(out, 'o.avi');
    expect(etProblems(et)).toEqual([]);
    expect(et['RIFF:Comment']).toBe(long);
    expect(et['RIFF:Title']).toBe(`Clip ${MARK}`);
    expect(ffprobe(out).format.tags?.comment).toBe(long);
    expect(packets(out)).toBe(packets(orig));
    expect(decodeErrors(out)).toBe('');
  });

  it('adds INFO to a file without one, using JUNK space', async () => {
    const orig = fixtureBytes('video/bare.avi');
    expect(layout(orig).map(([id]) => id)).not.toContain('LIST INFO');
    const out = await bytesOf(await aviHandler.write!(fixture('video/bare.avi'), edits({ 'avi:info:INAM': 'Added title', 'avi:info:IART': 'Me' })));
    expect(out.length).toBe(orig.length);
    expect(pos(out, 'LIST movi')).toBe(pos(orig, 'LIST movi'));
    const et = await exiftool(out, 'b.avi');
    expect(etProblems(et)).toEqual([]);
    expect(et['RIFF:Title']).toBe('Added title');
    expect(et['RIFF:Artist']).toBe('Me');
    expect(ffprobe(out).format.tags?.title).toBe('Added title');
    expect(packets(out)).toBe(packets(orig));
  });

  it('edits and removes IDIT in place; removes groups', async () => {
    const orig = fixtureBytes('video/camera.avi');
    const out = await bytesOf(
      await aviHandler.write!(fixture('video/camera.avi'), edits({ 'avi:idit': '2019-12-31T23:59:58', [groupKey('avi.info')]: REMOVE })),
    );
    expect(out.length).toBe(orig.length);
    const m = await read(out);
    expect(field(m, 'avi:idit')?.value).toBe('2019-12-31T23:59:58');
    expect(m.groups.find((g) => g.id === 'avi.info')?.fields).toEqual([]);
    const et = await exiftool(out, 'c.avi');
    expect(etProblems(et)).toEqual([]);
    expect(et['RIFF:DateTimeOriginal']).toBe('2019:12:31 23:59:58');
    expect(etFind(et, 'Title')).toEqual([]);
    expect(etFind(et, 'Software')).toEqual([]);
    expect(has(out, 'Tue Dec 31 23:59:58 2019\n')).toBe(true);
    expect(packets(out)).toBe(packets(orig));

    const gone = await bytesOf(await aviHandler.write!(fixture('video/camera.avi'), edits({ 'avi:idit': REMOVE, 'avi:strd:0': REMOVE, 'avi:strn:1': REMOVE })));
    const et2 = await exiftool(gone, 'g.avi');
    expect(etProblems(et2)).toEqual([]);
    expect(et2['RIFF:DateTimeOriginal']).toBeUndefined();
    expect(et2['IFD0:Make']).toBeUndefined();
    expect(et2['RIFF:StreamName']).toBeUndefined();
    expect(et2['RIFF:Title']).toBe(`Clip ${MARK}`);
    expect(decodeErrors(gone)).toBe('');
  });

  it('strips INFO, IDIT, strd and strn into zero-filled JUNK', async () => {
    const orig = fixtureBytes('video/camera.avi');
    expect(has(orig, MARK)).toBe(true);
    const out = await bytesOf(await aviHandler.strip!(fixture('video/camera.avi'), strip()));
    expect(out.length).toBe(orig.length);
    expect(has(out, MARK)).toBe(false);
    expect(has(out, 'Lavf')).toBe(false);
    expect(layout(out).map(([id, p]) => [id === 'LIST INFO' ? 'JUNK' : id, p])).toEqual(layout(orig).map(([id, p]) => [id === 'LIST INFO' ? 'JUNK' : id, p]));

    const et = await exiftool(out, 's.avi');
    expect(etProblems(et)).toEqual([]);
    const meta = Object.keys(et).filter((k) => /^(RIFF|IFD0):/.test(k));
    for (const k of ['Title', 'Artist', 'Comment', 'Software', 'DateTimeOriginal', 'Make', 'StreamName', 'DateCreated']) {
      expect(meta.filter((x) => x.endsWith(`:${k}`))).toEqual([]);
    }
    const m = await read(out);
    expect(allFields(m)).toEqual([]);
    const p = ffprobe(out);
    expect(p.format.tags ?? {}).toEqual({});
    expect(p.streams.every((s) => !s.tags || Object.keys(s.tags).length === 0)).toBe(true);
    expect(packets(out)).toBe(packets(orig));
    expect(decodeErrors(out)).toBe('');
  });

  it('handles OpenDML AVIX parts: in-place edits only', async () => {
    const base = fixtureBytes('video/tagged.avi');
    const movi = new Uint8Array(
      [...'LIST']
        .map((c) => c.charCodeAt(0))
        .concat(
          [4, 0, 0, 0],
          [...'movi'].map((c) => c.charCodeAt(0)),
        ),
    );
    const avix = new Uint8Array(12);
    avix.set([...'RIFF'].map((c) => c.charCodeAt(0)));
    new DataView(avix.buffer).setUint32(4, 4 + movi.length, true);
    avix.set(
      [...'AVIX'].map((c) => c.charCodeAt(0)),
      8,
    );
    const b = concat([base, avix, movi]);
    const m = await read(b);
    expect(m.info.find((i) => i.label === 'OpenDML')?.value).toBe('Yes, 2 RIFF parts');
    expect(field(m, 'avi:info:INAM')?.value).toBe(`Clip ${MARK}`);

    const small = await bytesOf(await aviHandler.write!(Source.fromBytes(b, 'x.avi'), edits({ 'avi:info:INAM': 'short' })));
    expect(small.length).toBe(b.length);
    expect(field(await read(small), 'avi:info:INAM')?.value).toBe('short');
    await expect(aviHandler.write!(Source.fromBytes(b, 'x.avi'), edits({ 'avi:info:ICMT': 'y'.repeat(5000) }))).rejects.toThrow(MetadataError);
    const s = await bytesOf(await aviHandler.strip!(Source.fromBytes(b, 'x.avi'), strip()));
    expect(s.length).toBe(b.length);
    expect(has(s, MARK)).toBe(false);
  });
});

describe('avi: hostile nesting', () => {
  it('reads 50,000 nested LIST chunks without overflowing the stack', async () => {
    const base = fixtureBytes('video/bare.avi');
    const D = 50_000;
    const deep = new Uint8Array(D * 12);
    const v = new DataView(deep.buffer);
    for (let k = 0; k < D; k++) {
      deep.set([0x4c, 0x49, 0x53, 0x54], k * 12); // LIST
      v.setUint32(k * 12 + 4, 4 + (D - 1 - k) * 12, true);
      deep.set([0x64, 0x65, 0x65, 0x70], k * 12 + 8); // deep
    }
    const file = concat([base, deep]);
    new DataView(file.buffer).setUint32(4, file.length - 8, true);
    const m = await aviHandler.read(Source.fromBytes(file, 'deep.avi'));
    expect(m.format.id).toBe('avi');
  });
});
