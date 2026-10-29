/**
 * MP3 / MPEG audio: leading ID3v2 tag(s), trailing APEv2, Lyrics3, appended
 * ID3v2.4 and ID3v1 (+ TAG+) tags, plus stream info from the first frame
 * (Xing/Info/VBRI header, LAME encoder string).
 *
 * The audio frames are never loaded: output = new ID3v2 tag + slice of the
 * original audio + rebuilt trailing tags.
 */

import { Reader, formatBytes, latin1, startsWith, toBlob } from '../core/binary';
import { formatDuration, rawField } from '../core/fields';
import {
  groupKey,
  type DetectContext,
  type Edits,
  type FieldGroup,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Source,
  type StripOptions,
} from '../core/types';
import {
  apeGroups,
  apeSizeFromFooter,
  applyApeEdits,
  applyId3Edits,
  applyId3v1Edits,
  coverOnlyId3,
  emptyId3,
  equalFrames,
  hasId3Edits,
  id3Groups,
  id3v1Groups,
  id3v2Size,
  id3v2SizeFromFooter,
  parseApe,
  parseId3v1,
  parseId3v2,
  serializeApe,
  serializeId3v1,
  serializeId3v2,
  type ApeTag,
  type Id3Tag,
  type Id3v1,
} from './id3';

/** Zero padding after a rewritten ID3v2 tag so other taggers can edit in place. */
const ID3_PADDING = 1024;

// ------------------------------------------------------------ MPEG frames

export interface MpegHeader {
  /** 1, 2 or 2.5 */
  version: number;
  layer: number;
  /** kbps; 0 = free format */
  bitrate: number;
  sampleRate: number;
  /** 0 stereo, 1 joint stereo, 2 dual channel, 3 mono */
  mode: number;
  crc: boolean;
  /** bytes, 0 for free format */
  length: number;
  samples: number;
}

const BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

export function parseMpegHeader(b: Uint8Array, p: number): MpegHeader | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const vbits = (b[p + 1] >> 3) & 3;
  const lbits = (b[p + 1] >> 1) & 3;
  const bri = b[p + 2] >> 4;
  const sri = (b[p + 2] >> 2) & 3;
  if (vbits === 1 || lbits === 0 || bri === 15 || sri === 3) return null;
  const version = vbits === 3 ? 1 : vbits === 2 ? 2 : 2.5;
  const layer = 4 - lbits;
  const bitrate = BITRATES[version === 1 ? `1-${layer}` : layer === 1 ? '2-1' : '2-2'][bri];
  const sampleRate = RATES[version][sri];
  const pad = (b[p + 2] >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  const length = bitrate ? Math.floor(((samples / 8) * bitrate * 1000) / sampleRate) + pad * (layer === 1 ? 4 : 1) : 0;
  return { version, layer, bitrate, sampleRate, mode: b[p + 3] >> 6, crc: (b[p + 1] & 1) === 0, length, samples };
}

/** First offset ≥ from where two consecutive consistent frame headers start (or one ending the buffer). */
export function findMpegFrame(b: Uint8Array, from: number, maxScan = 64 * 1024): number {
  const end = Math.min(b.length - 4, from + maxScan);
  for (let p = from; p <= end; p++) {
    if (b[p] !== 0xff) continue;
    const h = parseMpegHeader(b, p);
    if (!h || !h.length) continue;
    const q = p + h.length;
    if (q + 4 > b.length) {
      if (q <= b.length + 1) return p;
      continue;
    }
    const n = parseMpegHeader(b, q);
    if (n && n.version === h.version && n.layer === h.layer && n.sampleRate === h.sampleRate) return p;
  }
  return -1;
}

interface StreamInfo {
  header: MpegHeader;
  frames?: number;
  bytes?: number;
  vbr: boolean;
  encoder?: string;
  firstFrame: number;
}

function sideInfo(h: MpegHeader): number {
  const mono = h.mode === 3;
  return h.version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
}

function parseStream(b: Uint8Array, at: number): StreamInfo | null {
  const p = findMpegFrame(b, 0);
  if (p < 0) return null;
  const header = parseMpegHeader(b, p)!;
  const info: StreamInfo = { header, vbr: false, firstFrame: at + p };
  const r = new Reader(b);
  for (const off of [4 + sideInfo(header), 4 + sideInfo(header) + 2]) {
    const x = p + off;
    if (!startsWith(b, 'Xing', x) && !startsWith(b, 'Info', x)) continue;
    info.vbr = startsWith(b, 'Xing', x);
    const flags = r.u32(x + 4);
    let q = x + 8;
    if (flags & 1) {
      info.frames = r.u32(q);
      q += 4;
    }
    if (flags & 2) {
      info.bytes = r.u32(q);
      q += 4;
    }
    if (flags & 4) q += 100;
    if (flags & 8) q += 4;
    const enc = latin1(b.subarray(q, q + 9)).replace(/[^\x20-\x7e].*$/s, '').trim();
    if (/^(LAME|Lav[cf]|GOGO|L3\.)/.test(enc)) info.encoder = enc.replace(/\.+$/, '');
    return info;
  }
  const v = p + 36;
  if (startsWith(b, 'VBRI', v)) {
    info.vbr = true;
    info.bytes = r.u32(v + 10);
    info.frames = r.u32(v + 14);
  }
  return info;
}

const MODES = ['Stereo', 'Joint stereo', 'Dual channel', 'Mono'];

function streamInfo(s: StreamInfo | null, audioEnd: number): InfoItem[] {
  if (!s) return [];
  const h = s.header;
  const info: InfoItem[] = [{ label: 'Format', value: `MPEG-${h.version} Layer ${'I'.repeat(h.layer)}` }];
  let duration = 0;
  if (s.frames) duration = (s.frames * h.samples) / h.sampleRate;
  else if (h.bitrate) duration = ((audioEnd - s.firstFrame) * 8) / (h.bitrate * 1000);
  const bytes = s.bytes ?? audioEnd - s.firstFrame;
  if (s.vbr && duration > 0) info.push({ label: 'Bitrate', value: `~${Math.round((bytes * 8) / duration / 1000)} kbps (VBR)` });
  else if (h.bitrate) info.push({ label: 'Bitrate', value: `${h.bitrate} kbps (CBR)` });
  info.push({ label: 'Sample rate', value: `${h.sampleRate} Hz` });
  info.push({ label: 'Channels', value: MODES[h.mode] });
  if (duration > 0) info.push({ label: 'Duration', value: formatDuration(duration) });
  if (s.encoder) info.push({ label: 'Encoder', value: s.encoder });
  return info;
}

// ----------------------------------------------------------------- layout

/** A tag appended after the audio. MP3 tools write them onto other formats too (FLAC). */
export type Trailer =
  | { kind: 'id3v1'; start: number; end: number; tag: Id3v1 }
  | { kind: 'ape'; start: number; end: number; tag: ApeTag }
  | { kind: 'lyrics3'; start: number; end: number }
  | { kind: 'id3v2'; start: number; end: number; tag: Id3Tag };

interface Layout {
  /** ID3v2 tags at the start of the file (normally one). */
  leading: Id3Tag[];
  audioStart: number;
  audioEnd: number;
  /** Tags after the audio, in file order. */
  trailers: Trailer[];
  warnings: string[];
}

async function readLeading(src: Source, at = 0): Promise<{ tags: Id3Tag[]; end: number }> {
  const tags: Id3Tag[] = [];
  let pos = at;
  for (let guard = 0; guard < 16; guard++) {
    const size = id3v2Size(await src.read(pos, 10));
    if (!size) break;
    tags.push(parseId3v2(await src.read(pos, size)));
    pos += size;
  }
  return { tags, end: pos };
}

/** Tags at the end of the file, not before `min`; `start` is where the first of them begins (the end of the audio). */
export async function readTrailers(src: Source, min: number): Promise<{ trailers: Trailer[]; start: number }> {
  const out: Trailer[] = [];
  let end = src.size;
  for (let guard = 0; guard < 8; guard++) {
    if (end - 128 >= min) {
      const t = await src.read(end - 128, 128);
      if (startsWith(t, 'TAG')) {
        let start = end - 128;
        let plus: Uint8Array | null = null;
        if (start - 227 >= min) {
          const p = await src.read(start - 227, 227);
          if (startsWith(p, 'TAG+')) {
            plus = p;
            start -= 227;
          }
        }
        const tag = parseId3v1(t, plus);
        if (tag) {
          out.unshift({ kind: 'id3v1', start, end, tag });
          end = start;
          continue;
        }
      }
    }
    if (end - 32 >= min) {
      const size = apeSizeFromFooter(await src.read(end - 32, 32));
      if (size >= 32 && end - size >= min) {
        try {
          out.unshift({ kind: 'ape', start: end - size, end, tag: parseApe(await src.read(end - size, size)) });
          end -= size;
          continue;
        } catch {
          /* not a usable APE tag */
        }
      }
    }
    if (end - 15 >= min) {
      const l = latin1(await src.read(end - 15, 15));
      if (l.endsWith('LYRICS200') && /^\d{6}/.test(l)) {
        const start = end - 15 - +l.slice(0, 6);
        if (start >= min && startsWith(await src.read(start, 11), 'LYRICSBEGIN')) {
          out.unshift({ kind: 'lyrics3', start, end });
          end = start;
          continue;
        }
      }
      if (l.endsWith('LYRICSEND')) {
        const from = Math.max(min, end - 5100 - 20);
        const i = latin1(await src.read(from, end - from)).lastIndexOf('LYRICSBEGIN');
        if (i >= 0) {
          out.unshift({ kind: 'lyrics3', start: from + i, end });
          end = from + i;
          continue;
        }
      }
    }
    if (end - 10 >= min) {
      const size = id3v2SizeFromFooter(await src.read(end - 10, 10));
      if (size && end - size >= min) {
        const b = await src.read(end - size, size);
        if (id3v2Size(b) === size) {
          out.unshift({ kind: 'id3v2', start: end - size, end, tag: parseId3v2(b) });
          end -= size;
          continue;
        }
      }
    }
    break;
  }
  return { trailers: out, start: end };
}

async function layout(src: Source): Promise<Layout> {
  const lead = await readLeading(src);
  const tail = await readTrailers(src, lead.end);
  const warnings = [...lead.tags, ...tail.trailers.flatMap((t) => (t.kind === 'id3v2' ? [t.tag] : []))].flatMap((t) => t.warnings);
  if (lead.tags.length > 1) warnings.push(`${lead.tags.length} stacked ID3v2 tags found; they are merged into one when saving`);
  return { leading: lead.tags, audioStart: lead.end, audioEnd: tail.start, trailers: tail.trailers, warnings };
}

/** One ID3v2 tag: the first one plus frames of stacked/appended tags it lacks. */
function primaryTag(L: Layout): Id3Tag | null {
  const all = [...L.leading, ...L.trailers.flatMap((t) => (t.kind === 'id3v2' ? [t.tag] : []))];
  if (!all.length) return null;
  const [first, ...rest] = all;
  const tag: Id3Tag = { ...first, frames: [...first.frames] };
  for (const t of rest) {
    for (const f of t.frames) {
      const single = (f.id[0] === 'T' && f.id !== 'TXXX') || (f.id[0] === 'W' && f.id !== 'WXXX');
      if (tag.frames.some((x) => x.id === f.id && (single || equalFrames(x, f)))) continue;
      tag.frames.push(f);
    }
  }
  return tag;
}

// ------------------------------------------------------------------ read

export async function readMp3(src: Source): Promise<Metadata> {
  const L = await layout(src);
  const warnings = [...L.warnings];
  const tag = primaryTag(L);
  const groups: FieldGroup[] = [...id3Groups(tag, { addable: true })];
  for (const t of L.trailers) {
    if (t.kind === 'id3v1') groups.push(...id3v1Groups(t.tag));
    if (t.kind === 'ape') groups.push(...apeGroups(t.tag));
  }
  const lyrics = L.trailers.find((t) => t.kind === 'lyrics3');
  if (lyrics) {
    groups.push({
      id: 'mp3.other',
      label: 'Other tags',
      source: 'Lyrics3',
      fields: [rawField('mp3:lyrics3', 'Lyrics3 tag', formatBytes(lyrics.end - lyrics.start), { sensitivity: 'content', tag: 'Lyrics3' })],
      removable: true,
    });
  }
  const head = await src.read(L.audioStart, Math.min(L.audioEnd - L.audioStart, 64 * 1024));
  const stream = parseStream(head, L.audioStart);
  if (!stream) warnings.push('No MPEG audio frames found');
  return {
    format: { id: 'mp3', name: 'MP3 audio', mime: 'audio/mpeg', category: 'audio' },
    info: streamInfo(stream, L.audioEnd),
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ----------------------------------------------------------------- write

function assemble(src: Source, L: Layout, head: Uint8Array | Blob, trailers: Array<Uint8Array | Blob>): Blob {
  return toBlob([head, src.slice(L.audioStart, L.audioEnd), ...trailers], 'audio/mpeg');
}

export async function writeMp3(src: Source, edits: Edits): Promise<Blob> {
  const L = await layout(src);
  const v2Removed = edits.get(groupKey('id3'))?.op === 'remove';
  let tag = primaryTag(L);
  const v2Edited = hasId3Edits(edits);
  if (v2Removed) tag = null;
  else if (v2Edited) {
    tag ??= emptyId3(3);
    applyId3Edits(tag, edits);
  }
  const unchanged = !v2Removed && !v2Edited && L.leading.length === 1 && !L.trailers.some((t) => t.kind === 'id3v2');
  const head: Uint8Array | Blob = unchanged ? src.slice(0, L.audioStart) : tag && tag.frames.length ? serializeId3v2(tag, ID3_PADDING) : new Uint8Array(0);

  const trailers: Array<Uint8Array | Blob> = [];
  for (const t of L.trailers) {
    switch (t.kind) {
      case 'id3v2':
        continue; // merged into the leading tag
      case 'lyrics3':
        if (edits.get('mp3:lyrics3')?.op !== 'remove' && edits.get(groupKey('mp3.other'))?.op !== 'remove') trailers.push(src.slice(t.start, t.end));
        continue;
      case 'ape': {
        if (edits.get(groupKey('ape'))?.op === 'remove') continue;
        const ape: ApeTag = { ...t.tag, items: [...t.tag.items] };
        if (applyApeEdits(ape, edits)) {
          if (ape.items.length) trailers.push(serializeApe(ape));
        } else trailers.push(src.slice(t.start, t.end));
        continue;
      }
      case 'id3v1': {
        if (edits.get(groupKey('id3v1'))?.op === 'remove') continue;
        const v1: Id3v1 = { ...t.tag, plus: t.tag.plus && { ...t.tag.plus } };
        if (applyId3v1Edits(v1, edits, tag)) {
          const s = serializeId3v1(v1);
          if (s.plus) trailers.push(s.plus);
          trailers.push(s.tag);
        } else trailers.push(src.slice(t.start, t.end));
        continue;
      }
    }
  }
  return assemble(src, L, head, trailers);
}

export async function stripMp3(src: Source, opts: StripOptions): Promise<Blob> {
  const L = await layout(src);
  const cover = opts.keepCoverArt ? coverOnlyId3(primaryTag(L)) : null;
  return assemble(src, L, cover ? serializeId3v2(cover) : new Uint8Array(0), []);
}

// ----------------------------------------------------------------- detect

const OTHER_AUDIO = ['flac', 'aac', 'm4a', 'wav', 'aif', 'aiff', 'ogg', 'oga', 'opus', 'ape', 'wv', 'tta', 'mpc'];

export const mp3Handler: FormatHandler = {
  id: 'mp3',
  name: 'MP3 audio',
  category: 'audio',
  extensions: ['mp3', 'mp2', 'mpga'],
  mime: 'audio/mpeg',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    const ext = this.extensions.includes(ctx.ext);
    const size = id3v2Size(h);
    if (size) {
      if (size + 4 > h.length) return OTHER_AUDIO.includes(ctx.ext) ? 1 : 2;
      let p = size;
      while (p < h.length && h[p] === 0) p++; // padding beyond the declared size
      if (startsWith(h, 'fLaC', p) || id3v2Size(h, p) && startsWith(h, 'fLaC', p + id3v2Size(h, p))) return 0;
      if (findMpegFrame(h, p, 4096) >= 0) return 3;
      return ext ? 2 : 1;
    }
    if (parseMpegHeader(h, 0) && findMpegFrame(h, 0, 0) === 0) return 3;
    return ext ? 1 : 0;
  },
  read: readMp3,
  write: writeMp3,
  strip: stripMp3,
};

/** For tests: split an MP3 into [leading tag bytes, audio, trailing tag bytes]. */
export async function mp3Parts(src: Source): Promise<{ audio: Uint8Array; head: Uint8Array; tail: Uint8Array }> {
  const L = await layout(src);
  const all = await src.bytes();
  return { head: all.subarray(0, L.audioStart), audio: all.subarray(L.audioStart, L.audioEnd), tail: all.subarray(L.audioEnd) };
}
