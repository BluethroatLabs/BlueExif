/**
 * Ogg audio: Vorbis, Opus and FLAC-in-Ogg (Speex/Theora are read-only).
 *
 * Only the header packets of the first logical stream are parsed. Writing
 * rebuilds the comment packet (pictures as base64 METADATA_BLOCK_PICTURE, or
 * PICTURE packets for Ogg FLAC), re-paginates the header pages (first packet
 * alone on page 0, audio starting on a fresh page) and — only when the number
 * of header pages changes — renumbers the following pages and recomputes
 * their CRCs (which requires loading the file). Otherwise the audio pages are
 * carried over untouched with `src.slice()`.
 *
 * Ogg's CRC is not zlib's CRC-32: polynomial 0x04C11DB7, non-reflected,
 * initial value 0, no final XOR.
 */

import { Reader, Writer, base64Encode, concat, formatBytes, latin1, startsWith, toBlob } from '../core/binary';
import { formatDuration, rawField } from '../core/fields';
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
import { BLOCK, blockHeader, parseStreamInfo, streamInfoItems } from './flac';
import {
  applyPictureEdits,
  applyVorbisEdits,
  extractPictures,
  hasVorbisEdits,
  parseFlacPicture,
  parseVorbisComment,
  serializeFlacPicture,
  serializeVorbisComment,
  vorbisGroups,
  type FlacPicture,
  type VorbisComments,
} from './vorbiscomment';

// ------------------------------------------------------------------- CRC

let CRC_TABLE: Uint32Array | null = null;

export function oggCrc(b: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      CRC_TABLE[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = 0; i < b.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return crc;
}

// ----------------------------------------------------------------- pages

interface Page {
  offset: number;
  flags: number;
  /** raw 8-byte granule position */
  granule: Uint8Array;
  serial: number;
  seq: number;
  lacing: Uint8Array;
  body: Uint8Array;
  size: number;
}

const GRANULE_NONE = new Uint8Array(8).fill(0xff);
const GRANULE_ZERO = new Uint8Array(8);

function granuleValue(g: Uint8Array): number | null {
  if (g.every((x) => x === 0xff)) return null;
  return new Reader(g, true).u64(0);
}

async function readPage(src: Source, offset: number): Promise<Page | null> {
  const h = await src.read(offset, 27 + 255);
  if (h.length < 27 || !startsWith(h, 'OggS') || h[4] !== 0) return null;
  const n = h[26];
  if (h.length < 27 + n) return null;
  const lacing = h.slice(27, 27 + n);
  const bodyLen = lacing.reduce((a, b) => a + b, 0);
  const r = new Reader(h, true);
  const body = await src.read(offset + 27 + n, bodyLen);
  if (body.length < bodyLen) return null;
  return { offset, flags: h[5], granule: h.slice(6, 14), serial: r.u32(14), seq: r.u32(18), lacing, body, size: 27 + n + bodyLen };
}

export function buildPage(flags: number, granule: Uint8Array, serial: number, seq: number, lacing: number[] | Uint8Array, body: Uint8Array): Uint8Array {
  const w = new Writer(true, 27 + lacing.length + body.length);
  w.ascii('OggS').u8(0).u8(flags).bytes(granule).u32(serial).u32(seq).u32(0).u8(lacing.length);
  w.bytes(Uint8Array.from(lacing)).bytes(body);
  const page = w.finish();
  new DataView(page.buffer).setUint32(22, oggCrc(page), true);
  return page;
}

/**
 * Lay packets out on pages: the first packet alone (BOS), the rest packed
 * (or each starting on a fresh page with `flushEach`, as libFLAC does), the
 * last page flushed so audio starts on a fresh page.
 */
function paginate(packets: Uint8Array[], serial: number, firstSeq: number, flushEach = false): Uint8Array[] {
  const lace = (len: number) => [...new Array<number>(Math.floor(len / 255)).fill(255), len % 255];
  interface Seg {
    len: number;
    packet: Uint8Array;
    pos: number;
    end: boolean;
  }
  const groups: Seg[][] = [];
  packets.forEach((p, i) => {
    const segs: Seg[] = [];
    let pos = 0;
    const l = lace(p.length);
    l.forEach((len, k) => {
      segs.push({ len, packet: p, pos, end: k === l.length - 1 });
      pos += len;
    });
    if (i === 0) {
      if (segs.length > 255) throw new MetadataError('Ogg identification header too large');
      groups.push(segs);
    } else if (i === 1 || flushEach) groups.push(segs);
    else groups[groups.length - 1].push(...segs);
  });
  const pages: Uint8Array[] = [];
  let seq = firstSeq;
  for (const segs of groups) {
    for (let s = 0; s < segs.length; ) {
      const chunk = segs.slice(s, s + 255);
      const body = concat(chunk.map((c) => c.packet.subarray(c.pos, c.pos + c.len)));
      const flags = (seq === firstSeq ? 0x02 : 0) | (chunk[0].pos > 0 ? 0x01 : 0);
      const granule = chunk.some((c) => c.end) ? GRANULE_ZERO : GRANULE_NONE;
      pages.push(
        buildPage(
          flags,
          granule,
          serial,
          seq++,
          chunk.map((c) => c.len),
          body,
        ),
      );
      s += chunk.length;
    }
  }
  return pages;
}

// --------------------------------------------------------------- streams

type Codec = 'vorbis' | 'opus' | 'flac' | 'speex' | 'theora' | 'unknown';

const CODEC_NAME: Record<Codec, string> = { vorbis: 'Vorbis', opus: 'Opus', flac: 'FLAC', speex: 'Speex', theora: 'Theora', unknown: 'Unknown codec' };

function codecOf(p: Uint8Array): Codec {
  if (startsWith(p, '\x01vorbis')) return 'vorbis';
  if (startsWith(p, 'OpusHead')) return 'opus';
  if (startsWith(p, '\x7fFLAC')) return 'flac';
  if (startsWith(p, 'Speex   ')) return 'speex';
  if (startsWith(p, '\x80theora')) return 'theora';
  return 'unknown';
}

interface OggStream {
  serial: number;
  codec: Codec;
  firstSeq: number;
  /** header packets in order */
  headers: Uint8Array[];
  /** pages of this stream up to and including the one completing the last header */
  headerPages: number;
  /** byte offset after that page */
  headerEnd: number;
  /** the last header page also carries audio segments (rare; forces re-pagination) */
  leftover: { page: Page; firstSeg: number } | null;
  /** other logical streams interleaved with the headers */
  multiplexed: boolean;
}

function headersNeeded(codec: Codec, first: Uint8Array): number {
  switch (codec) {
    case 'vorbis':
    case 'theora':
      return 3;
    case 'opus':
      return 2;
    case 'speex':
      return 2 + (first.length >= 72 ? new Reader(first, true).u32(68) : 0);
    case 'flac': {
      const n = first.length >= 9 ? (first[7] << 8) | first[8] : 0;
      return n ? 1 + n : -1; // -1: until the last-metadata-block flag
    }
    default:
      return 1;
  }
}

const MAX_HEADER_BYTES = 64 * 1024 * 1024;

async function readStream(src: Source): Promise<OggStream> {
  const first = await readPage(src, 0);
  if (!first || !(first.flags & 0x02)) throw new MetadataError('Not an Ogg file (no first page)');
  const serial = first.serial;
  const headers: Uint8Array[] = [];
  let packet: Uint8Array[] = [];
  let needed = 0;
  let headerPages = 0;
  let multiplexed = false;
  let offset = 0;
  let total = 0;
  for (;;) {
    const page = offset === 0 ? first : await readPage(src, offset);
    if (!page) throw new MetadataError('Ogg header pages are truncated or corrupt');
    offset += page.size;
    if (page.serial !== serial) {
      multiplexed = true;
      continue;
    }
    headerPages++;
    total += page.body.length;
    if (total > MAX_HEADER_BYTES) throw new MetadataError('Ogg header packets are unreasonably large');
    let pos = 0;
    for (let i = 0; i < page.lacing.length; i++) {
      const len = page.lacing[i];
      packet.push(page.body.subarray(pos, pos + len));
      pos += len;
      if (len === 255) continue;
      const p = concat(packet);
      packet = [];
      headers.push(p);
      if (headers.length === 1) needed = headersNeeded(codecOf(p), p);
      const done = needed < 0 ? headers.length > 1 && (p[0] & 0x80) !== 0 : headers.length >= needed;
      if (done) {
        const rest = i + 1 < page.lacing.length ? { page, firstSeg: i + 1 } : null;
        return { serial, codec: codecOf(headers[0]), firstSeq: first.seq, headers, headerPages, headerEnd: offset, leftover: rest, multiplexed };
      }
    }
  }
}

/** Granule and serial of the last page (searching the file tail). */
async function lastPage(src: Source): Promise<{ granule: number | null; serial: number } | null> {
  const len = Math.min(src.size, 128 * 1024);
  const tail = await src.read(src.size - len, len);
  for (let p = tail.length - 27; p >= 0; p--) {
    if (tail[p] !== 0x4f || !startsWith(tail, 'OggS', p) || tail[p + 4] !== 0) continue;
    const r = new Reader(tail, true);
    return { granule: granuleValue(tail.subarray(p + 6, p + 14)), serial: r.u32(p + 14) };
  }
  return null;
}

// ------------------------------------------------------------- comments

interface Tags {
  vc: VorbisComments;
  pictures: FlacPicture[];
  /** Opus: binary data after the comments (kept when its first bit is set) */
  extra: Uint8Array;
  /** Ogg FLAC: other metadata block packets (type, data) */
  blocks: Array<{ type: number; data: Uint8Array }>;
}

function tagsOf(s: OggStream): Tags | null {
  const empty = (): VorbisComments => ({ vendor: '', comments: [] });
  switch (s.codec) {
    case 'vorbis': {
      const p = s.headers[1];
      if (!startsWith(p, '\x03vorbis')) throw new MetadataError('Missing Vorbis comment header');
      const vc = parseVorbisComment(p, 7).vc;
      return { vc, pictures: extractPictures(vc), extra: new Uint8Array(0), blocks: [] };
    }
    case 'opus': {
      const p = s.headers[1];
      if (!startsWith(p, 'OpusTags')) throw new MetadataError('Missing OpusTags header');
      const { vc, end } = parseVorbisComment(p, 8);
      const extra = p.subarray(end);
      return { vc, pictures: extractPictures(vc), extra: extra.length && extra[0] & 1 ? extra : new Uint8Array(0), blocks: [] };
    }
    case 'flac': {
      let vc: VorbisComments | null = null;
      const pictures: FlacPicture[] = [];
      const blocks: Tags['blocks'] = [];
      for (const p of s.headers.slice(1)) {
        const type = p[0] & 0x7f;
        const data = p.subarray(4);
        if (type === BLOCK.VORBIS_COMMENT && !vc) vc = parseVorbisComment(data).vc;
        else if (type === BLOCK.PICTURE) {
          try {
            pictures.push(parseFlacPicture(data));
          } catch {
            /* unreadable picture */
          }
        } else if (type !== BLOCK.PADDING) blocks.push({ type, data });
      }
      return { vc: vc ?? empty(), pictures, extra: new Uint8Array(0), blocks };
    }
    case 'speex':
      return { vc: parseVorbisComment(s.headers[1] ?? new Uint8Array(8)).vc, pictures: [], extra: new Uint8Array(0), blocks: [] };
    case 'theora': {
      const p = s.headers[1];
      return p && startsWith(p, '\x81theora') ? { vc: parseVorbisComment(p, 7).vc, pictures: [], extra: new Uint8Array(0), blocks: [] } : null;
    }
    default:
      return null;
  }
}

function withPictures(vc: VorbisComments, pics: FlacPicture[]): VorbisComments {
  return {
    vendor: vc.vendor,
    comments: [...vc.comments, ...pics.map((p) => ({ key: 'METADATA_BLOCK_PICTURE', value: base64Encode(serializeFlacPicture(p)) }))],
  };
}

/** New header packets for the edited tags. */
function headerPackets(s: OggStream, t: Tags): Uint8Array[] {
  switch (s.codec) {
    case 'vorbis':
      return [s.headers[0], concat([encodeAscii('\x03vorbis'), serializeVorbisComment(withPictures(t.vc, t.pictures)), new Uint8Array([1])]), s.headers[2]];
    case 'opus':
      return [s.headers[0], concat([encodeAscii('OpusTags'), serializeVorbisComment(withPictures(t.vc, t.pictures)), t.extra])];
    case 'flac': {
      const rest: Array<{ type: number; data: Uint8Array }> = [
        { type: BLOCK.VORBIS_COMMENT, data: serializeVorbisComment(t.vc) },
        ...t.pictures.map((p) => ({ type: BLOCK.PICTURE, data: serializeFlacPicture(p) })),
        ...t.blocks,
      ];
      const first = s.headers[0].slice();
      first[7] = (rest.length >> 8) & 0xff;
      first[8] = rest.length & 0xff;
      first[13] &= 0x7f; // STREAMINFO is never the last block here
      return [first, ...rest.map((b, i) => concat([blockHeader(b.type, b.data.length, i === rest.length - 1), b.data]))];
    }
    default:
      throw new MetadataError(`Editing Ogg ${CODEC_NAME[s.codec]} files is not supported`);
  }
}

const encodeAscii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// ------------------------------------------------------------------ read

function codecInfo(s: OggStream, last: { granule: number | null } | null, size: number): InfoItem[] {
  const h = s.headers[0];
  const r = new Reader(h, true);
  const info: InfoItem[] = [];
  const g = last?.granule ?? null;
  let secs = 0;
  try {
    switch (s.codec) {
      case 'vorbis': {
        const channels = h[11];
        const rate = r.u32(12);
        const nominal = r.i32(20);
        info.push({ label: 'Codec', value: 'Vorbis' }, { label: 'Channels', value: String(channels) }, { label: 'Sample rate', value: `${rate} Hz` });
        if (g !== null && rate) secs = g / rate;
        if (nominal > 0) info.push({ label: 'Nominal bitrate', value: `${Math.round(nominal / 1000)} kbps` });
        break;
      }
      case 'opus': {
        const channels = h[9];
        const preskip = r.u16(10);
        const input = r.u32(12);
        info.push(
          { label: 'Codec', value: 'Opus' },
          { label: 'Channels', value: String(channels) },
          { label: 'Sample rate', value: `48000 Hz${input ? ` (input ${input} Hz)` : ''}` },
        );
        if (g !== null) secs = Math.max(0, g - preskip) / 48000;
        break;
      }
      case 'flac': {
        const si = parseStreamInfo(h.subarray(17));
        info.push(...streamInfoItems(si, 0, si?.totalSamples || g || 0).map((i) => (i.label === 'Format' ? { label: 'Codec', value: 'FLAC' } : i)));
        break;
      }
      case 'speex': {
        info.push({ label: 'Codec', value: 'Speex' }, { label: 'Sample rate', value: `${r.u32(36)} Hz` }, { label: 'Channels', value: String(r.u32(48)) });
        if (g !== null && r.u32(36)) secs = g / r.u32(36);
        break;
      }
      default:
        info.push({ label: 'Codec', value: CODEC_NAME[s.codec] });
    }
  } catch {
    /* short identification header */
  }
  if (secs > 0) {
    info.push({ label: 'Duration', value: formatDuration(secs) });
    info.push({ label: 'Bitrate', value: `~${Math.round((size * 8) / secs / 1000)} kbps` });
  }
  return info;
}

function writable(s: OggStream, last: { serial: number } | null): string | null {
  if (s.multiplexed) return 'This Ogg file contains several multiplexed streams; it can only be viewed';
  if (last && last.serial !== s.serial) return 'This Ogg file is chained (several streams in a row); it can only be viewed';
  if (s.codec !== 'vorbis' && s.codec !== 'opus' && s.codec !== 'flac') return `Editing Ogg ${CODEC_NAME[s.codec]} files is not supported`;
  return null;
}

export async function readOgg(src: Source): Promise<Metadata> {
  const s = await readStream(src);
  const last = await lastPage(src);
  const warnings: string[] = [];
  const blocked = writable(s, last);
  if (blocked && (s.multiplexed || (last && last.serial !== s.serial))) warnings.push(blocked);
  const t = tagsOf(s);
  const canWrite = !blocked;
  const source = s.codec === 'opus' ? 'Opus tags' : s.codec === 'flac' ? 'Ogg FLAC' : 'Vorbis comment';
  const groups: FieldGroup[] = t ? vorbisGroups(t.vc, t.pictures, { source, addable: canWrite, pictures: canWrite || t.pictures.length > 0 }) : [];
  if (t?.blocks.length) {
    const fields: Field[] = t.blocks.map((b, i) =>
      rawField(
        `ogg:block:${i}`,
        b.type === BLOCK.APPLICATION ? `Application data (${latin1(b.data.subarray(0, 4))})` : `Metadata block ${b.type}`,
        formatBytes(b.data.length),
        { tag: `FLAC block ${b.type}` },
      ),
    );
    groups.push({ id: 'ogg.other', label: 'Other metadata blocks', source: 'Ogg FLAC', fields, removable: true });
  }
  if (!canWrite) for (const g of groups) g.removable = false;
  const name = `Ogg ${CODEC_NAME[s.codec]} ${s.codec === 'theora' ? 'video' : 'audio'}`;
  return {
    format: { id: 'ogg', name, mime: s.codec === 'opus' ? 'audio/opus' : 'audio/ogg', category: 'audio' },
    info: codecInfo(s, last, src.size),
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite,
    canStrip: canWrite,
  };
}

// ----------------------------------------------------------------- write

/** Re-paginate the headers and renumber the following pages when needed. */
async function rebuild(src: Source, s: OggStream, packets: Uint8Array[]): Promise<Blob> {
  const pages = paginate(packets, s.serial, s.firstSeq, s.codec === 'flac');
  if (s.leftover) {
    // Move the audio segments that shared the last header page onto their own page.
    const { page, firstSeg } = s.leftover;
    const skip = page.lacing.subarray(0, firstSeg).reduce((a, b) => a + b, 0);
    pages.push(buildPage(page.flags & ~0x03, page.granule, s.serial, s.firstSeq + pages.length, page.lacing.subarray(firstSeg), page.body.subarray(skip)));
  }
  const oldCount = s.headerPages;
  const delta = pages.length - oldCount;
  if (!delta) return toBlob([...pages, src.slice(s.headerEnd)], 'audio/ogg');
  const rest = await src.read(s.headerEnd, src.size - s.headerEnd);
  const out: Uint8Array[] = [...pages];
  let p = 0;
  while (p + 27 <= rest.length) {
    if (!startsWith(rest, 'OggS', p)) throw new MetadataError('Corrupt Ogg page; the file cannot be rewritten safely');
    const n = rest[p + 26];
    let len = 27 + n;
    for (let i = 0; i < n; i++) len += rest[p + 27 + i];
    if (p + len > rest.length) break; // truncated last page: copied as is
    const page = rest.slice(p, p + len);
    const view = new DataView(page.buffer);
    if (view.getUint32(14, true) !== s.serial || page[5] & 0x02) {
      throw new MetadataError('This Ogg file contains more than one stream; it can only be viewed');
    }
    view.setUint32(18, (view.getUint32(18, true) + delta) >>> 0, true);
    view.setUint32(22, 0, true);
    view.setUint32(22, oggCrc(page), true);
    out.push(page);
    p += len;
  }
  out.push(rest.subarray(p));
  return toBlob(out, 'audio/ogg');
}

async function openWritable(src: Source): Promise<{ s: OggStream; t: Tags }> {
  const s = await readStream(src);
  const blocked = writable(s, await lastPage(src));
  if (blocked) throw new MetadataError(blocked);
  const t = tagsOf(s);
  if (!t) throw new MetadataError('Ogg comment header not found');
  return { s, t };
}

export async function writeOgg(src: Source, edits: Edits): Promise<Blob> {
  const { s, t } = await openWritable(src);
  if (edits.get(groupKey('vorbis'))?.op === 'remove') t.vc = { vendor: '', comments: [] };
  else if (hasVorbisEdits(edits)) applyVorbisEdits(t.vc, edits);
  if (edits.get(groupKey('vorbis.pictures'))?.op === 'remove') t.pictures = [];
  else t.pictures = applyPictureEdits(t.pictures, edits).pictures;
  if (edits.get(groupKey('ogg.other'))?.op === 'remove') t.blocks = [];
  else {
    const drop = new Set([...edits].filter(([k, e]) => e.op === 'remove' && /^ogg:block:\d+$/.test(k)).map(([k]) => +k.split(':')[2]));
    t.blocks = t.blocks.filter((_, i) => !drop.has(i));
  }
  return rebuild(src, s, headerPackets(s, t));
}

export async function stripOgg(src: Source, opts: StripOptions): Promise<Blob> {
  const { s, t } = await openWritable(src);
  const tags: Tags = { vc: { vendor: '', comments: [] }, pictures: opts.keepCoverArt ? t.pictures : [], extra: new Uint8Array(0), blocks: [] };
  return rebuild(src, s, headerPackets(s, tags));
}

export const oggHandler: FormatHandler = {
  id: 'ogg',
  name: 'Ogg audio',
  category: 'audio',
  extensions: ['ogg', 'oga', 'opus', 'spx'],
  mime: 'audio/ogg',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if (startsWith(h, 'OggS') && h.length > 28) {
      const body = h.subarray(27 + h[26]);
      return codecOf(body) !== 'unknown' && codecOf(body) !== 'theora' ? 3 : 2;
    }
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readOgg,
  write: writeOgg,
  strip: stripOgg,
};
