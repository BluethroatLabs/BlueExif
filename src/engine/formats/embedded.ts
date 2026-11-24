/**
 * Pictures embedded in other files (Office / OpenDocument / EPUB packages,
 * SVG `data:` URIs): what each one reveals, and a cleaned copy made by the
 * picture's own format handler, so pixels are copied exactly as for a
 * stand-alone file. Containers decide where pictures live and how to list them.
 */

import { equalBytes } from '../core/binary';
import { MetadataError, Source, type FormatHandler, type Sensitivity, type StripOptions } from '../core/types';
import { gifHandler } from './gif';
import { heifHandler } from './heif';
import { jpegHandler } from './jpeg';
import { pngHandler } from './png';
import { svgHandler } from './svg';
import { tiffHandler } from './tiff';
import { webpHandler } from './webp';

/** Built on use: svg.ts imports this module too, so its handler is not ready while modules load. */
const imageHandlers = (): FormatHandler[] => [jpegHandler, pngHandler, webpHandler, gifHandler, tiffHandler, heifHandler, svgHandler];

/** Highest risk first. */
const RANK: Sensitivity[] = ['location', 'identity', 'device', 'time', 'software', 'content'];
const WORDS: Record<Sensitivity, string> = {
  location: 'location',
  identity: 'people',
  device: 'device',
  time: 'dates',
  software: 'software',
  content: 'descriptions',
};

/** The picture's handler, recognised by content (a magic match), never by name alone. */
function handlerOf(bytes: Uint8Array, name: string): FormatHandler | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ctx = { head: bytes.subarray(0, 65536), name: lower, ext: dot >= 0 ? lower.slice(dot + 1) : '', size: bytes.length };
  let best: FormatHandler | null = null;
  let score = 1;
  for (const h of imageHandlers()) {
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

export interface EmbeddedInfo {
  /** e.g. "JPEG image · location, people, device, dates" */
  summary: string;
  /** the highest risk revealed */
  sensitivity: Sensitivity;
}

/** "<format> · location, people…" for the sensitivities found, highest risk first; null when none. */
export function revealed(formatName: string, sensitivities: Iterable<Sensitivity | undefined>): EmbeddedInfo | null {
  const found = new Set(sensitivities);
  const ranked = RANK.filter((s) => found.has(s));
  return ranked.length ? { summary: `${formatName} · ${ranked.map((s) => WORDS[s]).join(', ')}`, sensitivity: ranked[0] } : null;
}

/**
 * What an embedded picture reveals, or null when it is not a picture or
 * carries nothing personal. Throws MetadataError for a picture that cannot be
 * read (cleaning it would fail too), so containers can say so up front.
 */
export async function inspectEmbedded(bytes: Uint8Array, name: string): Promise<EmbeddedInfo | null> {
  const h = handlerOf(bytes, name);
  if (!h) return null;
  let m;
  try {
    m = await h.read(Source.fromBytes(bytes, name));
  } catch (e) {
    throw e instanceof MetadataError ? e : new MetadataError(`${h.name} could not be read`);
  }
  return revealed(
    m.format.name,
    m.groups.flatMap((g) => g.fields.map((f) => f.sensitivity)),
  );
}

/**
 * The picture without its metadata, or null when there is nothing to change
 * (not a picture, already clean). Throws MetadataError when the picture
 * cannot be cleaned, so callers never pass a dirty picture off as clean.
 */
export async function cleanEmbedded(bytes: Uint8Array, name: string, opts: StripOptions): Promise<Uint8Array | null> {
  const h = handlerOf(bytes, name);
  if (!h?.strip) return null;
  const out = new Uint8Array(await (await h.strip(Source.fromBytes(bytes, name), opts)).arrayBuffer());
  return equalBytes(out, bytes) ? null : out;
}
