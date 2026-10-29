/**
 * Pictures stored as entries of ZIP document packages (Office, OpenDocument,
 * EPUB): an "Embedded images" group listing each picture that reveals
 * something (one removable raw field per picture, the group removable), and
 * cleaning through the picture's own handler (embedded.ts). The container
 * decides which entries are pictures; cleaned bytes replace the entry through
 * XmlParts, so the ZIP rewrite copies every other entry raw.
 */

import { rawField } from '../core/fields';
import { MetadataError, groupKey, type Edits, type Field, type FieldGroup, type StripOptions } from '../core/types';
import type { XmlParts } from './docparts';
import { cleanEmbedded, inspectEmbedded } from './embedded';

/** Where a container lists its pictures: group id, field-id prefix and source label. */
export interface MediaSpec {
  group: string;
  /** field ids are `${prefix}${path}` */
  prefix: string;
  source: string;
}

/** Cleaning asked for by an edit keeps what affects display (orientation, colours). */
const EDIT_OPTIONS: StripOptions = { keepOrientation: true, keepColorProfile: true, keepCoverArt: true };

const DESCRIPTION = 'Metadata stored inside a picture placed in the document (camera, location, author…). Removing it leaves the pixels unchanged.';

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Existing entry names for `paths` (matched like OPC part names), without duplicates. */
function present(parts: XmlParts, paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const n = parts.entry(p);
    if (n && !n.endsWith('/')) out.add(n);
  }
  return [...out];
}

/**
 * The "Embedded images" group for the pictures at `paths`, or null when none
 * reveals anything. Pictures that cannot be read are reported in `warnings`.
 */
export async function mediaGroup(parts: XmlParts, paths: Iterable<string>, spec: MediaSpec, warnings: string[]): Promise<FieldGroup | null> {
  const fields: Field[] = [];
  const unread: string[] = [];
  for (const name of present(parts, paths)) {
    let bytes: Uint8Array;
    try {
      bytes = await parts.zip.read(name);
    } catch {
      unread.push(name);
      continue;
    }
    let info;
    try {
      info = await inspectEmbedded(bytes, name);
    } catch {
      unread.push(name);
      continue;
    }
    if (!info) continue;
    fields.push(
      rawField(`${spec.prefix}${name}`, basename(name), `${name} · ${info.summary}`, { sensitivity: info.sensitivity, tag: name, description: DESCRIPTION }),
    );
  }
  if (unread.length) warnings.push(`${unread.length > 1 ? `${unread.length} pictures` : unread[0]} could not be checked for metadata.`);
  if (!fields.length) return null;
  return { id: spec.group, label: 'Embedded images', source: spec.source, fields, removable: true };
}

/** Clean the pictures at `paths` in place. Throws MetadataError naming a picture that cannot be cleaned. */
export async function cleanMedia(parts: XmlParts, paths: Iterable<string>, opts: StripOptions): Promise<void> {
  for (const name of present(parts, paths)) {
    let out: Uint8Array | null;
    try {
      out = await cleanEmbedded(await parts.zip.read(name), name, opts);
    } catch (e) {
      throw new MetadataError(`The picture ${name} cannot be cleaned: ${(e as Error).message}`);
    }
    if (out) parts.putRaw(name, out);
  }
}

/** Honour removals of the group's fields (or of the whole group) among the pictures at `paths`. */
export async function applyMediaEdits(parts: XmlParts, paths: Iterable<string>, spec: MediaSpec, edits: Edits): Promise<void> {
  const all = edits.get(groupKey(spec.group))?.op === 'remove';
  const wanted = present(parts, paths).filter((n) => all || edits.get(`${spec.prefix}${n}`)?.op === 'remove');
  if (wanted.length) await cleanMedia(parts, wanted, EDIT_OPTIONS);
}
