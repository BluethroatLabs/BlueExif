import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { equalBytes } from '../core/binary';
import { Source, groupKey } from '../core/types';
import { ZipArchive, rewriteZip } from '../core/zip';
import { REMOVE, bytesOf, edits, fixtureBytes, strip } from '../test/helpers';
import { applyMediaEdits, cleanMedia, mediaGroup, type MediaSpec } from './docmedia';
import { XmlParts } from './docparts';
import { cleanEmbedded, inspectEmbedded } from './embedded';
import { parseJpeg } from './jpeg';

const SPEC: MediaSpec = { group: 'x.media', prefix: 'x:media:', source: 'Test' };
const CAMERA = fixtureBytes('jpeg/camera.jpg');

async function open(files: Record<string, Uint8Array>): Promise<XmlParts> {
  return new XmlParts(await ZipArchive.open(Source.fromBytes(zipSync(files), 'p.zip')));
}

async function finish(parts: XmlParts): Promise<Record<string, Uint8Array>> {
  return unzipSync(await bytesOf(await rewriteZip(parts.zip, parts.finish())));
}

const scan = (b: Uint8Array) => {
  const j = parseJpeg(b);
  return b.subarray(j.scanStart, j.scanEnd);
};

describe('docmedia', () => {
  it('lists pictures that reveal something and cleans them in place', async () => {
    const clean = (await cleanEmbedded(CAMERA, 'clean.jpg', strip()))!;
    const files = { 'media/a.jpg': CAMERA, 'media/plain.jpg': clean, 'notes.txt': strToU8('not a picture') };
    const parts = await open(files);
    const warnings: string[] = [];
    const g = await mediaGroup(parts, ['media/a.jpg', 'media/plain.jpg', 'notes.txt', 'missing.png'], SPEC, warnings);
    expect(warnings).toEqual([]);
    expect(g).toMatchObject({ id: 'x.media', label: 'Embedded images', source: 'Test', removable: true });
    expect(g!.fields.map((f) => f.id)).toEqual(['x:media:media/a.jpg']);
    expect(g!.fields[0]).toMatchObject({ label: 'a.jpg', kind: 'raw', sensitivity: 'location', removable: true, tag: 'media/a.jpg' });
    expect(g!.fields[0].display).toMatch(/^media\/a\.jpg · JPEG image · location, people, device/);

    await cleanMedia(parts, ['media/a.jpg', 'media/plain.jpg', 'notes.txt'], strip());
    const out = await finish(parts);
    expect(await inspectEmbedded(out['media/a.jpg'], 'a.jpg')).toBeNull();
    expect(equalBytes(scan(out['media/a.jpg']), scan(CAMERA))).toBe(true);
    expect(out['notes.txt']).toEqual(files['notes.txt']);
    expect(out['media/plain.jpg']).toEqual(clean); // nothing to change
    expect(await mediaGroup(await open(out), ['media/a.jpg'], SPEC, [])).toBeNull();
  });

  it('cleans only the pictures whose field (or group) was removed', async () => {
    const files = { 'a.jpg': CAMERA, 'b.jpg': CAMERA };
    const one = await open(files);
    await applyMediaEdits(one, ['a.jpg', 'b.jpg'], SPEC, edits({ 'x:media:a.jpg': REMOVE, 'x:media:b.jpg': 'ignored' }));
    const out = await finish(one);
    expect(await inspectEmbedded(out['a.jpg'], 'a.jpg')).toBeNull();
    expect(out['b.jpg']).toEqual(CAMERA);

    const all = await open(files);
    await applyMediaEdits(all, ['a.jpg', 'b.jpg'], SPEC, edits({ [groupKey('x.media')]: REMOVE }));
    const out2 = await finish(all);
    expect(await inspectEmbedded(out2['a.jpg'], 'a.jpg')).toBeNull();
    expect(await inspectEmbedded(out2['b.jpg'], 'b.jpg')).toBeNull();
    // edit cleaning keeps the orientation the way a default strip does
    const kept = parseJpeg(out2['a.jpg']).segments.map((s) => s.kind);
    expect(kept).toContain('exif');
  });

  it('fails, naming the picture, when a picture cannot be cleaned', async () => {
    const parts = await open({ 'word/media/bad.jpeg': CAMERA.slice(0, 200) });
    await expect(cleanMedia(parts, ['word/media/bad.jpeg'], strip())).rejects.toThrow(/picture word\/media\/bad\.jpeg cannot be cleaned/);
  });
});
