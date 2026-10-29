/**
 * FLAC: `fLaC` + metadata blocks (STREAMINFO, VORBIS_COMMENT, PICTURE,
 * PADDING, APPLICATION, SEEKTABLE, CUESHEET). A non-standard ID3v2 tag in
 * front of `fLaC` is read, editable and removed by strip.
 *
 * Writing rebuilds the metadata blocks (with a modest PADDING block); the
 * audio frames are carried over with `src.slice()`. SEEKTABLE offsets are
 * relative to the first frame, so they stay valid.
 */

import { Writer, formatBytes, latin1, startsWith, toBlob, toHex } from '../core/binary';
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
import { applyId3Edits, hasId3Edits, id3Groups, id3v2Size, parseId3v2, serializeId3v2, type Id3Tag } from './id3';
import { readTrailers, type Trailer } from './mp3';
import {
  applyPictureEdits,
  applyVorbisEdits,
  hasVorbisEdits,
  parseFlacPicture,
  parseVorbisComment,
  serializeFlacPicture,
  serializeVorbisComment,
  vorbisGroups,
  type FlacPicture,
  type VorbisComments,
} from './vorbiscomment';

export const BLOCK = { STREAMINFO: 0, PADDING: 1, APPLICATION: 2, SEEKTABLE: 3, VORBIS_COMMENT: 4, CUESHEET: 5, PICTURE: 6 } as const;
const MAX_BLOCK = 0xffffff;
const MAX_PADDING = 8192;
const MIN_PADDING = 1024;

export interface FlacBlock {
  type: number;
  data: Uint8Array;
}

export interface StreamInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  totalSamples: number;
  md5: string;
}

export function parseStreamInfo(d: Uint8Array): StreamInfo | null {
  if (d.length < 34) return null;
  const sampleRate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
  const channels = ((d[12] >> 1) & 7) + 1;
  const bits = (((d[12] & 1) << 4) | (d[13] >> 4)) + 1;
  const totalSamples = (d[13] & 0x0f) * 0x1_0000_0000 + ((d[14] << 24) >>> 0) + (d[15] << 16) + (d[16] << 8) + d[17];
  return { sampleRate, channels, bits, totalSamples, md5: toHex(d.subarray(18, 34), 16).replace(/ /g, '') };
}

/** Info items for a FLAC stream; `audioBytes` for the average bitrate. */
export function streamInfoItems(si: StreamInfo | null, audioBytes: number, totalSamples = si?.totalSamples ?? 0): InfoItem[] {
  if (!si) return [];
  const info: InfoItem[] = [
    { label: 'Format', value: 'FLAC' },
    { label: 'Sample rate', value: `${si.sampleRate} Hz` },
    { label: 'Channels', value: si.channels === 1 ? 'Mono' : si.channels === 2 ? 'Stereo' : String(si.channels) },
    { label: 'Bits per sample', value: String(si.bits) },
  ];
  if (totalSamples && si.sampleRate) {
    const secs = totalSamples / si.sampleRate;
    info.push({ label: 'Duration', value: formatDuration(secs) });
    if (audioBytes > 0) info.push({ label: 'Bitrate', value: `~${Math.round((audioBytes * 8) / secs / 1000)} kbps` });
  }
  if (!/^0+$/.test(si.md5)) info.push({ label: 'Audio MD5', value: si.md5 });
  return info;
}

export function blockHeader(type: number, length: number, last: boolean): Uint8Array {
  if (length > MAX_BLOCK) throw new MetadataError(`FLAC metadata block too large (${formatBytes(length)}; the limit is 16 MB)`);
  return new Uint8Array([(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

interface FlacFile {
  /** ID3v2 tags in front of `fLaC` (non-standard) */
  id3: Id3Tag[];
  id3End: number;
  blocks: FlacBlock[];
  audioStart: number;
  audioEnd: number;
  /** ID3v1 / APEv2 / Lyrics3 / ID3v2 tags appended after the audio by MP3 taggers (non-standard) */
  trailers: Trailer[];
}

/** First offset from `pos` that is not a zero byte (padding after a leading ID3 tag). */
async function skipZeros(src: Source, pos: number): Promise<number> {
  while (pos < src.size) {
    const b = await src.read(pos, 4096);
    const i = b.findIndex((x) => x !== 0);
    if (i >= 0) return pos + i;
    pos += b.length;
  }
  return pos;
}

async function parseFlac(src: Source): Promise<FlacFile> {
  const id3: Id3Tag[] = [];
  let pos = 0;
  for (let guard = 0; guard < 16; guard++) {
    const size = id3v2Size(await src.read(pos, 10));
    if (!size) break;
    id3.push(parseId3v2(await src.read(pos, size)));
    pos = await skipZeros(src, pos + size);
  }
  const id3End = pos;
  if (!startsWith(await src.read(pos, 4), 'fLaC')) throw new MetadataError('Not a FLAC file');
  pos += 4;
  const blocks: FlacBlock[] = [];
  for (;;) {
    const h = await src.read(pos, 4);
    if (h.length < 4) throw new MetadataError('Truncated FLAC metadata');
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 127 || pos + 4 + len > src.size) throw new MetadataError('Corrupt FLAC metadata block');
    blocks.push({ type, data: await src.read(pos + 4, len) });
    pos += 4 + len;
    if (h[0] & 0x80 || blocks.length > 4096) break;
  }
  if (blocks[0]?.type !== BLOCK.STREAMINFO) throw new MetadataError('FLAC file does not start with STREAMINFO');
  const tail = await readTrailers(src, pos);
  return { id3, id3End, blocks, audioStart: pos, audioEnd: tail.start, trailers: tail.trailers };
}

function vcOf(f: FlacFile): VorbisComments | null {
  const b = f.blocks.find((x) => x.type === BLOCK.VORBIS_COMMENT);
  return b ? parseVorbisComment(b.data).vc : null;
}

function picturesOf(f: FlacFile): FlacPicture[] {
  const out: FlacPicture[] = [];
  for (const b of f.blocks) {
    if (b.type !== BLOCK.PICTURE) continue;
    try {
      out.push(parseFlacPicture(b.data));
    } catch {
      /* skip unreadable picture */
    }
  }
  return out;
}

const blockName = (t: number) => ['STREAMINFO', 'PADDING', 'APPLICATION', 'SEEKTABLE', 'VORBIS_COMMENT', 'CUESHEET', 'PICTURE'][t] ?? `type ${t}`;

/** Raw fields for APPLICATION / CUESHEET / unknown blocks, keyed by block index. */
function otherFields(f: FlacFile): Field[] {
  const out: Field[] = [];
  f.blocks.forEach((b, i) => {
    if (b.type === BLOCK.APPLICATION) {
      const id = latin1(b.data.subarray(0, 4));
      out.push(rawField(`flac:block:${i}`, `Application data (${id})`, formatBytes(b.data.length), { sensitivity: 'software', tag: 'APPLICATION' }));
    } else if (b.type === BLOCK.CUESHEET) {
      out.push(rawField(`flac:block:${i}`, 'Cue sheet', formatBytes(b.data.length), { sensitivity: 'content', tag: 'CUESHEET' }));
    } else if (b.type > BLOCK.PICTURE) {
      out.push(rawField(`flac:block:${i}`, `Metadata block ${b.type}`, formatBytes(b.data.length), { tag: blockName(b.type) }));
    }
  });
  return out;
}

export async function readFlac(src: Source): Promise<Metadata> {
  const f = await parseFlac(src);
  const warnings: string[] = f.id3.flatMap((t) => t.warnings);
  const groups: FieldGroup[] = [];
  const vcBlock = f.blocks.find((x) => x.type === BLOCK.VORBIS_COMMENT);
  const parsed = vcBlock ? parseVorbisComment(vcBlock.data) : null;
  if (parsed?.truncated) warnings.push('The Vorbis comment block is truncated');
  groups.push(...vorbisGroups(parsed?.vc ?? null, picturesOf(f), { source: 'Vorbis comment', addable: true, pictures: true }));
  if (f.id3.length) {
    warnings.push('This FLAC file has a non-standard ID3 tag in front of the audio stream');
    groups.push(...id3Groups(f.id3[0], {}));
  }
  const other = otherFields(f);
  if (other.length) groups.push({ id: 'flac.other', label: 'Other metadata blocks', source: 'FLAC', fields: other, removable: true });
  if (f.trailers.length) {
    warnings.push('This FLAC file has tags appended after the audio stream (written by MP3 tools)');
    groups.push({ id: 'flac.trailing', label: 'Tags after the audio', source: 'ID3v1 / APEv2', fields: f.trailers.map(trailerField), removable: true });
  }
  return {
    format: { id: 'flac', name: 'FLAC audio', mime: 'audio/flac', category: 'audio' },
    info: streamInfoItems(parseStreamInfo(f.blocks[0].data), f.audioEnd - f.audioStart),
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

const TRAILER_LABELS: Record<Trailer['kind'], string> = {
  id3v1: 'ID3v1 tag',
  ape: 'APEv2 tag',
  lyrics3: 'Lyrics3 tag',
  id3v2: 'ID3v2 tag (appended)',
};

function trailerField(t: Trailer, i: number): Field {
  let what = formatBytes(t.end - t.start);
  if (t.kind === 'id3v1') what = [t.tag.title, t.tag.artist, t.tag.album, t.tag.year, t.tag.comment].filter(Boolean).join(' · ') || what;
  else if (t.kind === 'ape') what = `${t.tag.items.map((x) => x.key).join(', ') || 'empty'} — ${what}`;
  else if (t.kind === 'id3v2') what = `${t.tag.frames.length} frames — ${what}`;
  return rawField(`flac:trailer:${i}`, TRAILER_LABELS[t.kind], what, { tag: t.kind, sensitivity: 'content' });
}

interface Plan {
  /** undefined = keep, null = remove */
  vc?: VorbisComments | null;
  pictures?: FlacPicture[];
  dropBlocks: Set<number>;
  id3?: Id3Tag | null;
  /** indexes of `trailers` to drop */
  dropTrailers: Set<number>;
}

function assemble(src: Source, f: FlacFile, plan: Plan): Blob {
  const blocks: FlacBlock[] = [];
  let padding = 0;
  let vcPlaced = false;
  let picsPlaced = false;
  const newPics = plan.pictures?.map((p) => ({ type: BLOCK.PICTURE, data: serializeFlacPicture(p) }));
  const placeVc = () => {
    if (vcPlaced) return;
    vcPlaced = true;
    if (plan.vc) blocks.push({ type: BLOCK.VORBIS_COMMENT, data: serializeVorbisComment(plan.vc) });
  };
  f.blocks.forEach((b, i) => {
    if (b.type === BLOCK.PADDING) {
      padding += b.data.length;
      return;
    }
    if (b.type === BLOCK.VORBIS_COMMENT) {
      if (plan.vc === undefined && !vcPlaced) blocks.push(b);
      else placeVc();
      vcPlaced = true;
      return;
    }
    if (b.type === BLOCK.PICTURE && newPics) {
      if (!picsPlaced) blocks.push(...newPics);
      picsPlaced = true;
      return;
    }
    if (plan.dropBlocks.has(i)) return;
    blocks.push(b);
  });
  // VORBIS_COMMENT right after STREAMINFO (and SEEKTABLE) when it is new.
  if (!vcPlaced && plan.vc) {
    const at = blocks.findIndex((b) => b.type !== BLOCK.STREAMINFO && b.type !== BLOCK.SEEKTABLE);
    blocks.splice(at < 0 ? blocks.length : at, 0, { type: BLOCK.VORBIS_COMMENT, data: serializeVorbisComment(plan.vc) });
  }
  if (!picsPlaced && newPics) blocks.push(...newPics);
  blocks.push({ type: BLOCK.PADDING, data: new Uint8Array(Math.min(Math.max(padding, MIN_PADDING), MAX_PADDING)) });

  const parts: Array<Uint8Array | Blob> = [];
  if (plan.id3 === undefined) {
    if (f.id3End) parts.push(src.slice(0, f.id3End));
  } else if (plan.id3 && plan.id3.frames.length) parts.push(serializeId3v2(plan.id3));
  const w = new Writer(false, 4096);
  w.ascii('fLaC');
  blocks.forEach((b, i) => w.bytes(blockHeader(b.type, b.data.length, i === blocks.length - 1)).bytes(b.data));
  parts.push(w.finish(), src.slice(f.audioStart, f.audioEnd));
  f.trailers.forEach((t, i) => plan.dropTrailers.has(i) || parts.push(src.slice(t.start, t.end)));
  return toBlob(parts, 'audio/flac');
}

export async function writeFlac(src: Source, edits: Edits): Promise<Blob> {
  const f = await parseFlac(src);
  const plan: Plan = { dropBlocks: new Set(), dropTrailers: new Set() };
  const dropAllTrailers = edits.get(groupKey('flac.trailing'))?.op === 'remove';
  f.trailers.forEach((_, i) => (dropAllTrailers || edits.get(`flac:trailer:${i}`)?.op === 'remove') && plan.dropTrailers.add(i));
  if (edits.get(groupKey('vorbis'))?.op === 'remove') plan.vc = null;
  else if (hasVorbisEdits(edits)) {
    const vc = vcOf(f) ?? { vendor: '', comments: [] };
    applyVorbisEdits(vc, edits);
    plan.vc = vc;
  }
  if (edits.get(groupKey('vorbis.pictures'))?.op === 'remove') plan.pictures = [];
  else {
    const p = applyPictureEdits(picturesOf(f), edits);
    if (p.changed) plan.pictures = p.pictures;
  }
  for (const [k, e] of edits) {
    const m = /^flac:block:(\d+)$/.exec(k);
    if (m && e.op === 'remove') plan.dropBlocks.add(+m[1]);
  }
  if (edits.get(groupKey('flac.other'))?.op === 'remove') {
    f.blocks.forEach((b, i) => {
      if (b.type === BLOCK.APPLICATION || b.type === BLOCK.CUESHEET || b.type > BLOCK.PICTURE) plan.dropBlocks.add(i);
    });
  }
  if (f.id3.length) {
    if (edits.get(groupKey('id3'))?.op === 'remove') plan.id3 = null;
    else if (hasId3Edits(edits) || f.id3.length > 1) {
      const tag: Id3Tag = { ...f.id3[0], frames: [...f.id3[0].frames] };
      applyId3Edits(tag, edits);
      plan.id3 = tag;
    }
  }
  return assemble(src, f, plan);
}

export async function stripFlac(src: Source, opts: StripOptions): Promise<Blob> {
  const f = await parseFlac(src);
  const plan: Plan = { vc: null, pictures: opts.keepCoverArt ? picturesOf(f) : [], dropBlocks: new Set(), id3: null, dropTrailers: new Set(f.trailers.keys()) };
  f.blocks.forEach((b, i) => {
    if (b.type === BLOCK.APPLICATION || b.type > BLOCK.PICTURE) plan.dropBlocks.add(i);
  });
  return assemble(src, f, plan);
}

/** Offset of `fLaC` after optional ID3v2 tags in `head`, -1 if absent, -2 if the tags extend past `head`. */
export function flacOffset(head: Uint8Array): number {
  let p = 0;
  for (let guard = 0; guard < 4; guard++) {
    const size = id3v2Size(head, p);
    if (!size) break;
    p += size;
    if (p + 4 > head.length) return -2;
    while (p < head.length && head[p] === 0) p++;
  }
  return startsWith(head, 'fLaC', p) ? p : -1;
}

export const flacHandler: FormatHandler = {
  id: 'flac',
  name: 'FLAC audio',
  category: 'audio',
  extensions: ['flac'],
  mime: 'audio/flac',
  detect(ctx: DetectContext) {
    const p = flacOffset(ctx.head);
    if (p >= 0) return (ctx.head[p + 4] & 0x7f) === BLOCK.STREAMINFO ? 3 : 2;
    if (p === -2 && ctx.ext === 'flac') return 2;
    return ctx.ext === 'flac' ? 1 : 0;
  },
  read: readFlac,
  write: writeFlac,
  strip: stripFlac,
};

/** For tests: the audio frames (everything after the metadata blocks). */
export async function flacAudio(src: Source): Promise<Uint8Array> {
  const f = await parseFlac(src);
  return src.read(f.audioStart, f.audioEnd - f.audioStart);
}
