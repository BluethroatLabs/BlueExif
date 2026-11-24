import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS, detectHandler, readMetadata } from './index';
import { FIXTURES, fixtureBytes } from './test/helpers';

/** Expected handler id per extension. */
// biome-ignore format: hand-packed table
const BY_EXT: Record<string, string> = {
  jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif',
  tif: 'tiff', tiff: 'tiff', dng: 'tiff', orf: 'tiff', cr2: 'tiff', nef: 'tiff', arw: 'tiff', rw2: 'tiff', pef: 'tiff',
  heic: 'heif', heif: 'heif', avif: 'heif', svg: 'svg', svgz: 'svg',
  mp3: 'mp3', flac: 'flac', ogg: 'ogg', opus: 'ogg', oga: 'ogg', wav: 'wav', aif: 'aiff', aiff: 'aiff', aifc: 'aiff',
  mp4: 'mp4', m4a: 'mp4', m4b: 'mp4', m4v: 'mp4', mov: 'mp4', '3gp': 'mp4',
  mkv: 'matroska', mka: 'matroska', mk3d: 'matroska', webm: 'matroska', avi: 'avi',
  pdf: 'pdf', docx: 'ooxml', docm: 'ooxml', xlsx: 'ooxml', xlsm: 'ooxml', pptx: 'ooxml', pptm: 'ooxml',
  odt: 'odf', ods: 'odf', odp: 'odf', odg: 'odf', epub: 'epub',
};

function allFixtures(): string[] {
  const out: string[] = [];
  for (const area of readdirSync(FIXTURES)) {
    const dir = join(FIXTURES, area);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (!f.startsWith('.')) out.push(`${area}/${f}`);
  }
  return out.sort();
}

const files = allFixtures().filter((f) => BY_EXT[f.split('.').pop()!.toLowerCase()]);

describe('registry', () => {
  it('has unique handler ids and covers every expected format', () => {
    const ids = HANDLERS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of new Set(Object.values(BY_EXT))) expect(ids).toContain(id);
  });

  it('found fixtures for every handler', () => {
    const covered = new Set(files.map((f) => BY_EXT[f.split('.').pop()!.toLowerCase()]));
    for (const h of HANDLERS) expect(covered, `no fixture for ${h.id}`).toContain(h.id);
  });

  for (const rel of files) {
    const expected = BY_EXT[rel.split('.').pop()!.toLowerCase()];
    it(`routes ${rel} → ${expected} (by name and by content)`, async () => {
      const blob = new Blob([fixtureBytes(rel) as BlobPart]);
      expect((await detectHandler(blob, rel.split('/').pop()!))?.id).toBe(expected);
      // Content sniffing must not depend on the extension. Raw MP3 streams
      // without an ID3 tag are the one format that legitimately needs it.
      const sniffed = (await detectHandler(blob, 'upload.bin'))?.id;
      if (expected !== 'mp3') expect(sniffed).toBe(expected);
    });

    it(`reads ${rel} or fails with a friendly error`, async () => {
      const blob = new Blob([fixtureBytes(rel) as BlobPart]);
      try {
        const m = await readMetadata(blob, rel.split('/').pop()!);
        expect(m.format.id).toBe(expected);
        expect(Array.isArray(m.groups)).toBe(true);
      } catch (e) {
        expect((e as Error).name, String(e)).toBe('MetadataError');
      }
    });
  }

  it('rejects unknown content', async () => {
    const blob = new Blob([new TextEncoder().encode('just some plain text, not a media file')]);
    expect(await detectHandler(blob, 'notes.txt')).toBeNull();
  });
});
