/** Store actions against a fake engine whose replies the tests release one by one. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import type { Metadata } from '../engine/core/types';
import type { FormatSummary } from './engineClient';
import { fakeDrop } from './test/fakeDrop';

const { engine, calls, formats, EngineError } = vi.hoisted(() => {
  interface Call {
    op: 'read' | 'write' | 'strip';
    blob: Blob;
    password?: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }
  const calls: Call[] = [];
  const formats: FormatSummary[] = [];
  const call =
    (op: Call['op']) =>
    (blob: Blob, _name: string, ...rest: unknown[]) =>
      new Promise((resolve, reject) => calls.push({ op, blob, password: rest[rest.length - 1] as string | undefined, resolve, reject }));
  class EngineError extends Error {
    constructor(
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  }
  return { calls, formats, EngineError, engine: { formats: async () => formats, read: call('read'), write: call('write'), strip: call('strip') } };
});

vi.mock('./engineClient', () => ({ engine, EngineError }));

const meta = (version: string): Metadata => ({
  format: { id: 'pdf', name: 'PDF', mime: 'application/pdf', category: 'document' },
  info: [{ label: 'Version', value: version }],
  groups: [],
  warnings: [],
  canWrite: true,
  canStrip: true,
});
const version = (m?: Metadata) => m?.info[0].value;
const settle = () => new Promise((r) => setTimeout(r, 0));
const next = async (op: 'read' | 'write' | 'strip') => {
  await settle();
  const i = calls.findIndex((c) => c.op === op);
  expect(i, `a pending ${op}`).toBeGreaterThanOrEqual(0);
  return calls.splice(i, 1)[0];
};

let store: typeof import('./store');
beforeEach(async () => {
  calls.length = 0;
  formats.length = 0;
  vi.resetModules();
  store = await import('./store');
});
afterEach(() => vi.unstubAllGlobals());

/** Add a file and finish reading it as `v1`. */
async function opened(name = 'doc.pdf', body = 'v1') {
  const done = store.addFiles([new File([body], name)]);
  (await next('read')).resolve(meta(body));
  await done;
  return store.getState().files.find((f) => f.name === name && f.original.size === body.length)!;
}

/** Strip the file once, the result reading as `v2`. */
async function stripped(id: string) {
  const done = store.stripFiles([id]);
  (await next('strip')).resolve(new Blob(['v2']));
  (await next('read')).resolve(meta('v2'));
  await done;
}

describe('store', () => {
  it('ignores a read that finishes after a newer one', async () => {
    const done = store.addFiles([new File(['x'], 'locked.pdf')]);
    (await next('read')).reject(new EngineError('This PDF needs a password', 'password-required'));
    await done;
    const id = store.getState().files[0].id;
    void store.unlock(id, 'wrong');
    const first = await next('read');
    void store.unlock(id, 'right');
    const second = await next('read');
    expect([first.password, second.password]).toEqual(['wrong', 'right']);
    second.resolve(meta('unlocked'));
    await settle();
    first.reject(new EngineError('Wrong password', 'wrong-password'));
    await settle();
    expect(store.fileById(id)).toMatchObject({ status: 'ready', error: undefined });
    expect(version(store.fileById(id)!.meta)).toBe('unlocked');
  });

  it('holds back changes while an older version is read again', async () => {
    const f = await opened();
    await stripped(f.id);
    expect(store.fileById(f.id)!.history).toHaveLength(1);

    store.undo(f.id);
    const reread = await next('read');
    expect(store.fileById(f.id)!).toMatchObject({ status: 'reading', current: f.original });
    expect(store.isBusy(store.fileById(f.id)!)).toBe(true);

    store.setEdit(f.id, 'pdf:title', { op: 'set', value: 'New' });
    const saved = store.applyEdits(f.id);
    const strip = store.stripFiles([f.id]);
    store.revert(f.id);
    await settle();
    expect(calls).toEqual([]); // no write, strip or second read started
    expect(await saved).toBe(false);
    await strip;

    reread.resolve(meta('v1'));
    await settle();
    const now = store.fileById(f.id)!;
    expect(now).toMatchObject({ status: 'ready', current: f.original });
    expect(version(now.meta)).toBe('v1');
  });

  it('drops the result of a read for a file that was removed', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL: vi.fn() }));
    const done = store.addFiles([new File(['x'], 'photo.jpg')]);
    const read = await next('read');
    store.removeFile(store.getState().files[0].id);
    read.resolve({ ...meta('v1'), format: { id: 'jpeg', name: 'JPEG', mime: 'image/jpeg', category: 'image' } });
    await done;
    expect(store.getState().files).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('downloads every current version in one archive without reading them whole', async () => {
    const a = await opened('notes.pdf', 'v1');
    await stripped(a.id);
    await opened('notes.pdf', 'other');
    const video = new Uint8Array(9 << 20).fill(7);
    const adding = store.addFiles([new File([video], 'clip.mp4')]);
    (await next('read')).resolve(meta('clip'));
    await adding;
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    let zip: Blob | undefined;
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: (b: Blob) => ((zip = b), 'blob:zip'), revokeObjectURL: vi.fn() }));
    vi.stubGlobal('document', {
      createElement: () => ({ click: vi.fn(), remove: vi.fn() }),
      body: { appendChild: vi.fn() },
    });
    await store.downloadAll();
    // Only slices are read (for the CRCs): every arrayBuffer call is on a chunk-sized Blob.
    expect(read.mock.contexts.every((b) => (b as Blob).size <= 4 << 20)).toBe(true);
    read.mockRestore();
    const { 'clip.mp4': clip, ...files } = unzipSync(new Uint8Array(await zip!.arrayBuffer()));
    expect(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString()]))).toEqual({ 'notes.pdf': 'v2', 'notes (2).pdf': 'other' });
    expect(Buffer.from(clip).equals(Buffer.from(video))).toBe(true);
    expect(store.getState().files.map(store.hasUnsavedWork)).toEqual([false, false, false]);
  });

  it('opens the supported files of a dropped folder and says how many it skipped', async () => {
    formats.push({ id: 'pdf', name: 'PDF', category: 'document', extensions: ['pdf'], canWrite: true, canStrip: true });
    await store.loadFormats();
    const done = store.addDropped(fakeDrop({ Docs: { 'a.pdf': 'a', 'b.txt': 'b', 'c.pdf': 'c' } }).dt);
    await vi.waitFor(() => expect(calls).toHaveLength(2)); // once the folder has been walked
    (await next('read')).resolve(meta('a'));
    (await next('read')).resolve(meta('c'));
    await done;
    expect(store.getState().files.map((f) => f.name)).toEqual(['a.pdf', 'c.pdf']);
    expect(store.getState().toasts).toMatchObject([{ kind: 'info', text: 'Skipped 1 file BlueExif can’t open' }]);
  });

  it('says so when a dropped folder has nothing to open', async () => {
    await store.addDropped(fakeDrop({ Empty: { '.DS_Store': 'x' } }).dt);
    expect(store.getState().files).toEqual([]);
    expect(store.getState().toasts).toMatchObject([{ kind: 'error', text: 'No files BlueExif can open were found' }]);
  });
});
