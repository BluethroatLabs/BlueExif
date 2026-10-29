/**
 * GIF: comment extensions, XMP ("XMP DataXMP" application extension with its
 * 258-byte magic trailer), ICC profile ("ICCRGBG1012"), other application and
 * plain-text extensions, and data after the GIF trailer.
 *
 * Writing rebuilds the block stream: the header, colour tables, graphic
 * control extensions and image blocks are copied verbatim.
 */

import { Reader, Writer, concat, encodeLatin1, encodeUtf8, formatBytes, latin1, startsWith, toBlob, utf8OrLatin1 } from '../core/binary';
import { asText, fmtNum, makeField, rawField } from '../core/fields';
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
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';

const EXT = 0x21;
const IMAGE = 0x2c;
const TRAILER = 0x3b;
const L_PLAIN = 0x01;
const L_GCE = 0xf9;
const L_COMMENT = 0xfe;
const L_APP = 0xff;

const APP_XMP = 'XMP DataXMP';
const APP_ICC = 'ICCRGBG1012';
const LOOP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/** Own-property lookup: keys come from file contents ("constructor", "__proto__"…). */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** 0x01, 0xFF…0x00, block terminator: lets XMP-unaware readers skip raw XMP bytes as sub-blocks. */
const XMP_MAGIC = (() => {
  const m = new Uint8Array(258);
  m[0] = 0x01;
  for (let i = 1; i <= 256; i++) m[i] = 256 - i;
  return m;
})();

const APP_LABELS: Record<string, string> = {
  MGK8BIM0000: 'Photoshop resources (ImageMagick)',
  MGKIPTC0000: 'IPTC data (ImageMagick)',
  MGKICCRGB10: 'Color profile (ImageMagick)',
};

interface Block {
  /** EXT (with `label`) or IMAGE */
  type: number;
  label: number;
  start: number;
  end: number;
  /** application identifier + authentication code (11 chars) */
  app?: string;
  /** offset just after the application identifier sub-block */
  bodyStart?: number;
}

interface Gif {
  bytes: Uint8Array;
  version: string;
  width: number;
  height: number;
  /** end of header + logical screen descriptor + global colour table */
  headerEnd: number;
  globalColors: number;
  blocks: Block[];
  hasTrailer: boolean;
  /** bytes after the trailer (or unparseable bytes after the last block) */
  trailer: Uint8Array;
}

export function parseGif(bytes: Uint8Array): Gif {
  if (!startsWith(bytes, 'GIF87a') && !startsWith(bytes, 'GIF89a')) throw new MetadataError('Not a GIF file');
  if (bytes.length < 13) throw new MetadataError('Truncated GIF header');
  const r = new Reader(bytes, true);
  const packed = bytes[10];
  const globalColors = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
  const headerEnd = 13 + 3 * globalColors;
  if (headerEnd > bytes.length) throw new MetadataError('Truncated GIF color table');
  const skipSubBlocks = (q: number): number => {
    for (;;) {
      if (q >= bytes.length) throw new MetadataError('Truncated GIF: a data block runs past the end of the file');
      const n = bytes[q];
      q += 1 + n;
      if (n === 0) return q;
    }
  };
  const blocks: Block[] = [];
  let p = headerEnd;
  let hasTrailer = false;
  while (p < bytes.length) {
    const t = bytes[p];
    if (t === TRAILER) {
      hasTrailer = true;
      p++;
      break;
    }
    if (t === EXT) {
      if (p + 2 > bytes.length) throw new MetadataError('Truncated GIF extension');
      const label = bytes[p + 1];
      const b: Block = { type: EXT, label, start: p, end: 0 };
      if (label === L_APP && bytes[p + 2] === 11 && p + 14 <= bytes.length) {
        b.app = latin1(bytes.subarray(p + 3, p + 14));
        b.bodyStart = p + 14;
      }
      b.end = skipSubBlocks(p + 2);
      blocks.push(b);
      p = b.end;
      continue;
    }
    if (t === IMAGE) {
      if (p + 10 > bytes.length) throw new MetadataError('Truncated GIF image descriptor');
      const ip = bytes[p + 9];
      const lct = ip & 0x80 ? 3 * (1 << ((ip & 7) + 1)) : 0;
      const end = skipSubBlocks(p + 10 + lct + 1);
      blocks.push({ type: IMAGE, label: 0, start: p, end });
      p = end;
      continue;
    }
    break; // garbage: kept as trailing data
  }
  return {
    bytes,
    version: latin1(bytes.subarray(3, 6)),
    width: r.u16(6),
    height: r.u16(8),
    headerEnd,
    globalColors,
    blocks,
    hasTrailer,
    trailer: bytes.subarray(p),
  };
}

/** Concatenated sub-block payload starting at `q`. */
function subBlockData(bytes: Uint8Array, q: number): Uint8Array {
  const parts: Uint8Array[] = [];
  while (q < bytes.length && bytes[q]) {
    parts.push(bytes.subarray(q + 1, q + 1 + bytes[q]));
    q += 1 + bytes[q];
  }
  return concat(parts);
}

function subBlocks(data: Uint8Array): Uint8Array {
  const w = new Writer(true, data.length + data.length / 255 + 2);
  for (let i = 0; i < data.length; i += 255) {
    const s = data.subarray(i, i + 255);
    w.u8(s.length).bytes(s);
  }
  return w.u8(0).finish();
}

const blockData = (g: Gif, b: Block) => subBlockData(g.bytes, b.bodyStart ?? b.start + 2);

function commentText(g: Gif, b: Block): string {
  return utf8OrLatin1(blockData(g, b)).replace(/\0+$/, '');
}

function xmpOf(g: Gif): { data: XmpPacket | null; error?: string } {
  const b = g.blocks.find((x) => x.app === APP_XMP);
  if (!b) return { data: null };
  const body = g.bytes.subarray(b.bodyStart!, b.end);
  const tail = body.length - XMP_MAGIC.length;
  const raw = tail >= 0 && body.subarray(tail).every((v, i) => v === XMP_MAGIC[i]) ? body.subarray(0, tail) : null;
  if (!raw) return { data: null, error: 'XMP could not be parsed: missing GIF magic trailer' };
  try {
    return { data: parseXmp(utf8OrLatin1(raw)) };
  } catch (e) {
    return { data: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

const COMMENT_SPEC = { label: 'Comment', kind: 'multiline' as const, sensitivity: 'content' as const, tag: 'Comment extension' };

export async function readGif(src: Source): Promise<Metadata> {
  const g = parseGif(await src.bytes());
  const warnings: string[] = [];
  const info: InfoItem[] = [];
  const groups: FieldGroup[] = [];
  if (!g.hasTrailer) warnings.push('The file has no GIF trailer (it may be truncated)');

  const frames = g.blocks.filter((b) => b.type === IMAGE).length;
  info.push({ label: 'Dimensions', value: `${g.width} × ${g.height}` });
  info.push({ label: 'Version', value: `GIF${g.version}` });
  if (g.globalColors) info.push({ label: 'Global palette', value: `${g.globalColors} colors` });
  info.push({ label: 'Frames', value: String(frames) });
  const loop = g.blocks.find((b) => b.app && LOOP_APPS.has(b.app));
  if (loop) {
    const d = blockData(g, loop);
    if (d.length >= 3 && d[0] === 1) {
      const n = d[1] | (d[2] << 8);
      info.push({ label: 'Loop', value: n ? `${n} time${n > 1 ? 's' : ''}` : 'Forever' });
    }
  }
  if (frames > 1) {
    const delay = g.blocks
      .filter((b) => b.type === EXT && b.label === L_GCE)
      .reduce((n, b) => {
        const d = blockData(g, b);
        return n + (d.length >= 3 ? d[1] | (d[2] << 8) : 0);
      }, 0);
    info.push({ label: 'Duration', value: `${fmtNum(delay / 100, 2)} s` });
  }

  const xmp = xmpOf(g);
  if (xmp.error) warnings.push(xmp.error);
  groups.push(...xmpGroups(xmp.data ?? { props: [] }, { addable: true }));

  const comments: Field[] = g.blocks
    .filter((b) => b.type === EXT && b.label === L_COMMENT)
    .map((b, i) => makeField({ id: `gif:comment:${i}`, ...COMMENT_SPEC }, commentText(g, b)));
  groups.push({
    id: 'gif.comments',
    label: 'Comments',
    source: 'GIF',
    fields: comments,
    addable: [{ id: 'gif:comment:new', ...COMMENT_SPEC }],
    removable: true,
  });

  const other: Field[] = [];
  g.blocks.forEach((b, i) => {
    if (b.type !== EXT || b.label === L_GCE || b.label === L_COMMENT) return;
    if (b.label === L_PLAIN) {
      const text = latin1(subBlockData(g.bytes, b.start + 2 + 13)).replace(/[^\x20-\x7e\xa0-\xff\n]/g, '');
      other.push(rawField(`gif:plaintext:${i}`, 'Plain text overlay', text || '(empty)', { tag: 'Plain text extension', sensitivity: 'content' }));
      return;
    }
    if (b.app === APP_XMP || (b.app && LOOP_APPS.has(b.app))) return;
    if (b.app === APP_ICC) {
      const icc = blockData(g, b);
      const desc = iccDescription(icc);
      info.push({ label: 'Color profile', value: desc ?? 'Embedded ICC profile' });
      other.push(
        rawField('gif:icc', 'Color profile (ICC)', `${desc ?? 'ICC profile'} — ${formatBytes(icc.length)}`, {
          tag: `Application extension “${APP_ICC}”`,
          description: 'Removing the color profile can make colors look different.',
        }),
      );
      return;
    }
    const size = formatBytes(b.end - b.start);
    if (b.app !== undefined) {
      const label = own(APP_LABELS, b.app) ?? `Application data “${b.app.replace(/[^\x20-\x7e]/g, '?')}”`;
      other.push(rawField(`gif:app:${i}`, label, size, { tag: 'Application extension', sensitivity: 'content' }));
    } else {
      other.push(rawField(`gif:ext:${i}`, `Extension 0x${b.label.toString(16).padStart(2, '0')}`, size, { tag: 'Extension block', sensitivity: 'content' }));
    }
  });
  if (g.trailer.length > 16 || g.trailer.some((b) => b !== 0)) {
    other.push(rawField('gif:trailer', 'Data after image', `${formatBytes(g.trailer.length)} after the end of the image`, { tag: 'after trailer', sensitivity: 'content' }));
  }
  if (other.length) groups.push({ id: 'gif.other', label: 'Embedded data', source: 'GIF', fields: other });

  return {
    format: { id: 'gif', name: frames > 1 ? 'Animated GIF' : 'GIF image', mime: 'image/gif', category: 'image' },
    info,
    groups: groups.filter((x) => x.fields.length || x.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ---------------------------------------------------------------- writing

interface Plan {
  /** block index -> new comment text ('' or null = drop) */
  comments: Map<number, string | null>;
  newComments: string[];
  /** undefined = keep, null = remove */
  xmp?: XmpPacket | null;
  drop: Set<number>;
  dropTrailer: boolean;
}

function commentBlock(text: string): Uint8Array {
  return concat([new Uint8Array([EXT, L_COMMENT]), subBlocks(encodeUtf8(text))]);
}

function xmpBlock(p: XmpPacket): Uint8Array {
  const head = new Uint8Array([EXT, L_APP, 11, ...encodeLatin1(APP_XMP)]);
  return concat([head, encodeUtf8(serializeXmp(p, { padding: 0 })), XMP_MAGIC]);
}

function assemble(g: Gif, plan: Plan): Blob {
  const xmp = plan.xmp === undefined ? undefined : plan.xmp && plan.xmp.props.length ? xmpBlock(plan.xmp) : null;
  const out: Uint8Array[] = [g.bytes.slice(0, g.headerEnd)];
  let hasExt = false;
  const emit = (b: Uint8Array) => {
    out.push(b);
    if (b[0] === EXT) hasExt = true;
  };
  let xmpPlaced = false;
  let commentsPlaced = false;
  const placeXmp = () => {
    if (!xmpPlaced && xmp) emit(xmp);
    xmpPlaced = true;
  };
  const placeComments = () => {
    if (!commentsPlaced) for (const c of plan.newComments) if (c) emit(commentBlock(c));
    commentsPlaced = true;
  };
  // New XMP goes after the leading application extensions (NETSCAPE loop,
  // ICC…), ahead of the first frame; new comments follow the existing ones.
  const firstFrame = g.blocks.findIndex((b) => b.type === IMAGE || b.label === L_GCE || b.label === L_PLAIN);
  const lastComment = g.blocks.reduce((n, b, i) => (b.type === EXT && b.label === L_COMMENT ? i : n), -1);
  g.blocks.forEach((b, i) => {
    if (i === firstFrame) {
      placeXmp();
      if (lastComment < firstFrame) placeComments();
    }
    if (lastComment >= 0 && i === lastComment + 1) placeComments();
    if (plan.drop.has(i)) return;
    if (b.app === APP_XMP && xmp !== undefined) return placeXmp();
    if (b.type === EXT && b.label === L_COMMENT && plan.comments.has(i)) {
      const c = plan.comments.get(i);
      if (c) emit(commentBlock(c));
      return;
    }
    emit(g.bytes.subarray(b.start, b.end));
  });
  placeXmp();
  placeComments();
  out.push(new Uint8Array([TRAILER]));
  if (!plan.dropTrailer && g.trailer.length) out.push(g.trailer);
  // Extension blocks require GIF89a.
  if (g.version === '87a' && hasExt) out[0][4] = 0x39;
  return toBlob(out, 'image/gif');
}

export async function writeGif(src: Source, edits: Edits): Promise<Blob> {
  const g = parseGif(await src.bytes());
  const plan: Plan = { comments: new Map(), newComments: [], drop: new Set(), dropTrailer: false };

  if (edits.get(groupKey('xmp'))?.op === 'remove') plan.xmp = null;
  else if ([...edits.keys()].some((k) => k.startsWith('xmp:'))) {
    const cur = xmpOf(g);
    if (cur.error && g.blocks.some((b) => b.app === APP_XMP)) throw new MetadataError(cur.error);
    const p = cur.data ?? { props: [] };
    applyXmpEdits(p, edits);
    plan.xmp = p;
  }

  const commentIdx = g.blocks.flatMap((b, i) => (b.type === EXT && b.label === L_COMMENT ? [i] : []));
  if (edits.get(groupKey('gif.comments'))?.op === 'remove') for (const i of commentIdx) plan.comments.set(i, null);
  for (const [id, e] of edits) {
    const m = /^gif:comment:(\d+|new)$/.exec(id);
    if (m) {
      if (m[1] === 'new') {
        if (e.op === 'set') plan.newComments.push(asText(e.value, 'Comment'));
      } else if (+m[1] < commentIdx.length) {
        plan.comments.set(commentIdx[+m[1]], e.op === 'remove' ? null : asText(e.value, 'Comment'));
      }
      continue;
    }
    if (e.op !== 'remove') continue;
    if (id === 'gif:trailer') plan.dropTrailer = true;
    else if (id === 'gif:icc') g.blocks.forEach((b, i) => b.app === APP_ICC && plan.drop.add(i));
    else {
      const r = /^gif:(app|plaintext|ext):(\d+)$/.exec(id);
      const b = r ? g.blocks[+r[2]] : undefined;
      if (b && b.type === EXT && b.label !== L_GCE && b.app !== APP_XMP && !(b.app && LOOP_APPS.has(b.app))) plan.drop.add(+r![2]);
    }
  }
  return assemble(g, plan);
}

export async function stripGif(src: Source, opts: StripOptions): Promise<Blob> {
  const g = parseGif(await src.bytes());
  const plan: Plan = { comments: new Map(), newComments: [], xmp: null, drop: new Set(), dropTrailer: true };
  g.blocks.forEach((b, i) => {
    if (b.type !== EXT || b.label === L_GCE) return;
    if (b.app && LOOP_APPS.has(b.app)) return;
    if (b.app === APP_ICC && opts.keepColorProfile) return;
    plan.drop.add(i);
  });
  return assemble(g, plan);
}

export const gifHandler: FormatHandler = {
  id: 'gif',
  name: 'GIF image',
  category: 'image',
  extensions: ['gif'],
  mime: 'image/gif',
  detect(ctx: DetectContext) {
    if (startsWith(ctx.head, 'GIF87a') || startsWith(ctx.head, 'GIF89a')) return 3;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readGif,
  write: writeGif,
  strip: stripGif,
};
