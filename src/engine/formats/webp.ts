/**
 * WebP (RIFF "WEBP"): EXIF, XMP and ICCP chunks of the extended format,
 * animation (ANIM/ANMF), alpha (ALPH), unknown chunks and data after the RIFF
 * container.
 *
 * Image chunks are copied verbatim. Adding EXIF/XMP to a simple (VP8/VP8L
 * only) file converts it to the extended format with a VP8X header whose
 * canvas size comes from the bitstream; VP8X flags are recomputed on every
 * write, and a VP8X that no longer carries anything is dropped again.
 */

import { Reader, Writer, encodeLatin1, encodeUtf8, formatBytes, latin1, startsWith, toBlob, utf8OrLatin1 } from '../core/binary';
import { fmtNum, rawField } from '../core/fields';
import { iccDescription } from '../core/icc';
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
import { applyExifEdits, exifGroups, exifOrientation, orientationOnlyExif } from '../exif/fields';
import { emptyExif, isEmptyExif, parseTiff, writeTiff, type ExifData } from '../exif/tiff';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';

const F_ICC = 0x20;
const F_ALPHA = 0x10;
const F_EXIF = 0x08;
const F_XMP = 0x04;
const F_ANIM = 0x02;

/** Chunks that make up the image itself (never removed). */
const IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);
const KNOWN_CHUNKS = new Set([...IMAGE_CHUNKS, 'VP8X', 'ICCP', 'EXIF', 'XMP ']);

interface RiffChunk {
  id: string;
  data: Uint8Array;
}

interface Webp {
  chunks: RiffChunk[];
  /** bytes after the RIFF container */
  trailer: Uint8Array;
  truncated: boolean;
}

export function parseWebp(bytes: Uint8Array): Webp {
  if (!startsWith(bytes, 'RIFF') || !startsWith(bytes, 'WEBP', 8)) throw new MetadataError('Not a WebP file');
  const r = new Reader(bytes, true);
  let end = 8 + r.u32(4);
  const truncated = end > bytes.length;
  if (truncated) end = bytes.length;
  const chunks: RiffChunk[] = [];
  let p = 12;
  while (p + 8 <= end) {
    const id = r.fourcc(p);
    const size = r.u32(p + 4);
    if (p + 8 + size > end) throw new MetadataError(`Truncated WebP: chunk “${id.trim()}” runs past the end of the file`);
    chunks.push({ id, data: bytes.subarray(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  if (!chunks.length) throw new MetadataError('WebP file contains no image');
  return { chunks, trailer: bytes.subarray(Math.max(end, Math.min(p, bytes.length))), truncated };
}

// ------------------------------------------------------------- bitstreams

interface Bitstream {
  width: number;
  height: number;
  lossless: boolean;
  alpha: boolean;
}

function bitstreamInfo(c: RiffChunk): Bitstream | null {
  const d = c.data;
  if (c.id === 'VP8 ' && d.length >= 10 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a) {
    const r = new Reader(d, true);
    return { width: r.u16(6) & 0x3fff, height: r.u16(8) & 0x3fff, lossless: false, alpha: false };
  }
  if (c.id === 'VP8L' && d.length >= 5 && d[0] === 0x2f) {
    const bits = new Reader(d, true).u32(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, lossless: true, alpha: ((bits >>> 28) & 1) === 1 };
  }
  return null;
}

/** First image bitstream of the file (or of the first animation frame). */
function firstBitstream(w: Webp): Bitstream | null {
  for (const c of w.chunks) {
    const b = bitstreamInfo(c);
    if (b) return { ...b, alpha: b.alpha || w.chunks.some((x) => x.id === 'ALPH') };
  }
  return null;
}

interface Frame {
  duration: number;
  lossless: boolean;
}

/** ANMF payload: 16-byte frame header followed by ALPH/VP8/VP8L sub-chunks. */
function animFrames(w: Webp): Frame[] {
  return w.chunks
    .filter((c) => c.id === 'ANMF' && c.data.length >= 24)
    .map((c) => {
      const r = new Reader(c.data, true);
      return { duration: r.u24(12), lossless: latin1(c.data.subarray(16, 20)) === 'VP8L' };
    });
}

// ------------------------------------------------------------- extraction

const stripExifHeader = (b: Uint8Array) => (startsWith(b, 'Exif\0\0') ? b.subarray(6) : b);

function exifOf(w: Webp): { data: ExifData | null; error?: string } {
  const c = w.chunks.find((x) => x.id === 'EXIF');
  if (!c) return { data: null };
  try {
    return { data: parseTiff(stripExifHeader(c.data)) };
  } catch (e) {
    return { data: null, error: `EXIF could not be parsed: ${(e as Error).message}` };
  }
}

function xmpOf(w: Webp): { data: XmpPacket | null; error?: string } {
  const c = w.chunks.find((x) => x.id === 'XMP ');
  if (!c) return { data: null };
  try {
    return { data: parseXmp(utf8OrLatin1(c.data)) };
  } catch (e) {
    return { data: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

const chunkName = (id: string) => `“${id.trim() || id}”`;

export async function readWebp(src: Source): Promise<Metadata> {
  const w = parseWebp(await src.bytes());
  const warnings: string[] = [];
  const info: InfoItem[] = [];
  const groups: FieldGroup[] = [];
  if (w.truncated) warnings.push('The file is truncated');

  const vp8x = w.chunks.find((c) => c.id === 'VP8X');
  const bs = firstBitstream(w);
  const frames = animFrames(w);
  if (vp8x && vp8x.data.length >= 10) {
    const r = new Reader(vp8x.data, true);
    info.push({ label: 'Dimensions', value: `${r.u24(4) + 1} × ${r.u24(7) + 1}` });
  } else if (bs) info.push({ label: 'Dimensions', value: `${bs.width} × ${bs.height}` });
  if (frames.length) {
    const kinds = new Set(frames.map((f) => (f.lossless ? 'Lossless' : 'Lossy')));
    info.push({ label: 'Compression', value: kinds.size > 1 ? 'Mixed lossy / lossless' : [...kinds][0] });
  } else if (bs) info.push({ label: 'Compression', value: bs.lossless ? 'Lossless (VP8L)' : 'Lossy (VP8)' });
  const alpha = vp8x ? (vp8x.data[0] & F_ALPHA) !== 0 : !!bs?.alpha;
  info.push({ label: 'Transparency', value: alpha ? 'Yes' : 'No' });
  if (frames.length) {
    info.push({ label: 'Frames', value: String(frames.length) });
    const total = frames.reduce((n, f) => n + f.duration, 0);
    info.push({ label: 'Duration', value: `${fmtNum(total / 1000, 2)} s` });
    const anim = w.chunks.find((c) => c.id === 'ANIM');
    if (anim && anim.data.length >= 6) {
      const loops = new Reader(anim.data, true).u16(4);
      info.push({ label: 'Loop', value: loops ? `${loops} time${loops > 1 ? 's' : ''}` : 'Forever' });
    }
  }

  const exif = exifOf(w);
  if (exif.error) warnings.push(exif.error);
  if (exif.data) warnings.push(...exif.data.warnings.map((x) => `EXIF: ${x}`));
  groups.push(...exifGroups(exif.data ?? emptyExif(), { addable: true }));

  const xmp = xmpOf(w);
  if (xmp.error) warnings.push(xmp.error);
  groups.push(...xmpGroups(xmp.data ?? { props: [] }, { addable: true }));

  const other: Field[] = [];
  const icc = w.chunks.find((c) => c.id === 'ICCP');
  if (icc) {
    const desc = iccDescription(icc.data);
    info.push({ label: 'Color profile', value: desc ?? 'Embedded ICC profile' });
    other.push(
      rawField('webp:iccp', 'Color profile (ICC)', `${desc ?? 'ICC profile'} — ${formatBytes(icc.data.length)}`, {
        tag: 'ICCP',
        description: 'Removing the color profile can make colors look different.',
      }),
    );
  }
  w.chunks.forEach((c, i) => {
    if (KNOWN_CHUNKS.has(c.id)) return;
    other.push(rawField(`webp:chunk:${i}`, `Private chunk ${chunkName(c.id)}`, formatBytes(c.data.length), { tag: c.id, sensitivity: 'content' }));
  });
  if (w.trailer.length > 16 || w.trailer.some((b) => b !== 0)) {
    other.push(
      rawField('webp:trailer', 'Data after image', `${formatBytes(w.trailer.length)} after the end of the image`, {
        tag: 'after RIFF',
        sensitivity: 'content',
      }),
    );
  }
  if (other.length) groups.push({ id: 'webp.other', label: 'Embedded data', source: 'WebP', fields: other });

  return {
    format: { id: 'webp', name: frames.length ? 'Animated WebP' : 'WebP image', mime: 'image/webp', category: 'image' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ---------------------------------------------------------------- writing

interface Plan {
  /** undefined = keep as is, null = remove */
  exif?: ExifData | null;
  xmp?: XmpPacket | null;
  drop: Set<number>;
  dropTrailer: boolean;
}

function assemble(w: Webp, plan: Plan): Blob {
  const regen = <T>(v: T | null | undefined, make: (x: T) => Uint8Array | null) => (v === undefined ? undefined : v === null ? null : make(v));
  const exifData = regen(plan.exif, (d) => (isEmptyExif(d) ? null : writeTiff(d)));
  const xmpData = regen(plan.xmp, (p) => (p.props.length ? encodeUtf8(serializeXmp(p, { padding: 0 })) : null));

  const out: RiffChunk[] = [];
  const placed = { exif: false, xmp: false };
  const swap = (key: 'exif' | 'xmp', data: Uint8Array | null | undefined, c: RiffChunk) => {
    if (data === undefined) out.push(c);
    else if (!placed[key] && data) out.push({ id: c.id, data });
    placed[key] = data !== undefined || placed[key];
  };
  w.chunks.forEach((c, i) => {
    if (c.id === 'VP8X' || plan.drop.has(i)) return;
    if (c.id === 'EXIF') swap('exif', exifData, c);
    else if (c.id === 'XMP ') swap('xmp', xmpData, c);
    else out.push(c);
  });
  // New EXIF/XMP go after the image data (before trailing unknown chunks).
  let at = 0;
  out.forEach((c, i) => {
    if (IMAGE_CHUNKS.has(c.id) || c.id === 'ICCP' || c.id === 'EXIF') at = i + 1;
  });
  const fresh: RiffChunk[] = [];
  if (!placed.exif && exifData) fresh.push({ id: 'EXIF', data: exifData });
  if (!placed.xmp && xmpData) fresh.push({ id: 'XMP ', data: xmpData });
  out.splice(at, 0, ...fresh);

  // VP8X: keep the original canvas, alpha and animation bits; recompute the rest.
  const orig = w.chunks.find((c) => c.id === 'VP8X');
  const has = (id: string) => out.some((c) => c.id === id);
  let flags: number;
  let header: Uint8Array;
  if (orig && orig.data.length >= 10) {
    header = orig.data.slice();
    flags = header[0] & ~(F_ICC | F_EXIF | F_XMP);
  } else {
    const bs = firstBitstream(w);
    if (!bs) throw new MetadataError('Unsupported WebP bitstream: image size not found');
    const wr = new Writer(true, 10);
    wr.u32(0)
      .u24(bs.width - 1)
      .u24(bs.height - 1);
    header = wr.finish();
    flags = (bs.alpha ? F_ALPHA : 0) | (has('ANIM') ? F_ANIM : 0);
  }
  if (has('ICCP')) flags |= F_ICC;
  if (has('EXIF')) flags |= F_EXIF;
  if (has('XMP ')) flags |= F_XMP;
  header[0] = flags;
  const r = new Reader(header, true);
  const canvas = { width: r.u24(4) + 1, height: r.u24(7) + 1 };
  const bs = out.length === 1 ? bitstreamInfo(out[0]) : null;
  const simple = !(flags & (F_ICC | F_EXIF | F_XMP | F_ANIM)) && !!bs && bs.width === canvas.width && bs.height === canvas.height;
  if (!simple) out.unshift({ id: 'VP8X', data: header });

  let size = 4;
  for (const c of out) size += 8 + c.data.length + (c.data.length & 1);
  const head = new Writer(true, 12);
  head.ascii('RIFF').u32(size).ascii('WEBP');
  const parts: Uint8Array[] = [head.finish()];
  for (const c of out) {
    const h = new Writer(true, 8);
    h.bytes(encodeLatin1(c.id)).u32(c.data.length);
    parts.push(h.finish(), c.data);
    if (c.data.length & 1) parts.push(new Uint8Array(1));
  }
  if (!plan.dropTrailer && w.trailer.length) parts.push(w.trailer);
  return toBlob(parts, 'image/webp');
}

export async function writeWebp(src: Source, edits: Edits): Promise<Blob> {
  const w = parseWebp(await src.bytes());
  const plan: Plan = { drop: new Set(), dropTrailer: false };
  const keys = [...edits.keys()];

  if (edits.get(groupKey('exif'))?.op === 'remove') plan.exif = null;
  else if (keys.some((k) => k.startsWith('exif:'))) {
    const cur = exifOf(w);
    if (cur.error) throw new MetadataError(cur.error);
    const d = cur.data ?? emptyExif(false);
    applyExifEdits(d, edits);
    plan.exif = d;
  }

  if (edits.get(groupKey('xmp'))?.op === 'remove') plan.xmp = null;
  else if (keys.some((k) => k.startsWith('xmp:'))) {
    const cur = xmpOf(w);
    if (cur.error) throw new MetadataError(cur.error);
    const p = cur.data ?? { props: [] };
    applyXmpEdits(p, edits);
    plan.xmp = p;
  }

  for (const [id, e] of edits) {
    if (e.op !== 'remove') continue;
    if (id === 'webp:iccp') w.chunks.forEach((c, i) => c.id === 'ICCP' && plan.drop.add(i));
    else if (id === 'webp:trailer') plan.dropTrailer = true;
    else {
      const m = /^webp:chunk:(\d+)$/.exec(id);
      const c = m ? w.chunks[+m[1]] : undefined;
      if (c && !KNOWN_CHUNKS.has(c.id)) plan.drop.add(+m![1]);
    }
  }
  return assemble(w, plan);
}

export async function stripWebp(src: Source, opts: StripOptions): Promise<Blob> {
  const w = parseWebp(await src.bytes());
  // WebP has no orientation of its own: keep a minimal EXIF when asked.
  const orientation = exifOrientation(exifOf(w).data);
  const plan: Plan = {
    exif: opts.keepOrientation && orientation && orientation !== 1 ? orientationOnlyExif(orientation) : null,
    xmp: null,
    drop: new Set(),
    dropTrailer: true,
  };
  w.chunks.forEach((c, i) => {
    if (!KNOWN_CHUNKS.has(c.id) || (c.id === 'ICCP' && !opts.keepColorProfile)) plan.drop.add(i);
  });
  return assemble(w, plan);
}

export const webpHandler: FormatHandler = {
  id: 'webp',
  name: 'WebP image',
  category: 'image',
  extensions: ['webp'],
  mime: 'image/webp',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if (startsWith(h, 'RIFF') && startsWith(h, 'WEBP', 8)) return startsWith(h, 'VP8', 12) ? 3 : 2;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readWebp,
  write: writeWebp,
  strip: stripWebp,
};
