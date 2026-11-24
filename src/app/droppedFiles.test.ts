import { describe, expect, it } from 'vitest';
import { droppedFiles } from './droppedFiles';
import { UNREADABLE, fakeDrop, folderEntry } from './test/fakeDrop';

const EXTS = ['jpg', 'heic', 'mp4'];
const names = (files: File[]) => files.map((f) => f.name);

describe('droppedFiles', () => {
  it('opens the files in dropped folders, leaving out hidden and unsupported ones', async () => {
    const { dt } = fakeDrop({
      Trip: {
        'IMG_10.jpg': 'ten',
        'IMG_2.JPG': 'two',
        '.DS_Store': 'x',
        '.cache': { 'thumb.jpg': 'x' },
        'notes.txt': 'x',
        README: 'x',
        'day 2': { 'clip.mp4': 'clip', 'a.heic': 'a', empty: {} },
      },
      'loose.txt': 'kept',
    });
    const got = await droppedFiles(dt, EXTS);
    expect(names(got.files)).toEqual(['a.heic', 'clip.mp4', 'IMG_2.JPG', 'IMG_10.jpg', 'loose.txt']);
    expect(await got.files[3].text()).toBe('ten');
    expect(got).toMatchObject({ skipped: 2, truncated: false });
  });

  it('keeps every file dropped directly', async () => {
    const got = await droppedFiles(fakeDrop({ '.hidden.jpg': 'a', 'notes.txt': 'b' }).dt, EXTS);
    expect(names(got.files)).toEqual(['.hidden.jpg', 'notes.txt']);
    expect(got).toMatchObject({ skipped: 0, truncated: false });
  });

  it('keeps every file in a folder when the supported types are unknown', async () => {
    const { dt } = fakeDrop({ Docs: { 'a.txt': 'a', 'b.pdf': 'b' } });
    expect(names((await droppedFiles(dt, [])).files)).toEqual(['a.txt', 'b.pdf']);
  });

  it('takes the entries during the drop event', async () => {
    const drop = fakeDrop({ Trip: { 'a.jpg': 'a' }, 'b.jpg': 'b' });
    const walking = droppedFiles(drop.dt, EXTS);
    drop.end();
    expect(names((await walking).files)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('falls back to the dropped files without the entries API', async () => {
    const { dt } = fakeDrop({ 'a.jpg': 'a', 'b.txt': 'b' }, { entries: false });
    expect(names((await droppedFiles(dt, EXTS)).files)).toEqual(['a.jpg', 'b.txt']);
  });

  it('stops at the file limit', async () => {
    const tree = { Photos: { '1.jpg': '1', '2.jpg': '2', '3.jpg': '3', '4.jpg': '4', '5.jpg': '5' } };
    const cut = await droppedFiles(fakeDrop(tree).dt, EXTS, 3);
    expect(names(cut.files)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    expect(cut.truncated).toBe(true);
    expect((await droppedFiles(fakeDrop(tree).dt, EXTS, 5)).truncated).toBe(false);
  });

  it('skips files it cannot read', async () => {
    const { dt } = fakeDrop({ Trip: { 'a.jpg': 'a', 'gone.jpg': UNREADABLE } });
    expect(await droppedFiles(dt, EXTS)).toMatchObject({ files: [expect.any(File)], skipped: 1, truncated: false });
  });

  it('ends in a folder that contains itself', async () => {
    const inner = folderEntry('loop', {});
    const loop = {
      name: 'loop',
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let read = false;
        return {
          readEntries: (ok: (b: FileSystemEntry[]) => void) => setTimeout(() => ok(read ? [] : ((read = true), [loop as unknown as FileSystemEntry, inner]))),
        };
      },
    };
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => loop }], files: [] } as unknown as DataTransfer;
    expect(await droppedFiles(dt, EXTS, 2)).toMatchObject({ files: [], truncated: true });
  });
});
