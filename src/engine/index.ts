/** Public entry point of the BlueExif engine. */

import { HANDLERS } from './formats';
import {
  DEFAULT_STRIP_OPTIONS,
  MetadataError,
  Source,
  type DetectContext,
  type Edits,
  type FormatHandler,
  type Metadata,
  type SourceOptions,
  type StripOptions,
} from './core/types';

export * from './core/types';
export { HANDLERS };

const HEAD_SIZE = 64 * 1024;

export async function detectHandler(blob: Blob, name: string): Promise<FormatHandler | null> {
  const head = new Uint8Array(await blob.slice(0, HEAD_SIZE).arrayBuffer());
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ctx: DetectContext = { head, name: lower, ext: dot >= 0 ? lower.slice(dot + 1) : '', size: blob.size };
  let best: FormatHandler | null = null;
  let score = 0;
  for (const h of HANDLERS) {
    let s = 0;
    try {
      s = h.detect(ctx);
    } catch {
      s = 0;
    }
    if (s > score) {
      score = s;
      best = h;
    }
  }
  return best;
}

async function handlerFor(blob: Blob, name: string): Promise<FormatHandler> {
  const h = await detectHandler(blob, name);
  if (!h) throw new MetadataError('Unsupported file type');
  return h;
}

export async function readMetadata(blob: Blob, name: string, src: SourceOptions = {}): Promise<Metadata> {
  const h = await handlerFor(blob, name);
  return h.read(new Source(blob, name, src));
}

export async function writeMetadata(blob: Blob, name: string, edits: Edits, src: SourceOptions = {}): Promise<Blob> {
  const h = await handlerFor(blob, name);
  if (!h.write) throw new MetadataError(`Editing ${h.name} files is not supported yet`);
  if (!edits.size) return blob;
  return h.write(new Source(blob, name, src), edits);
}

export async function stripMetadata(blob: Blob, name: string, opts: Partial<StripOptions> = {}, src: SourceOptions = {}): Promise<Blob> {
  const h = await handlerFor(blob, name);
  if (!h.strip) throw new MetadataError(`Removing metadata from ${h.name} files is not supported yet`);
  return h.strip(new Source(blob, name, src), { ...DEFAULT_STRIP_OPTIONS, ...opts });
}
