/**
 * Single-file build: no workers at all (pages opened from file:// cannot start
 * them and the CSP says worker-src 'none'). Importing the pdf.js worker module
 * sets globalThis.pdfjsWorker, so pdf.js runs its parser on the page instead
 * (its "fake worker"). vite.config.ts aliases './pdfPreview.worker' to this
 * module when building with `--mode single`; it is only loaded with pdf.js.
 */
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** Nothing to configure; false = every document gets its own in-page worker. */
export function preparePdfWorker(_lib: PdfJs): boolean {
  return false;
}
