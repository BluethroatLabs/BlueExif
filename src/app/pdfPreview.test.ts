/**
 * PDF page previews: the locked-down pdf.js options open and render every PDF
 * fixture (pdf.js runs in-process here, like the single-file build), never ask
 * for anything over the network, and honour passwords.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fixtureBytes } from '../engine/test/helpers';
import { documentOptions, fitPage, isBlank } from './pdfPreview';

interface NodeCanvas {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

/** Page 1 rendered into a 176×132 box; resolves to its RGBA pixels. */
async function renderFirstPage(name: string, password?: string): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
  const task = pdfjs.getDocument({ ...documentOptions(pdfjs), data: fixtureBytes(`documents/${name}`).slice(), password });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const size = fitPage(base.width, base.height, 176, 132)!;
    const { canvas, context } = (doc.canvasFactory as { create(w: number, h: number): NodeCanvas }).create(size.width, size.height);
    await page.render({ canvas, viewport: page.getViewport({ scale: size.scale }), annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    return { width: size.width, height: size.height, pixels: context.getImageData(0, 0, size.width, size.height).data };
  } finally {
    await task.destroy();
  }
}

/** pdf.js PasswordException code, or 'opened'. */
async function openWith(password?: string): Promise<number | 'opened'> {
  const task = pdfjs.getDocument({ ...documentOptions(pdfjs), data: fixtureBytes('documents/encrypted.pdf').slice(), password });
  try {
    await task.promise;
    return 'opened';
  } catch (e) {
    if (e instanceof pdfjs.PasswordException) return e.code as number;
    throw e;
  } finally {
    await task.destroy();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pdf preview', () => {
  it('fits pages into the box', () => {
    // A4 portrait into the 176×132 header box: height-bound
    expect(fitPage(595, 842, 176, 132)).toEqual({ scale: 132 / 842, width: 93, height: 132 });
    // landscape: width-bound
    expect(fitPage(842, 595, 176, 132)).toMatchObject({ width: 176, height: 124 });
    // device pixels (×2) never exceed the box
    const f = fitPage(612, 792, 352, 264)!;
    expect(f.width).toBeLessThanOrEqual(352);
    expect(f.height).toBeLessThanOrEqual(264);
    expect(fitPage(1, 100_000, 40, 40)).toMatchObject({ width: 1, height: 40 });
    expect(fitPage(0, 842, 176, 132)).toBeNull();
    expect(fitPage(595, 842, 0, 132)).toBeNull();
    expect(fitPage(Number.NaN, 842, 176, 132)).toBeNull();
  });

  it('detects blank renders', () => {
    const white = new Uint8ClampedArray(4 * 16).fill(255);
    expect(isBlank(white)).toBe(true);
    const marked = white.slice();
    marked[4 * 9 + 2] = 120;
    expect(isBlank(marked)).toBe(false);
  });

  it('is locked down: no eval, XFA, network or wasm', async () => {
    const opts = documentOptions(pdfjs);
    expect(opts).toMatchObject({ isEvalSupported: false, enableXfa: false, useWorkerFetch: false, useWasm: false });
    for (const url of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl', 'url'] as const) expect(opts[url]).toBeUndefined();
    const Factory = opts.BinaryDataFactory as new () => { fetch(req: { kind: string; filename: string }): Promise<Uint8Array> };
    await expect(new Factory().fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSans.pfb' })).rejects.toThrow();
  });

  it.each(['report.pdf', 'quartz.pdf', 'objstm.pdf'])('renders page 1 of %s without fetching anything', async (name) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { width, height, pixels } = await renderFirstPage(name);
    expect(Math.max(width, height)).toBeGreaterThan(100);
    expect(width).toBeLessThanOrEqual(176);
    expect(height).toBeLessThanOrEqual(132);
    expect(isBlank(pixels)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('opens encrypted PDFs only with a password', async () => {
    expect(await openWith()).toBe(pdfjs.PasswordResponses.NEED_PASSWORD);
    expect(await openWith('wrong')).toBe(pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    expect(await openWith('user')).toBe('opened');
    expect(await openWith('owner')).toBe('opened');
    expect(isBlank((await renderFirstPage('encrypted.pdf', 'user')).pixels)).toBe(false);
  });
});
