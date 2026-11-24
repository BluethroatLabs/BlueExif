/** Request handling for the metadata engine, shared by the Web Worker and the in-page host. */

import { HANDLERS, readMetadata, stripMetadata, writeMetadata } from '../engine';
import type { Edits, MetadataErrorCode, StripOptions } from '../engine';

export type WorkerRequest =
  | { id: number; op: 'formats' }
  | { id: number; op: 'read'; blob: Blob; name: string; password?: string }
  | { id: number; op: 'write'; blob: Blob; name: string; edits: Edits; password?: string }
  | { id: number; op: 'strip'; blob: Blob; name: string; opts: StripOptions; password?: string };

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; code?: MetadataErrorCode };

export interface FormatSummary {
  id: string;
  name: string;
  category: string;
  extensions: string[];
  canWrite: boolean;
  canStrip: boolean;
}

export async function handleRequest(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    let result: unknown;
    switch (req.op) {
      case 'formats':
        result = HANDLERS.map(
          (h): FormatSummary => ({
            id: h.id,
            name: h.name,
            category: h.category,
            extensions: h.extensions,
            canWrite: !!h.write,
            canStrip: !!h.strip,
          }),
        );
        break;
      case 'read':
        result = await readMetadata(req.blob, req.name, { password: req.password });
        break;
      case 'write':
        result = await writeMetadata(req.blob, req.name, req.edits, { password: req.password });
        break;
      case 'strip':
        result = await stripMetadata(req.blob, req.name, req.opts, { password: req.password });
        break;
    }
    return { id: req.id, ok: true, result };
  } catch (e) {
    const err = e as Error & { code?: MetadataErrorCode };
    const known = err?.name === 'MetadataError';
    const message = known ? err.message : `Unexpected error: ${err?.message ?? String(e)}`;
    if (!known) console.error(e);
    return { id: req.id, ok: false, error: message, code: known ? err.code : undefined };
  }
}
