/**
 * HEIF / HEIC / AVIF still images (ISO/IEC 23008-12, MIAF).
 *
 * Metadata are items of the top-level `meta` box: an `Exif` item (4-byte
 * offset to the TIFF header, then TIFF) and an XMP `mime` item
 * (application/rdf+xml), linked to the primary image by `cdsc` references.
 * Orientation is the `irot`/`imir` item property, not the EXIF tag.
 *
 * Writing rebuilds the `meta` box (iinf/iloc/iref/iprp) and relocates every
 * file-offset item location (and `stco`/`co64` of image sequences) when it
 * changes size. A new payload that fits in the old extent is written in place
 * with the remainder zero-filled; otherwise it goes to a new `mdat` at the end
 * of the file and the old bytes are zeroed, so no stale metadata survives.
 *
 * Strip removes every Exif item and the XMP/other metadata items of the
 * primary and secondary images (zeroing their bytes); XMP attached only to
 * auxiliary images (gain-map / depth parameters) and all image items,
 * thumbnails and transformative properties (irot/imir) are kept.
 *
 * Image sequences also carry a movie (`moov`): its header dates are shown and
 * editable; strip removes its user data / meta boxes, zeroes the dates and
 * blanks encoder names (compressor name, sample-entry vendor, handler names).
 */

import { Reader, Writer, concat, encodeLatin1, encodeUtf8, formatBytes, utf8OrLatin1 } from '../core/binary';
import { rawField } from '../core/fields';
import { iccDescription } from '../core/icc';
import {
  HEIF_BRANDS,
  applyHeaderDateEdits,
  assemble,
  blankHandlerName,
  child,
  childrenOf,
  fitIloc,
  fourcc,
  fullHead,
  headerDateGroup,
  itemRanges,
  parseBoxes,
  parseFtyp,
  parseIloc,
  patchChunkOffsets,
  relocateIloc,
  relocator,
  removeChildren,
  scanTopLevel,
  scrubTrackFingerprints,
  serializeIloc,
  showFourcc,
  sniffFtyp,
  sniffTopTypes,
  totalSize,
  zeroHeaderDates,
  type BoxNode,
  type Ftyp,
  type Iloc,
  type IlocItem,
  type Piece,
  type TopBox,
} from '../core/isobmff';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edits,
  type Field,
  type FieldGroup,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Source,
  type StripOptions,
} from '../core/types';
import { applyExifEdits, exifGroups } from '../exif/fields';
import { emptyExif, isEmptyExif, isTiffHeader, parseTiff, writeTiff, type ExifData } from '../exif/tiff';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';

const XMP_MIME = 'application/rdf+xml';
const ESSENTIAL_TOP = new Set(['ftyp', 'meta', 'mdat', 'moov', 'idat']);
const EXIF_PREFIX = encodeLatin1('Exif\0\0');
const G_DATES = 'heif.dates';
const MOOV_CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf']);

// ------------------------------------------------------------------ model

interface Item {
  id: number;
  type: string;
  name: string;
  contentType?: string;
  hidden: boolean;
  /** original infe payload (re-emitted verbatim) */
  raw: Uint8Array;
}

interface Ref {
  type: string;
  from: number;
  to: number[];
}

interface Assoc {
  essential: boolean;
  index: number;
}

interface Heif {
  bytes: Uint8Array;
  top: TopBox[];
  trailing: number | null;
  ftyp: Ftyp | null;
  metaBox: TopBox;
  /** meta payload children (iprp parsed one level deeper) */
  meta: BoxNode;
  primary: number;
  items: Item[];
  iinfVersion: number;
  iloc: Iloc;
  refs: Ref[];
  irefVersion: number;
  props: BoxNode[];
  assoc: Map<number, Assoc[]>;
  ipmaVersion: number;
  ipmaFlags: number;
  /** absolute offset of the idat payload, if any */
  idatStart: number;
  /** movie of an image sequence (first `moov`) */
  moovBox: TopBox | null;
  moov: BoxNode | null;
  warnings: string[];
}

function cstring(d: Uint8Array, at: number): { text: string; next: number } {
  let e = at;
  while (e < d.length && d[e] !== 0) e++;
  return { text: utf8OrLatin1(d.subarray(at, e)), next: Math.min(d.length, e + 1) };
}

function parseInfe(d: Uint8Array): Item | null {
  if (d.length < 8) return null;
  const r = new Reader(d);
  const version = d[0];
  const hidden = (r.u24(1) & 1) === 1;
  if (version < 2) {
    const id = r.u16(4);
    const name = cstring(d, 8);
    const ct = cstring(d, name.next);
    return { id, type: ct.text ? 'mime' : '', name: name.text, contentType: ct.text || undefined, hidden, raw: d };
  }
  let p = 4;
  const id = version === 2 ? r.u16(p) : r.u32(p);
  p += (version === 2 ? 2 : 4) + 2;
  if (p + 4 > d.length) return null;
  const type = fourcc(d, p);
  const name = cstring(d, p + 4);
  const item: Item = { id, type, name: name.text, hidden, raw: d };
  if (type === 'mime') item.contentType = cstring(d, name.next).text;
  return item;
}

function parseRefs(d: Uint8Array): { version: number; refs: Ref[] } {
  const r = new Reader(d);
  const version = d[0];
  const refs: Ref[] = [];
  let p = 4;
  while (p + 8 <= d.length) {
    const size = r.u32(p);
    if (size < 8 || p + size > d.length) break;
    const type = fourcc(d, p + 4);
    let q = p + 8;
    const from = version ? r.u32(q) : r.u16(q);
    q += version ? 4 : 2;
    const n = r.u16(q);
    q += 2;
    const to: number[] = [];
    for (let i = 0; i < n && q < p + size; i++) {
      to.push(version ? r.u32(q) : r.u16(q));
      q += version ? 4 : 2;
    }
    refs.push({ type, from, to });
    p += size;
  }
  return { version, refs };
}

function parseIpma(d: Uint8Array): { version: number; flags: number; assoc: Map<number, Assoc[]> } {
  const r = new Reader(d);
  const version = d[0];
  const flags = r.u24(1);
  const assoc = new Map<number, Assoc[]>();
  const n = r.u32(4);
  let p = 8;
  for (let i = 0; i < n && p < d.length; i++) {
    const id = version < 1 ? r.u16(p) : r.u32(p);
    p += version < 1 ? 2 : 4;
    const count = d[p++];
    const list: Assoc[] = [];
    for (let k = 0; k < count; k++) {
      if (flags & 1) {
        const v = r.u16(p);
        p += 2;
        list.push({ essential: (v & 0x8000) !== 0, index: v & 0x7fff });
      } else {
        const v = d[p++];
        list.push({ essential: (v & 0x80) !== 0, index: v & 0x7f });
      }
    }
    assoc.set(id, list);
  }
  return { version, flags, assoc };
}

const metaContainer = (type: string) => (type === 'iprp' || type === 'ipco' ? 0 : null);

function parseHeif(bytes: Uint8Array, top: TopBox[], trailing: number | null): Heif {
  const ftypBox = top.find((b) => b.type === 'ftyp');
  const ftyp = ftypBox ? parseFtyp(bytes.subarray(ftypBox.start + ftypBox.headerSize, ftypBox.end)) : null;
  const metaBox = top.find((b) => b.type === 'meta');
  if (!metaBox) throw new MetadataError('This HEIF file has no image metadata box (meta)');
  const warnings: string[] = [];
  const payload = bytes.subarray(metaBox.start + metaBox.headerSize, metaBox.end);
  if (payload.length < 4) throw new MetadataError('Damaged HEIF meta box');
  const tree = parseBoxes(payload, 4, payload.length, metaContainer, ['meta'], warnings);
  const meta: BoxNode = { type: 'meta', head: payload.slice(0, 4), children: tree.boxes, tail: tree.tail };
  // Absolute position of the idat payload.
  let idatStart = -1;
  {
    const r = new Reader(payload);
    let p = 4;
    while (p + 8 <= payload.length) {
      let size = r.u32(p);
      let hs = 8;
      if (size === 1) {
        size = r.u64(p + 8);
        hs = 16;
      }
      if (size < hs || p + size > payload.length) break;
      if (fourcc(payload, p + 4) === 'idat') idatStart = metaBox.start + metaBox.headerSize + p + hs;
      p += size;
    }
  }
  const hdlr = child(meta, 'hdlr')?.data;
  if (hdlr && hdlr.length >= 12 && fourcc(hdlr, 8) !== 'pict') warnings.push(`Unexpected meta handler '${fourcc(hdlr, 8)}'`);
  const pitm = child(meta, 'pitm')?.data;
  const primary = pitm && pitm.length >= 6 ? (pitm[0] ? new Reader(pitm).u32(4) : new Reader(pitm).u16(4)) : 0;
  const iinf = child(meta, 'iinf')?.data;
  const items: Item[] = [];
  let iinfVersion = 0;
  if (iinf && iinf.length >= 6) {
    iinfVersion = iinf[0];
    const start = iinfVersion === 0 ? 6 : 8;
    for (const b of parseBoxes(iinf, start, iinf.length, () => null).boxes) {
      if (b.type !== 'infe' || !b.data) continue;
      const it = parseInfe(b.data);
      if (it) items.push(it);
    }
  }
  const ilocData = child(meta, 'iloc')?.data;
  if (!ilocData) throw new MetadataError('This HEIF file has no item location box (iloc)');
  const iloc = parseIloc(ilocData);
  const irefData = child(meta, 'iref')?.data;
  const { version: irefVersion, refs } = irefData ? parseRefs(irefData) : { version: 0, refs: [] };
  const iprp = child(meta, 'iprp');
  const props = child(iprp, 'ipco')?.children ?? [];
  const ipmaData = child(iprp, 'ipma')?.data;
  if (childrenOf(iprp, 'ipma').length > 1) warnings.push('Multiple property association boxes; only the first is used');
  const ipma = ipmaData ? parseIpma(ipmaData) : { version: 0, flags: 0, assoc: new Map<number, Assoc[]>() };
  const moovBox = top.find((b) => b.type === 'moov') ?? null;
  let moov: BoxNode | null = null;
  if (moovBox) {
    const m = bytes.subarray(moovBox.start + moovBox.headerSize, moovBox.end);
    const tree = parseBoxes(m, 0, m.length, (t) => (MOOV_CONTAINERS.has(t) ? 0 : null), ['moov'], warnings);
    moov = { type: 'moov', children: tree.boxes, tail: tree.tail };
  }
  return {
    bytes,
    top,
    trailing,
    ftyp,
    metaBox,
    meta,
    primary,
    items,
    iinfVersion,
    iloc,
    refs,
    irefVersion,
    props,
    assoc: ipma.assoc,
    ipmaVersion: ipma.version,
    ipmaFlags: ipma.flags,
    idatStart,
    moovBox,
    moov,
    warnings,
  };
}

async function loadHeif(src: Source): Promise<Heif> {
  const bytes = await src.bytes();
  const { boxes, trailing } = await scanTopLevel(src);
  return parseHeif(bytes, boxes, trailing);
}

function locOf(h: Heif, id: number): IlocItem | undefined {
  return h.iloc.items.find((i) => i.id === id);
}

/** Item payload, or null if it is stored somewhere we cannot read. */
function itemData(h: Heif, id: number): Uint8Array | null {
  const loc = locOf(h, id);
  if (!loc) return null;
  const ranges = itemRanges(loc, h.idatStart, h.bytes.length);
  if (!ranges || (loc.method === 1 && h.idatStart < 0)) return null;
  if (ranges.some(([s, e]) => s < 0 || e > h.bytes.length || e < s)) return null;
  // Real extents are disjoint; more bytes than the file holds means they overlap (a crafted file).
  if (ranges.reduce((n, [s, e]) => n + e - s, 0) > h.bytes.length) return null;
  return concat(ranges.map(([s, e]) => h.bytes.subarray(s, e)));
}

const describes = (h: Heif, id: number): number[] => h.refs.filter((r) => r.type === 'cdsc' && r.from === id).flatMap((r) => r.to);

/** Metadata item of a kind that describes the primary image (or nothing in particular). */
function primaryMetaItem(h: Heif, pred: (i: Item) => boolean): Item | undefined {
  const cands = h.items.filter(pred);
  return cands.find((i) => describes(h, i.id).includes(h.primary)) ?? cands.find((i) => !describes(h, i.id).length);
}

const isExifItem = (i: Item) => i.type === 'Exif';

/**
 * Strip keeps non-EXIF metadata that only describes auxiliary images (gain-map
 * / depth parameters needed for rendering) and anything an image depends on.
 */
function keptByStrip(h: Heif, it: Item): boolean {
  if (h.refs.some((r) => r.from !== it.id && r.type !== 'cdsc' && r.to.includes(it.id))) return true;
  if (it.type === 'Exif') return false;
  const aux = new Set(h.refs.filter((r) => r.type === 'auxl').map((r) => r.from));
  const target = describes(h, it.id);
  return target.length > 0 && target.every((t) => aux.has(t));
}
const isXmpItem = (i: Item) => i.type === 'mime' && i.contentType?.split(';')[0].trim() === XMP_MIME;
const isMetaItem = (i: Item) => i.type === 'Exif' || i.type === 'mime' || i.type === 'uri ';

function tiffOf(payload: Uint8Array): { offset: number } | null {
  if (payload.length < 12) return null;
  const off = new Reader(payload).u32(0);
  if (isTiffHeader(payload, 4 + off)) return { offset: 4 + off };
  for (let p = 4; p < Math.min(payload.length - 8, 64); p++) if (isTiffHeader(payload, p)) return { offset: p };
  return null;
}

function exifOf(h: Heif): { item?: Item; data: ExifData | null; error?: string } {
  const item = primaryMetaItem(h, isExifItem);
  if (!item) return { data: null };
  const payload = itemData(h, item.id);
  if (!payload) return { item, data: null, error: 'EXIF item data could not be located' };
  const t = tiffOf(payload);
  if (!t) return { item, data: null, error: 'EXIF item has no TIFF header' };
  try {
    return { item, data: parseTiff(payload.subarray(t.offset)) };
  } catch (e) {
    return { item, data: null, error: `EXIF could not be parsed: ${(e as Error).message}` };
  }
}

function xmpOf(h: Heif): { item?: Item; data: XmpPacket | null; error?: string } {
  const item = primaryMetaItem(h, isXmpItem);
  if (!item) return { data: null };
  const payload = itemData(h, item.id);
  if (!payload) return { item, data: null, error: 'XMP item data could not be located' };
  try {
    return { item, data: parseXmp(utf8OrLatin1(payload)) };
  } catch (e) {
    return { item, data: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

/** Properties associated with an item (1-based ipco indices). */
function propsOf(h: Heif, id: number): BoxNode[] {
  return (h.assoc.get(id) ?? []).map((a) => h.props[a.index - 1]).filter((p): p is BoxNode => !!p);
}

function isIccColr(p: BoxNode): boolean {
  return p.type === 'colr' && !!p.data && p.data.length > 4 && ['prof', 'rICC'].includes(fourcc(p.data, 0));
}

// ------------------------------------------------------------------ reading

const CODEC: Record<string, string> = {
  hvc1: 'HEVC',
  hev1: 'HEVC',
  av01: 'AV1',
  avc1: 'H.264',
  vvc1: 'VVC',
  jpeg: 'JPEG',
  j2k1: 'JPEG 2000',
  unci: 'Uncompressed',
  mski: 'Mask',
};

function formatOf(h: Heif): { name: string; mime: string } {
  const brands = [h.ftyp?.major ?? '', ...(h.ftyp?.compatible ?? [])];
  const primaryType = h.items.find((i) => i.id === h.primary)?.type;
  const tileType = h.items.find((i) => h.refs.some((r) => r.type === 'dimg' && r.from === h.primary && r.to.includes(i.id)))?.type;
  const codec = primaryType === 'grid' || primaryType === 'iovl' || primaryType === 'iden' ? tileType : primaryType;
  if (h.ftyp?.major === 'avif' || h.ftyp?.major === 'avis' || codec === 'av01') return { name: 'AVIF image', mime: 'image/avif' };
  if (codec === 'hvc1' || codec === 'hev1' || brands.some((b) => /^he[iv][cxms]$/.test(b))) return { name: 'HEIC image', mime: 'image/heic' };
  return { name: 'HEIF image', mime: 'image/heif' };
}

function orientationText(irot: number, mirror: number | null): string {
  const rot = ['', 'rotated 90° counter-clockwise', 'rotated 180°', 'rotated 90° clockwise'][irot & 3];
  const mir = mirror === null ? '' : mirror ? 'mirrored left–right' : 'mirrored top–bottom';
  return [mir, rot].filter(Boolean).join(', ') || 'normal';
}

function colrText(p: BoxNode): string | null {
  const d = p.data!;
  const kind = fourcc(d, 0);
  if (kind === 'nclx' && d.length >= 11) {
    const r = new Reader(d);
    const [pri, tr, mx] = [r.u16(4), r.u16(6), r.u16(8)];
    const full = d[10] & 0x80 ? 'full range' : 'limited range';
    const named =
      pri === 1 && tr === 13
        ? 'sRGB'
        : pri === 12 && tr === 13
          ? 'Display P3'
          : pri === 9 && tr === 16
            ? 'BT.2100 PQ'
            : pri === 9 && tr === 18
              ? 'BT.2100 HLG'
              : pri === 1 && tr === 1
                ? 'BT.709'
                : null;
    return `${named ?? `primaries ${pri}, transfer ${tr}`}, matrix ${mx}, ${full}`;
  }
  if (kind === 'prof' || kind === 'rICC') return iccDescription(d.subarray(4)) ?? 'Embedded ICC profile';
  return null;
}

function auxType(h: Heif, id: number): string | null {
  const aux = propsOf(h, id).find((p) => p.type === 'auxC');
  if (!aux?.data) return null;
  const urn = cstring(aux.data, 4).text;
  if (/alpha/i.test(urn) || /auxid:1$/.test(urn)) return 'alpha';
  if (/depth/i.test(urn) || /auxid:2$/.test(urn)) return 'depth';
  if (/gainmap|hdrgainmap/i.test(urn)) return 'gain map';
  if (/matte/i.test(urn)) return 'portrait matte';
  return urn || 'auxiliary';
}

export async function readHeif(src: Source): Promise<Metadata> {
  const h = await loadHeif(src);
  const warnings = [...h.warnings];
  const info: InfoItem[] = [];
  const groups: FieldGroup[] = [];
  const fmt = formatOf(h);

  // ---- info
  const primaryItem = h.items.find((i) => i.id === h.primary);
  if (!primaryItem) warnings.push('Primary image item not found');
  const pprops = propsOf(h, h.primary);
  const ispe = pprops.find((p) => p.type === 'ispe')?.data;
  const irot = pprops.find((p) => p.type === 'irot')?.data;
  const imir = pprops.find((p) => p.type === 'imir')?.data;
  if (ispe && ispe.length >= 12) {
    const r = new Reader(ispe);
    const [w, ht] = [r.u32(4), r.u32(8)];
    const turned = irot && irot[0] & 1;
    info.push({ label: 'Dimensions', value: turned ? `${ht} × ${w} (stored ${w} × ${ht})` : `${w} × ${ht}` });
  }
  if (primaryItem) {
    const tiles = h.refs.filter((r) => r.type === 'dimg' && r.from === h.primary).flatMap((r) => r.to);
    const tileType = h.items.find((i) => i.id === tiles[0])?.type ?? '';
    const codec =
      primaryItem.type === 'grid'
        ? `${CODEC[tileType] ?? showFourcc(tileType)} (grid of ${tiles.length} tiles)`
        : primaryItem.type === 'tmap'
          ? 'Tone-mapped (gain map)'
          : (CODEC[primaryItem.type] ?? showFourcc(primaryItem.type));
    info.push({ label: 'Codec', value: codec });
  }
  const pixi = pprops.find((p) => p.type === 'pixi')?.data;
  if (pixi && pixi.length >= 6) info.push({ label: 'Bit depth', value: `${pixi[5]}-bit, ${pixi[4]} channel${pixi[4] === 1 ? '' : 's'}` });
  for (const c of pprops.filter((p) => p.type === 'colr' && p.data && p.data.length >= 4)) {
    const t = colrText(c);
    if (t) info.push({ label: isIccColr(c) ? 'Color profile' : 'Color', value: t });
  }
  if (irot || imir) info.push({ label: 'Orientation', value: `${orientationText(irot?.[0] ?? 0, imir ? imir[0] & 1 : null)} (stored in the container)` });
  const thumbs = h.refs.filter((r) => r.type === 'thmb' && r.to.includes(h.primary)).length;
  const aux = h.refs.filter((r) => r.type === 'auxl' && r.to.includes(h.primary)).map((r) => auxType(h, r.from) ?? 'auxiliary');
  const tiles = new Set(h.refs.filter((r) => r.type === 'dimg').flatMap((r) => r.to));
  const images = h.items.filter((i) => !isMetaItem(i) && !tiles.has(i.id)).length;
  const meta = h.items.filter(isMetaItem).length;
  const parts = [`${images} image${images === 1 ? '' : 's'}`, tiles.size ? `${tiles.size} tiles` : '', meta ? `${meta} metadata` : ''];
  info.push({ label: 'Items', value: `${h.items.length} (${parts.filter(Boolean).join(', ')})` });
  if (thumbs) info.push({ label: 'Thumbnails', value: String(thumbs) });
  if (aux.length) info.push({ label: 'Auxiliary images', value: aux.join(', ') });
  if (h.top.some((b) => b.type === 'moov')) info.push({ label: 'Image sequence', value: 'Yes (also contains a movie track)' });

  // ---- EXIF / XMP
  const exif = exifOf(h);
  if (exif.error) warnings.push(exif.error);
  if (exif.data) warnings.push(...exif.data.warnings.map((w) => `EXIF: ${w}`));
  groups.push(...exifGroups(exif.data ?? emptyExif(), { addable: true }));
  const xmp = xmpOf(h);
  if (xmp.error) warnings.push(xmp.error);
  groups.push(...xmpGroups(xmp.data ?? { props: [] }, { addable: true }));

  // ---- image sequence: movie, track and media header dates
  if (h.moov) groups.push(headerDateGroup(h.moov, 'heif', { id: G_DATES, source: 'HEIF image sequence' }));

  // ---- other embedded data
  const other: Field[] = [];
  const icc = pprops.find(isIccColr);
  if (icc) {
    const desc = iccDescription(icc.data!.subarray(4));
    other.push(
      rawField('heif:icc', 'Color profile (ICC)', `${desc ?? 'ICC profile'} — ${formatBytes(icc.data!.length - 4)}`, {
        tag: 'colr',
        description: 'Removing the color profile can make colors look different.',
      }),
    );
  }
  for (const it of h.items) {
    if (!isMetaItem(it) || it === exif.item || it === xmp.item) continue;
    const size = locOf(h, it.id)?.extents.reduce((n, e) => n + e.length, 0) ?? 0;
    const target = describes(h, it.id);
    const keep = keptByStrip(h, it);
    const what = it.type === 'Exif' ? 'EXIF' : it.type === 'uri ' ? 'URI metadata' : it.contentType || 'Metadata';
    const label = keep ? `${what} of auxiliary image` : target.length && !target.includes(h.primary) ? `${what} of secondary image` : `${what} item`;
    other.push(
      rawField(`heif:item:${it.id}`, label, formatBytes(size), {
        tag: `item ${it.id} (${showFourcc(it.type)})`,
        sensitivity: keep ? undefined : it.type === 'Exif' ? 'device' : 'content',
        description: keep ? 'Rendering parameters of an auxiliary image (e.g. HDR gain map); kept when removing metadata.' : undefined,
      }),
    );
  }
  for (const b of h.top) {
    if (ESSENTIAL_TOP.has(b.type) || b.type === 'free' || b.type === 'skip') continue;
    other.push(rawField(`heif:box:${b.start}`, `Box ${showFourcc(b.type)}`, formatBytes(b.size), { tag: showFourcc(b.type) }));
  }
  if (h.trailing !== null) {
    other.push(rawField('heif:trailer', 'Data after image', formatBytes(h.bytes.length - h.trailing), { tag: 'Trailer', sensitivity: 'content' }));
  }
  if (other.length) groups.push({ id: 'heif.other', label: 'Embedded data', source: 'HEIF', fields: other });

  return {
    format: { id: 'heif', name: fmt.name, mime: fmt.mime, category: 'image' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// --------------------------------------------------------------- writing

interface Plan {
  /** new Exif item payload; null removes the item; undefined keeps it */
  exif?: Uint8Array | null;
  xmp?: Uint8Array | null;
  /** further item ids to remove */
  removeItems: Set<number>;
  dropIcc: boolean;
  removeTop: Set<TopBox>;
  dropTrailing: boolean;
  /** header date edits for the movie of an image sequence */
  dates?: Edits;
  /** strip: clear the movie metadata of image sequences (user data, dates, encoder names) and the handler name */
  clean: boolean;
}

const newPlan = (): Plan => ({ removeItems: new Set(), dropIcc: false, removeTop: new Set(), dropTrailing: false, clean: false });

function exifPayload(d: ExifData, original: Uint8Array | null): Uint8Array {
  const tiff = writeTiff(d);
  // Keep the original prefix ("Exif\0\0" in Apple/libheif files).
  let prefix = EXIF_PREFIX;
  if (original) {
    const t = tiffOf(original);
    if (t) prefix = original.slice(4, t.offset);
  }
  const w = new Writer(false, tiff.length + prefix.length + 4);
  w.u32(prefix.length).bytes(prefix).bytes(tiff);
  return w.finish();
}

function infePayload(id: number, type: string, contentType?: string): Uint8Array {
  const v3 = id > 0xffff;
  const w = new Writer(false, 64);
  w.bytes(fullHead(v3 ? 3 : 2, 1));
  if (v3) w.u32(id);
  else w.u16(id);
  w.u16(0).ascii(type).u8(0);
  if (contentType) w.bytes(encodeUtf8(contentType)).u8(0);
  return w.finish();
}

function iinfBox(version: number, items: Item[]): BoxNode {
  const v = version === 0 && items.length > 0xffff ? 1 : version;
  const w = new Writer(false, 256);
  w.bytes(fullHead(v));
  if (v === 0) w.u16(items.length);
  else w.u32(items.length);
  for (const it of items)
    w.u32(it.raw.length + 8)
      .ascii('infe')
      .bytes(it.raw);
  return { type: 'iinf', data: w.finish() };
}

function irefBox(version: number, refs: Ref[]): BoxNode {
  const v = refs.some((r) => r.from > 0xffff || r.to.some((t) => t > 0xffff)) ? 1 : version;
  const w = new Writer(false, 256);
  w.bytes(fullHead(v));
  for (const r of refs) {
    const size = 8 + (v ? 4 : 2) + 2 + r.to.length * (v ? 4 : 2);
    w.u32(size).ascii(r.type);
    if (v) w.u32(r.from);
    else w.u16(r.from);
    w.u16(r.to.length);
    for (const t of r.to) {
      if (v) w.u32(t);
      else w.u16(t);
    }
  }
  return { type: 'iref', data: w.finish() };
}

function ipmaBox(version: number, flags: number, assoc: Map<number, Assoc[]>): BoxNode {
  const big = (flags & 1) !== 0 || [...assoc.values()].some((l) => l.some((a) => a.index > 0x7f));
  const v = version === 0 && [...assoc.keys()].some((id) => id > 0xffff) ? 1 : version;
  const w = new Writer(false, 256);
  w.bytes(fullHead(v, big ? flags | 1 : flags)).u32(assoc.size);
  for (const [id, list] of [...assoc].sort((a, b) => a[0] - b[0])) {
    if (v < 1) w.u16(id);
    else w.u32(id);
    w.u8(list.length);
    for (const a of list) {
      if (big) w.u16((a.essential ? 0x8000 : 0) | a.index);
      else w.u8((a.essential ? 0x80 : 0) | a.index);
    }
  }
  return { type: 'ipma', data: w.finish() };
}

/** Byte-level changes inside kept top-level boxes. */
interface Patch {
  at: number;
  bytes: Uint8Array;
}

/** `ranges` merged: what to zero, each byte once however much they overlap. */
function unionRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const prev = out[out.length - 1];
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Merge overlapping patches (their union is fully covered, later ones win). */
function mergePatches(list: Patch[]): Patch[] {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  const out: Patch[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && p.at < prev.at + prev.bytes.length) {
      const end = Math.max(prev.at + prev.bytes.length, p.at + p.bytes.length);
      const buf = new Uint8Array(end - prev.at);
      buf.set(prev.bytes);
      buf.set(p.bytes, p.at - prev.at);
      out[out.length - 1] = { at: prev.at, bytes: buf };
    } else out.push(p);
  }
  return out;
}

/** Entity group ids share the item id space. */
function entityGroupIds(meta: BoxNode): number[] {
  const grpl = child(meta, 'grpl')?.data;
  if (!grpl) return [];
  const ids: number[] = [];
  const r = new Reader(grpl);
  for (let p = 0; p + 16 <= grpl.length; ) {
    const size = r.u32(p);
    if (size < 16 || p + size > grpl.length) break;
    ids.push(r.u32(p + 12));
    p += size;
  }
  return ids;
}

function boxHeader(type: string, size: number): Uint8Array {
  return new Writer(false, 8).u32(size).ascii(type).finish();
}

async function rebuild(src: Source, h: Heif, plan: Plan): Promise<Blob> {
  let items = [...h.items];
  const iloc: Iloc = { ...h.iloc, items: h.iloc.items.map((i) => ({ ...i, extents: i.extents.map((e) => ({ ...e })) })) };
  let refs = h.refs.map((r) => ({ ...r, to: [...r.to] }));
  const assoc = new Map([...h.assoc].map(([k, v]) => [k, [...v]]));
  let props = [...h.props];
  const idat = child(h.meta, 'idat');
  const idatData = idat?.data ? idat.data.slice() : null;
  const patches: Patch[] = [];
  const appended: Array<{ loc: IlocItem; data: Uint8Array; offset: number }> = [];
  let appendSize = 0;

  /** Old item bytes to zero (file offsets, and offsets into idat), merged before use: crafted extents can overlap endlessly. */
  const zeroFile: Array<[number, number]> = [];
  const zeroIdat: Array<[number, number]> = [];
  /** Zero an item's old bytes (file or idat) so nothing stale survives. */
  const zeroItem = (loc: IlocItem) => {
    const ranges = itemRanges(loc, h.idatStart, h.bytes.length);
    if (!ranges || (loc.method === 1 && !idatData)) return;
    const [lo, hi] = loc.method === 1 ? [h.idatStart, h.idatStart + idatData!.length] : [0, h.bytes.length];
    for (const [s, e] of ranges) {
      // Zeroing a clamped range could wipe the image; skipping it would leave the old bytes behind.
      if (s < lo || e > hi || e < s) throw new MetadataError('A metadata item points outside the file, so it cannot be removed safely');
      if (loc.method === 1) zeroIdat.push([s - h.idatStart, e - h.idatStart]);
      else zeroFile.push([s, e]);
    }
  };
  const removeItem = (id: number) => {
    const loc = iloc.items.find((i) => i.id === id);
    if (loc) zeroItem(loc);
    items = items.filter((i) => i.id !== id);
    iloc.items = iloc.items.filter((i) => i.id !== id);
    refs = refs
      .filter((r) => r.from !== id)
      .map((r) => ({ ...r, to: r.to.filter((t) => t !== id) }))
      .filter((r) => r.to.length);
    assoc.delete(id);
  };
  const appendTo = (loc: IlocItem, data: Uint8Array) => {
    loc.method = 0;
    loc.dataRef = 0;
    loc.base = 0;
    loc.extents = [{ index: 0, offset: 0, length: data.length }];
    appended.push({ loc, data, offset: appendSize });
    appendSize += data.length;
  };
  const setPayload = (item: Item | undefined, data: Uint8Array | null | undefined, make: () => Item) => {
    if (data === undefined) return;
    if (data === null) {
      if (item) removeItem(item.id);
      return;
    }
    if (!item) {
      const it = make();
      items.push(it);
      const loc: IlocItem = { id: it.id, method: 0, dataRef: 0, base: 0, extents: [] };
      iloc.items.push(loc);
      appendTo(loc, data);
      refs.push({ type: 'cdsc', from: it.id, to: [h.primary] });
      return;
    }
    const loc = iloc.items.find((i) => i.id === item.id);
    if (!loc) throw new MetadataError('Metadata item has no location');
    if (loc.dataRef !== 0 || loc.method > 1) throw new MetadataError('This file stores its metadata in a way that cannot be edited');
    const ranges = itemRanges(loc, h.idatStart, h.bytes.length)!;
    const [lo, hi] = loc.method === 1 ? [h.idatStart, h.idatStart + (idatData?.length ?? 0)] : [0, h.bytes.length];
    const inside = ranges.length === 1 && ranges[0][0] >= lo && ranges[0][1] <= hi;
    if (inside && data.length <= ranges[0][1] - ranges[0][0] && loc.extents[0].length !== 0) {
      // In place; zero-fill the rest of the old extent.
      const [s, e] = ranges[0];
      const fill = new Uint8Array(e - s);
      fill.set(data);
      if (loc.method === 1) idatData!.set(fill, s - h.idatStart);
      else patches.push({ at: s, bytes: fill });
      loc.extents[0].length = data.length;
      return;
    }
    zeroItem(loc);
    appendTo(loc, data);
  };
  let nextId = Math.max(0, ...h.items.map((i) => i.id), ...h.iloc.items.map((i) => i.id), ...entityGroupIds(h.meta)) + 1;
  const newId = () => nextId++;
  const exifItem = primaryMetaItem(h, isExifItem);
  const xmpItem = primaryMetaItem(h, isXmpItem);
  setPayload(exifItem, plan.exif, () => {
    const id = newId();
    return { id, type: 'Exif', name: '', hidden: true, raw: infePayload(id, 'Exif') };
  });
  setPayload(xmpItem, plan.xmp, () => {
    const id = newId();
    return { id, type: 'mime', name: '', contentType: XMP_MIME, hidden: true, raw: infePayload(id, 'mime', XMP_MIME) };
  });
  for (const id of plan.removeItems) removeItem(id);

  if (plan.dropIcc) {
    const drop = new Set(props.map((p, i) => (isIccColr(p) ? i + 1 : 0)).filter(Boolean));
    if (drop.size) {
      const remap = new Map<number, number>();
      let n = 0;
      props.forEach((_, i) => {
        if (!drop.has(i + 1)) remap.set(i + 1, ++n);
      });
      props = props.filter((_, i) => !drop.has(i + 1));
      for (const [id, list] of assoc)
        assoc.set(
          id,
          list.filter((a) => !drop.has(a.index)).map((a) => ({ ...a, index: remap.get(a.index) ?? a.index })),
        );
    }
  }

  // ---- new meta box (iloc offsets are filled in after layout)
  const fileBound = h.bytes.length + appendSize + 65536;
  fitIloc(iloc, fileBound);
  const ilocNode: BoxNode = { type: 'iloc', data: serializeIloc(iloc) };
  const children: BoxNode[] = [];
  for (const c of h.meta.children ?? []) {
    if (c.type === 'hdlr' && plan.clean) {
      const hdlr = { ...c };
      blankHandlerName(hdlr);
      children.push(hdlr);
    } else if (c.type === 'iinf') children.push(iinfBox(h.iinfVersion, items));
    else if (c.type === 'iloc') children.push(ilocNode);
    else if (c.type === 'iref') {
      if (refs.length) children.push(irefBox(h.irefVersion, refs));
    } else if (c.type === 'idat' && idatData) children.push({ type: 'idat', data: idatData });
    else if (c.type === 'iprp') {
      const kids = (c.children ?? []).map((k) =>
        k.type === 'ipco' ? { ...k, children: props } : k.type === 'ipma' && k === child(c, 'ipma') ? ipmaBox(h.ipmaVersion, h.ipmaFlags, assoc) : k,
      );
      children.push({ ...c, children: kids });
    } else children.push(c);
  }
  if (refs.length && !child(h.meta, 'iref')) {
    const at = children.findIndex((c) => c.type === 'iinf');
    children.splice(at + 1, 0, irefBox(0, refs));
  }
  const meta: BoxNode = { ...h.meta, children };

  // ---- image sequences: chunk offsets move too
  const { moovBox, moov } = h;
  if (moov) {
    if (plan.dates) applyHeaderDateEdits(moov, plan.dates, 'heif', G_DATES);
    if (plan.clean) {
      removeChildren(moov, (c) => c.type === 'udta' || c.type === 'meta');
      for (const trak of childrenOf(moov, 'trak')) removeChildren(trak, (c) => c.type === 'udta' || c.type === 'meta');
      zeroHeaderDates(moov);
      scrubTrackFingerprints(moov);
    }
  }

  // ---- layout
  for (const [s, e] of unionRanges(zeroIdat)) idatData!.fill(0, s, e);
  const zeros = unionRanges(zeroFile).map(([at, e]): Patch => ({ at, bytes: new Uint8Array(e - at) }));
  const merged = mergePatches([...zeros, ...patches]);
  const pieces: Piece[] = [];
  const kept = h.top.filter((b) => !plan.removeTop.has(b));
  const last = kept[kept.length - 1];
  for (const b of kept) {
    if (b === h.metaBox) {
      pieces.push({ node: meta });
      continue;
    }
    if (b === moovBox && moov) {
      pieces.push({ node: moov });
      continue;
    }
    let pos = b.start;
    if (b.toEnd && b === last && appendSize) {
      // "extends to end of file" no longer holds once data is appended.
      if (b.size > 0xffffffff || b.headerSize !== 8) throw new MetadataError('Cannot append metadata to this file layout');
      pieces.push({ bytes: boxHeader(b.type, b.size), mirror: b.start });
      pos = b.start + 8;
    }
    for (const p of merged) {
      if (p.at < pos || p.at >= b.end) continue;
      if (p.at > pos) pieces.push({ copy: [pos, p.at] });
      pieces.push({ bytes: p.bytes, mirror: p.at });
      pos = p.at + p.bytes.length;
    }
    if (pos < b.end) pieces.push({ copy: [pos, b.end] });
  }
  let mdatStart = -1;
  if (appendSize) {
    mdatStart = totalSize(pieces);
    const w = new Writer(false, appendSize + 8);
    w.u32(appendSize + 8).ascii('mdat');
    for (const a of appended) w.bytes(a.data);
    pieces.push({ bytes: w.finish() });
  }
  if (h.trailing !== null && !plan.dropTrailing) pieces.push({ copy: [h.trailing, h.bytes.length] });

  const relocate = relocator(pieces);
  const fresh = new Set(appended.map((a) => a.loc));
  const movable: Iloc = { ...iloc, items: iloc.items.filter((i) => !fresh.has(i)) };
  relocateIloc(movable, relocate);
  for (const a of appended) {
    const at = mdatStart + 8 + a.offset;
    // Tables without an offset field locate items by base_offset alone.
    if (iloc.offsetSize === 0) a.loc.base = at;
    a.loc.extents = [{ index: 0, offset: iloc.offsetSize === 0 ? 0 : at, length: a.data.length }];
  }
  const final = serializeIloc(iloc);
  if (final.length !== ilocNode.data!.length) throw new MetadataError('Internal error: item location table changed size');
  ilocNode.data = final;
  if (moov) patchChunkOffsets(moov, relocate);
  return assemble(src, pieces, formatOf(h).mime);
}

function exifPlan(h: Heif, edits: Edits, plan: Plan): void {
  if (edits.get(groupKey('exif'))?.op === 'remove') {
    plan.exif = null;
    return;
  }
  if (![...edits.keys()].some((k) => k.startsWith('exif:'))) return;
  const cur = exifOf(h);
  if (cur.error) throw new MetadataError(cur.error);
  const d = cur.data ?? emptyExif(false);
  applyExifEdits(d, edits);
  const original = cur.item ? itemData(h, cur.item.id) : null;
  plan.exif = isEmptyExif(d) ? null : exifPayload(d, original);
}

function xmpPlan(h: Heif, edits: Edits, plan: Plan): void {
  if (edits.get(groupKey('xmp'))?.op === 'remove') {
    plan.xmp = null;
    return;
  }
  if (![...edits.keys()].some((k) => k.startsWith('xmp:'))) return;
  const cur = xmpOf(h);
  if (cur.error) throw new MetadataError(cur.error);
  const p = cur.data ?? { props: [] };
  applyXmpEdits(p, edits);
  const loc = cur.item ? locOf(h, cur.item.id) : undefined;
  const room = loc?.extents.length === 1 ? loc.extents[0].length : 0;
  plan.xmp = p.props.length ? xmpBytes(p, room) : null;
}

/** Serialized packet; padded with whitespace to exactly `room` bytes when it fits (in-place update). */
function xmpBytes(p: XmpPacket, room: number): Uint8Array {
  const tight = serializeXmp(p, { padding: 0 });
  const len = encodeUtf8(tight).length;
  if (len > room) return encodeUtf8(serializeXmp(p, { padding: 512 }));
  const at = tight.lastIndexOf('<?xpacket end');
  const fill = Array.from({ length: room - len }, (_, k) => (k % 100 === 99 ? '\n' : ' ')).join('');
  return encodeUtf8(tight.slice(0, at) + fill + tight.slice(at));
}

export async function writeHeif(src: Source, edits: Edits): Promise<Blob> {
  const h = await loadHeif(src);
  const plan = newPlan();
  exifPlan(h, edits, plan);
  xmpPlan(h, edits, plan);
  if (edits.get('heif:icc')?.op === 'remove') plan.dropIcc = true;
  if (edits.get('heif:trailer')?.op === 'remove') plan.dropTrailing = true;
  plan.dates = edits;
  for (const [id, e] of edits) {
    if (e.op !== 'remove') continue;
    const m = /^heif:item:(\d+)$/.exec(id);
    if (m && h.items.some((i) => i.id === +m[1] && isMetaItem(i))) plan.removeItems.add(+m[1]);
    const b = /^heif:box:(\d+)$/.exec(id);
    if (b) {
      const box = h.top.find((x) => x.start === +b[1]);
      if (box && !ESSENTIAL_TOP.has(box.type)) plan.removeTop.add(box);
    }
  }
  return rebuild(src, h, plan);
}

export async function stripHeif(src: Source, opts: StripOptions): Promise<Blob> {
  const h = await loadHeif(src);
  const plan = newPlan();
  plan.exif = null;
  plan.xmp = null;
  for (const it of h.items) if (isMetaItem(it) && !keptByStrip(h, it)) plan.removeItems.add(it.id);
  plan.dropIcc = !opts.keepColorProfile;
  for (const b of h.top) if (!ESSENTIAL_TOP.has(b.type)) plan.removeTop.add(b);
  plan.dropTrailing = true;
  plan.clean = true;
  return rebuild(src, h, plan);
}

// ---------------------------------------------------------------- detect

export const heifHandler: FormatHandler = {
  id: 'heif',
  name: 'HEIF image',
  category: 'image',
  extensions: ['heic', 'heif', 'hif', 'avif', 'heics', 'heifs', 'avifs'],
  mime: 'image/heif',
  detect(ctx: DetectContext) {
    const ftyp = sniffFtyp(ctx.head);
    if (ftyp && (HEIF_BRANDS.has(ftyp.major) || (ftyp.compatible.includes('mif1') && !/^(iso|mp4|qt|M4)/.test(ftyp.major)))) {
      return sniffTopTypes(ctx.head).includes('meta') ? 3 : 1;
    }
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readHeif,
  write: writeHeif,
  strip: stripHeif,
};
