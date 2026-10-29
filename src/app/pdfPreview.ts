/**
 * First-page previews for PDFs. pdf.js is imported the first time a PDF is
 * shown; it paints page 1 onto a canvas sized to the preview box × device
 * pixel ratio, and the result is handed out as a PNG object URL.
 *
 * Hosted build: pdf.js parses in its own Web Worker (pdfPreview.worker.ts).
 * Single-file build: vite.config.ts aliases './pdfPreview.worker' to
 * pdfPreview.worker.single.ts, which runs the pdf.js parser on the page.
 *
 * Locked down for untrusted files: no annotation layer, AcroForm widgets,
 * scripting or XFA. Annotations that carry an appearance stream (stamps, filled
 * fields, signatures) are painted onto the canvas like a print preview; nothing
 * else of the document reaches the DOM. pdf.js never fetches anything — no
 * CMaps, standard fonts, ICC profiles or WebAssembly decoders — so a preview can
 * degrade: non-embedded fonts fall back to system fonts (Symbol/ZapfDingbats
 * glyphs and CJK text that needs a predefined CMap can be missing), JPEG 2000,
 * JBIG2 and CCITT fax images are left out, and ICC-based colours use their
 * alternate colour space. A page that comes out blank (typically a scan made of
 * such images) shows the document icon instead.
 */

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFWorker, RenderTask } from 'pdfjs-dist';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

/** pdf.js's legacy build: the modern one needs very recent JS (Promise.try, Map#getOrInsertComputed, Math.sumPrecise…). */
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** A render that takes longer than this gives up (the icon stays). */
const RENDER_TIMEOUT_MS = 10_000;
/** Renders running at once; the rest queue, the file header's preview first. */
const MAX_PARALLEL = 2;
/** Stop the shared pdf.js worker after this long without work. */
const WORKER_IDLE_MS = 30_000;
/** Embedded images larger than this (pixels) are skipped instead of decoded. */
const MAX_IMAGE_PIXELS = 1 << 26;
/** Larger files get no preview (pdf.js needs its own copy of the bytes). */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_DPR = 3;

/** Refuses every CMap, standard font and wasm request, so pdf.js never fetches. */
class NoBinaryData {
  fetch(): Promise<never> {
    return Promise.reject(new Error('not bundled'));
  }
}

/** getDocument() options for untrusted files: no code, no network, no forms. */
export function documentOptions(lib: PdfJs): DocumentInitParameters & { isEvalSupported: boolean } {
  return {
    // pdf.js 6 never evaluates code; this keeps an older build from doing so.
    isEvalSupported: false,
    enableXfa: false,
    useWorkerFetch: false,
    BinaryDataFactory: NoBinaryData,
    useWasm: false,
    maxImageSize: MAX_IMAGE_PIXELS,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: lib.VerbosityLevel.ERRORS,
  };
}

/** A page of pageW×pageH fitted into a box (same units), or null for a degenerate page. */
export function fitPage(pageW: number, pageH: number, boxW: number, boxH: number): { scale: number; width: number; height: number } | null {
  if (!(pageW > 0 && pageH > 0 && boxW > 0 && boxH > 0)) return null;
  const scale = Math.min(boxW / pageW, boxH / pageH);
  if (!Number.isFinite(scale)) return null;
  return { scale, width: Math.max(1, Math.round(pageW * scale)), height: Math.max(1, Math.round(pageH * scale)) };
}

/** True when every RGBA pixel is (nearly) white: nothing on the page could be drawn. */
export function isBlank(rgba: Uint8ClampedArray): boolean {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] < 250 || rgba[i + 1] < 250 || rgba[i + 2] < 250) return false;
  }
  return true;
}

// ---------------------------------------------------------------- runtime

interface Runtime {
  lib: PdfJs;
  /** hosted build: renders share one real worker thread */
  shareWorker: boolean;
}

let runtime: Promise<Runtime> | undefined;

function loadRuntime(): Promise<Runtime> {
  if (!runtime) {
    const loading = Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('./pdfPreview.worker')]).then(([lib, setup]) => ({
      lib,
      shareWorker: setup.preparePdfWorker(lib),
    }));
    // A chunk that failed to load (e.g. offline before it was cached) may load later.
    loading.catch(() => {
      if (runtime === loading) runtime = undefined;
    });
    runtime = loading;
  }
  return runtime;
}

let worker: PDFWorker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function sharedWorker(lib: PdfJs): PDFWorker {
  clearTimeout(idleTimer);
  if (!worker || worker.destroyed) worker = new lib.PDFWorker({ verbosity: lib.VerbosityLevel.ERRORS });
  return worker;
}

function stopWorkerWhenIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    worker?.destroy();
    worker = undefined;
  }, WORKER_IDLE_MS);
}

const quietly = (p: Promise<unknown> | undefined) => p?.catch(() => {});

/**
 * Calls `fire` once the page has been visible for `ms` in total. pdf.js paints
 * in animation frames, which stop while the tab is hidden, so hidden time must
 * not count. Returns a function that cancels it.
 */
function visibleTimeout(ms: number, fire: () => void): () => void {
  let left = ms;
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (document.hidden) {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      left -= performance.now() - since;
    } else if (timer === undefined) {
      since = performance.now();
      timer = setTimeout(fire, Math.max(0, left));
    }
  };
  update();
  document.addEventListener('visibilitychange', update);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', update);
  };
}

// ----------------------------------------------------------------- render

/** Page 1 as a PNG, `width`×`height` device pixels. */
export interface PdfPageImage {
  png: Blob;
  width: number;
  height: number;
}

interface Render {
  file: Blob;
  password?: string;
  /** box the page is fitted into, in device pixels */
  boxW: number;
  boxH: number;
  high: boolean;
  /** callers still waiting for the result */
  users: number;
  done: boolean;
  /** gave up after RENDER_TIMEOUT_MS: not kept, so showing the file again retries */
  timedOut?: boolean;
  ctrl: AbortController;
  result: Promise<PdfPageImage | null>;
}

/** Running and finished renders per file version. Failed ones are kept (not retried), timed-out ones are not. */
const renders = new WeakMap<Blob, Render[]>();
const waiting: Array<{ render: Render; resolve: (img: PdfPageImage | null) => void }> = [];
let running = 0;

function forget(render: Render): void {
  const list = renders.get(render.file);
  const i = list?.indexOf(render) ?? -1;
  if (i >= 0) list!.splice(i, 1);
}

function pump(): void {
  while (running < MAX_PARALLEL && waiting.length) {
    const [{ render, resolve }] = waiting.splice(Math.max(0, waiting.findIndex((w) => w.render.high)), 1);
    if (render.ctrl.signal.aborted) {
      resolve(null);
      continue;
    }
    running++;
    draw(render)
      .then(
        (img) => {
          if (render.timedOut) forget(render);
          resolve(img);
        },
        () => {
          forget(render); // pdf.js itself could not be loaded: try again next time
          resolve(null);
        },
      )
      .finally(() => {
        running--;
        pump();
        if (!running && !waiting.length) stopWorkerWhenIdle();
      });
  }
}

/** Renders page 1; null when the file cannot be rendered (in time). Throws only if pdf.js cannot be loaded. */
async function draw(render: Render): Promise<PdfPageImage | null> {
  const { file, password, boxW, boxH, ctrl } = render;
  if (file.size > MAX_FILE_BYTES) return null;
  const { lib, shareWorker } = await loadRuntime();
  let task: PDFDocumentLoadingTask | undefined;
  let renderTask: RenderTask | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    renderTask?.cancel();
    void quietly(task?.destroy());
  };
  const cancelTimeout = visibleTimeout(RENDER_TIMEOUT_MS, () => {
    render.timedOut = true;
    stop();
  });
  ctrl.signal.addEventListener('abort', stop, { once: true });
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    if (stopped || ctrl.signal.aborted) return null;
    task = lib.getDocument({ ...documentOptions(lib), data, password, worker: shareWorker ? sharedWorker(lib) : undefined });
    const page = await (await task.promise).getPage(1);
    const base = page.getViewport({ scale: 1 }); // honours the crop box and /Rotate
    const size = fitPage(base.width, base.height, boxW, boxH);
    if (!size || stopped) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    renderTask = page.render({ canvas, viewport: page.getViewport({ scale: size.scale }), annotationMode: lib.AnnotationMode.ENABLE });
    await renderTask.promise;
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, size.width, size.height).data;
    const png = stopped || !pixels || isBlank(pixels) ? null : await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
    canvas.width = canvas.height = 0;
    return png && !stopped ? { png, width: size.width, height: size.height } : null;
  } catch {
    return null; // damaged, encrypted without the right password, cancelled…
  } finally {
    cancelTimeout();
    ctrl.signal.removeEventListener('abort', stop);
    await quietly(task?.destroy());
  }
}

export interface PdfPageRequest {
  password?: string;
  /** box to fit the page into, in device pixels */
  width: number;
  height: number;
  /** jump the queue (the selected file's header preview) */
  high?: boolean;
  signal: AbortSignal;
}

/**
 * Page 1 of `file` fitted into the requested box, or null when it cannot be
 * rendered or `signal` aborts first. Callers asking for the same file version
 * share one render; one made for a larger box is reused for smaller ones.
 */
export function renderPdfPage(file: Blob, req: PdfPageRequest): Promise<PdfPageImage | null> {
  const { password, width, height, signal } = req;
  if (signal.aborted) return Promise.resolve(null);
  let list = renders.get(file);
  if (!list) renders.set(file, (list = []));
  let render = list.find((r) => r.password === password && r.boxW >= width && r.boxH >= height);
  if (!render) {
    const r: Render = { file, password, boxW: width, boxH: height, high: false, users: 0, done: false, ctrl: new AbortController(), result: Promise.resolve(null) };
    r.result = new Promise<PdfPageImage | null>((resolve) => waiting.push({ render: r, resolve })).then((img) => {
      r.done = true;
      return img;
    });
    list.push(r);
    render = r;
    queueMicrotask(pump);
  }
  const r = render;
  r.high ||= !!req.high;
  r.users++;
  return new Promise((resolve) => {
    const leave = () => {
      if (--r.users === 0 && !r.done) {
        r.ctrl.abort();
        forget(r);
      }
      resolve(null);
    };
    signal.addEventListener('abort', leave, { once: true });
    void r.result.then((img) => {
      signal.removeEventListener('abort', leave);
      resolve(img);
    });
  });
}

// ------------------------------------------------------------------- hook

/** What the preview needs from a file entry. */
export interface PdfSource {
  id: string;
  /** the current version: a new blob (after Save/Strip/Undo) renders again */
  current: Blob;
  password?: string;
}

/** A rendered page, sized in CSS pixels to fit the measured box. */
export interface PdfPagePreview {
  url: string;
  width: number;
  height: number;
}

interface Shown {
  id: string;
  url: string;
  width: number;
  height: number;
}

/**
 * Page 1 of `file`, fitted into the element `ref` is attached to. `page` is
 * undefined while rendering and when rendering fails or times out — show the
 * icon then. A new version of the same file keeps the previous page on screen
 * until the new one is ready; object URLs are revoked when replaced/unmounted.
 */
export function usePdfPage(file: PdfSource | null, high = false): { ref: (el: HTMLElement | null) => void; page?: PdfPagePreview } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  /** content box in CSS px */
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  /** render size in device px: grows with the box, never shrinks */
  const [want, setWant] = useState<{ w: number; h: number } | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const urlRef = useRef<string | null>(null);

  const show = (next: Shown | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next?.url ?? null;
    setShown(next);
  };

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const active = !!file;
  useEffect(() => {
    if (!el || !active) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const height = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (!(width >= 1 && height >= 1)) return; // hidden
      setBox((cur) => (cur && cur.w === width && cur.h === height ? cur : { w: width, h: height }));
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DPR);
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      setWant((cur) => (cur && w <= cur.w * 1.1 && h <= cur.h * 1.1 ? cur : { w: Math.max(w, cur?.w ?? 0), h: Math.max(h, cur?.h ?? 0) }));
    };
    // Measure now: ResizeObserver only reports once the page renders a frame,
    // which a background tab never does.
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, active]);

  const id = file?.id;
  const blob = file?.current;
  const password = file?.password;
  useEffect(() => {
    if (!id || !blob) {
      if (urlRef.current) show(null);
      return;
    }
    if (!want) return;
    const ctrl = new AbortController();
    void renderPdfPage(blob, { password, width: want.w, height: want.h, high, signal: ctrl.signal }).then((img) => {
      if (ctrl.signal.aborted) return;
      show(img && { id, url: URL.createObjectURL(img.png), width: img.width, height: img.height });
    });
    return () => ctrl.abort();
    // `show` only touches a ref and a state setter
  }, [id, blob, password, want, high]);

  const fit = shown && shown.id === id && box ? fitPage(shown.width, shown.height, box.w, box.h) : null;
  return { ref: setEl, page: fit && shown ? { url: shown.url, width: fit.width, height: fit.height } : undefined };
}
