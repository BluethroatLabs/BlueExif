/**
 * Helpers shared by the ZIP + XML document handlers (OOXML, ODF, EPUB):
 * cached XML parts with dirty tracking, namespace-aware element creation and
 * container sniffing.
 */

import { Reader, encodeUtf8, latin1 } from '../core/binary';
import { MetadataError } from '../core/types';
import {
  XmlDepthError,
  createElement,
  decodeXmlBytes,
  localName,
  lookupPrefix,
  nsOf,
  parseXml,
  serializeXml,
  type XDocument,
  type XElement,
} from '../core/xml';
import type { NewEntry, RewriteOptions, ZipArchive } from '../core/zip';

/** Timestamp written to every ZIP entry by strip (the DOS epoch). */
export const ZIP_EPOCH = new Date(1980, 0, 1);

/** Name and content of the first ZIP entry when it is STORED (ODF / EPUB `mimetype`). */
export function firstStoredEntry(head: Uint8Array): { name: string; data: string } | null {
  if (head.length < 30 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 3 || head[3] !== 4) return null;
  const r = new Reader(head, true);
  if (r.u16(8) !== 0) return null;
  const size = r.u32(22);
  const nameLen = r.u16(26);
  const extraLen = r.u16(28);
  const start = 30 + nameLen + extraLen;
  if (start + size > head.length || size > 200) return null;
  return { name: latin1(head.subarray(30, 30 + nameLen)), data: latin1(head.subarray(start, start + size)).trim() };
}

/** Does the head of a ZIP mention `name` in a local header (cheap structural sniff)? */
export function headHasEntry(head: Uint8Array, name: string): boolean {
  return latin1(head).includes(name);
}

/** Namespace + local-name test that, unlike `is()`, does not narrow (handy in else-if chains). */
export function isNamed(el: XElement, ns: string, local: string): boolean {
  return localName(el.name) === local && nsOf(el) === ns;
}

/** Resolve a relative reference against the directory of a part ("word/" + "../x" …). */
export function resolvePart(baseDir: string, target: string): string {
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    /* keep as written */
  }
  const parts = (t.startsWith('/') ? t.slice(1) : baseDir + t).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/**
 * Prefix bound to `uri` in scope of `el`; when none is, `preferred` (or a
 * numbered variant) is declared on `root`. Returns '' for a default namespace.
 */
export function ensurePrefix(root: XElement, el: XElement, uri: string, preferred: string): string {
  const found = lookupPrefix(el, uri);
  if (found !== null) return found;
  let p = preferred;
  for (let i = 1; root.attrs.some((a) => a.name === `xmlns:${p}`); i++) p = `${preferred}${i}`;
  root.attrs.push({ name: `xmlns:${p}`, value: uri });
  return p;
}

/** Qualified name for `local` in namespace `uri`, declaring the prefix if needed. */
export function qname(root: XElement, el: XElement, uri: string, preferred: string, local: string): string {
  const p = ensurePrefix(root, el, uri, preferred);
  return p ? `${p}:${local}` : local;
}

/** Create an element in a namespace (prefix resolved in the scope of `parent`). */
export function nsElement(root: XElement, parent: XElement, uri: string, preferred: string, local: string, text?: string): XElement {
  return createElement(qname(root, parent, uri, preferred, local), {}, text);
}

/** Lazily parsed XML parts of an archive; changed parts are re-serialised on finish(). */
export class XmlParts {
  private readonly docs = new Map<string, XDocument | null>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly raw = new Map<string, Uint8Array>();

  constructor(readonly zip: ZipArchive) {}

  /** Exact entry name for `name`, matched case-insensitively (OPC part names are). */
  entry(name: string): string | undefined {
    if (this.removed.has(name)) return undefined;
    if (this.zip.has(name) || this.docs.get(name) || this.raw.has(name)) return name;
    const lower = name.toLowerCase();
    return this.zip.entries.find((e) => e.name.toLowerCase() === lower && !this.removed.has(e.name))?.name;
  }

  has(name: string): boolean {
    return this.entry(name) !== undefined;
  }

  /** Parsed part, or null when missing. Throws MetadataError when malformed. */
  async get(name: string): Promise<XDocument | null> {
    const n = this.entry(name);
    if (!n) return null;
    if (this.docs.has(n)) return this.docs.get(n) ?? null;
    const doc = parseXml(decodeXmlBytes(await this.zip.read(n)));
    this.docs.set(n, doc);
    return doc;
  }

  /**
   * Like get() but returns null instead of throwing for malformed parts. Parts
   * nested too deeply still throw: skipping them would leave their hidden data
   * behind while reporting success.
   */
  async tryGet(name: string): Promise<XDocument | null> {
    try {
      return await this.get(name);
    } catch (e) {
      if (e instanceof XmlDepthError) throw e;
      return null;
    }
  }

  async require(name: string): Promise<XDocument> {
    const d = await this.get(name);
    if (!d) throw new MetadataError(`The document is missing ${name}`);
    return d;
  }

  /** Mark a part obtained via get() as modified. */
  touch(name: string): void {
    const n = this.entry(name) ?? name;
    this.dirty.add(n);
  }

  /** Add or replace a part with a new document. */
  put(name: string, doc: XDocument): void {
    const n = this.entry(name) ?? name;
    this.removed.delete(n);
    this.docs.set(n, doc);
    this.dirty.add(n);
  }

  /** Add or replace a binary part. */
  putRaw(name: string, data: Uint8Array): void {
    this.removed.delete(name);
    this.raw.set(name, data);
  }

  remove(name: string): void {
    const n = this.entry(name);
    if (!n) return;
    this.removed.add(n);
    this.dirty.delete(n);
    this.docs.delete(n);
    this.raw.delete(n);
  }

  get changed(): boolean {
    return this.dirty.size > 0 || this.removed.size > 0 || this.raw.size > 0;
  }

  /** Replacement / addition lists for rewriteZip. New parts are appended. */
  finish(): Pick<RewriteOptions, 'replace' | 'add'> {
    const replace = new Map<string, Uint8Array | null>();
    const add: NewEntry[] = [];
    const out = (name: string, data: Uint8Array) => {
      if (this.zip.has(name)) replace.set(name, data);
      else add.push({ name, data });
    };
    for (const n of this.removed) if (this.zip.has(n)) replace.set(n, null);
    for (const n of this.dirty) {
      const d = this.docs.get(n);
      if (d) out(n, xmlBytes(d));
    }
    for (const [n, data] of this.raw) out(n, data);
    return { replace, add };
  }
}

export function xmlBytes(doc: XDocument): Uint8Array {
  return encodeUtf8(serializeXml(doc));
}

/** A new document with an XML declaration and the given root. */
export function newXmlDoc(root: XElement, standalone = false): XDocument {
  return {
    nodes: [{ type: 'pi', target: 'xml', value: `version="1.0" encoding="UTF-8"${standalone ? ' standalone="yes"' : ''}` }, root],
    root,
  };
}
