/**
 * Hosted build: pdf.js parses PDFs in its own Web Worker, loaded from a hashed
 * asset next to the app (precached by the service worker like every other
 * asset). vite.config.ts swaps in pdfPreview.worker.single.ts for the
 * single-file build, which cannot start workers.
 */
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** Points pdf.js at its worker; true = renders share one real worker thread. */
export function preparePdfWorker(lib: PdfJs): boolean {
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  return true;
}
