/**
 * Matroska / WebM (mkv, mka, mk3d, webm): Segment Info (title, date, muxing
 * and writing app, UID), Tracks (codecs, names, languages), Tags (incl.
 * nested SimpleTags), Attachments (cover images, fonts) and Chapters.
 *
 * Writing never loads the media payload. The Segment is rebuilt as
 *   SeekHead, Info, Tracks, Chapters, Attachments, Tags, [Cues],
 *   original Clusters (Blob slices), [Cues]
 * with every CueClusterPosition / SeekPosition / Cluster Position recomputed
 * through an old → new offset map. Cues stay in front of the clusters when
 * they were there (positions are then written with a fixed width so their
 * size does not depend on the values).
 */

import { formatBytes, latin1, toBlob, toHex } from '../core/binary';
import {
  asImage,
  asText,
  dateToParts,
  describeImage,
  displayDate,
  formatDuration,
  imageValue,
  makeField,
  parseDate,
  partsToDate,
  rawField,
  requireDate,
  spec,
  toIso,
} from '../core/fields';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldKind,
  type FieldSpec,
  type FieldValue,
  type FormatHandler,
  type FormatInfo,
  type InfoItem,
  type Metadata,
  type Sensitivity,
  type Source,
  type StripOptions,
} from '../core/types';
import {
  EbmlCursor,
  ID_CRC32,
  ID_EBML,
  ID_VOID,
  UNKNOWN_SIZE,
  child,
  element,
  encodeId,
  encodeSize,
  header,
  int64Element,
  master,
  parseChildren,
  readBigInt,
  readBigUint,
  readFloat,
  readHeader,
  readText,
  readUint,
  stringElement,
  uintElement,
  unknownSize,
  voidElement,
  type EbmlElement,
} from './ebml';

const ID = {
  DocType: 0x4282,
  MaxSizeLength: 0x42f3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  SegmentUID: 0x73a4,
  SegmentFilename: 0x7384,
  PrevFilename: 0x3c83ab,
  NextFilename: 0x3e83bb,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  DateUTC: 0x4461,
  Title: 0x7ba9,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  CodecID: 0x86,
  CodecName: 0x258688,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SilentTracks: 0x5854,
  Position: 0xa7,
  PrevSize: 0xab,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
  CueCodecState: 0xea,
  CueReference: 0xdb,
  CueRefCluster: 0x97,
  CueRefCodecState: 0xeb,
  Chapters: 0x1043a770,
  EditionEntry: 0x45b9,
  ChapterAtom: 0xb6,
  Tags: 0x1254c367,
  Tag: 0x7373,
  Targets: 0x63c0,
  TargetTypeValue: 0x68ca,
  TargetType: 0x63ca,
  TagTrackUID: 0x63c5,
  TagEditionUID: 0x63c9,
  TagChapterUID: 0x63c4,
  TagAttachmentUID: 0x63c6,
  SimpleTag: 0x67c8,
  TagName: 0x45a3,
  TagLanguage: 0x447a,
  TagLanguageBCP47: 0x447b,
  TagString: 0x4487,
  TagBinary: 0x4485,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileDescription: 0x467e,
  FileName: 0x466e,
  FileMediaType: 0x4660,
  FileData: 0x465c,
  FileUID: 0x46ae,
} as const;

const LEVEL1 = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Chapters, ID.Tags, ID.Attachments]);
/** Ids that end an unknown-size Cluster. */
const CLUSTER_END = new Set<number>([...LEVEL1, ID_EBML, ID.Segment]);
/** Neutral value for the mandatory MuxingApp / WritingApp after stripping. */
export const NEUTRAL_APP = 'unknown';
const EPOCH_2001 = Date.UTC(2001, 0, 1);
const MAX_META = 256 << 20;
const MAX_COVER = 32 << 20;
/** SimpleTags / ChapterAtoms nested deeper than this (real files use 2 or 3) are not descended into: parsing recurses. */
const MAX_NESTING = 32;

// ------------------------------------------------------------------- layout

/** A level-1 element of the Segment (absolute offsets). */
interface L1 {
  id: number;
  pos: number;
  headerSize: number;
  end: number;
  unknownSize: boolean;
  /** Cluster "Position" child (absolute offset of the element, its total length, value width). */
  position?: { at: number; length: number; width: number };
}

interface Layout {
  docType: string;
  maxSizeLength: number;
  segPos: number;
  /** absolute start of the Segment payload; Seek/Cue positions are relative to it */
  segData: number;
  segEnd: number;
  /** the Segment size field was "unknown" (live recordings); kept that way on write */
  segUnknown: boolean;
  elements: L1[];
  /** every level-1 element was visited (false when the reader skipped clusters) */
  complete: boolean;
  /**
   * segment: the Segment claims more bytes than the file has, elements are complete;
   * cluster: the last Cluster is cut off (interrupted recording) — writable;
   * damaged: anything else — not writable.
   */
  truncated: 'none' | 'segment' | 'cluster' | 'damaged';
  /** an EBML header follows the segment (chained segments) */
  chained: boolean;
}

/** End of an unknown-size Cluster: the next level-1 id, or `limit` (`cut` when a block overflows it). */
async function clusterEnd(src: Source, start: number, limit: number): Promise<{ end: number; cut: boolean }> {
  const cur = new EbmlCursor(src, 1 << 20);
  let p = start;
  while (p < limit) {
    const h = await cur.header(p);
    if (!h) return { end: limit, cut: true };
    if (CLUSTER_END.has(h.id)) return { end: p, cut: false };
    if (h.size === UNKNOWN_SIZE) throw new MetadataError('Unsupported Matroska layout: nested element of unknown size');
    p += h.headerSize + h.size;
  }
  return { end: limit, cut: p > limit };
}

/** Find a Cluster's Position child among its leading elements. */
async function clusterPosition(cur: EbmlCursor, el: L1): Promise<L1['position']> {
  const start = el.pos + el.headerSize;
  const b = await cur.bytes(start, Math.min(64, el.end - start));
  let p = 0;
  while (p < b.length) {
    const h = readHeader(b, p);
    if (!h || h.size === UNKNOWN_SIZE) return undefined;
    if (h.id === ID.Position) return h.size <= 8 ? { at: start + p, length: h.headerSize + h.size, width: h.size } : undefined;
    if (h.id !== ID.Timestamp && h.id !== ID.PrevSize && h.id !== ID.SilentTracks && h.id !== ID_CRC32 && h.id !== ID_VOID) return undefined;
    p += h.headerSize + h.size;
  }
  return undefined;
}

/**
 * Walk the Segment's level-1 elements. With `full = false` the walk stops at
 * the first Cluster and elements after the clusters are located via SeekHead.
 */
async function scanLayout(src: Source, full: boolean): Promise<Layout> {
  const cur = new EbmlCursor(src, 512);
  const head = await src.read(0, 4096);
  const eh = readHeader(head, 0);
  if (!eh || eh.id !== ID_EBML || eh.size === UNKNOWN_SIZE) throw new MetadataError('Not a Matroska/WebM file (EBML header missing)');
  const ebmlBytes = eh.headerSize + eh.size <= head.length ? head : await src.read(0, eh.headerSize + eh.size);
  const ebml = parseChildren(ebmlBytes, eh.headerSize, eh.headerSize + eh.size);
  const dt = child(ebml, ID.DocType);
  const ms = child(ebml, ID.MaxSizeLength);
  const docType = dt ? readText(dt.data) : 'matroska';
  if (docType !== 'matroska' && docType !== 'webm') throw new MetadataError(`Unsupported EBML document type “${docType}”`);

  let p = eh.headerSize + eh.size;
  let sh = await cur.header(p);
  while (sh && sh.id === ID_VOID && sh.size !== UNKNOWN_SIZE) {
    p += sh.headerSize + sh.size;
    sh = await cur.header(p);
  }
  if (!sh || sh.id !== ID.Segment) throw new MetadataError('Matroska Segment not found');
  const segData = p + sh.headerSize;
  let segEnd = sh.size === UNKNOWN_SIZE ? src.size : segData + sh.size;
  let truncated: Layout['truncated'] = 'none';
  if (segEnd > src.size) {
    segEnd = src.size;
    truncated = 'segment';
  }

  const elements: L1[] = [];
  let complete = true;
  let chained = false;
  let q = segData;
  while (q < segEnd) {
    const h = await cur.header(q);
    if (!h) {
      // Garbage after the last element: trailing data for an unknown-size Segment.
      if (sh.size === UNKNOWN_SIZE) segEnd = q;
      else truncated = 'damaged';
      break;
    }
    if (h.id === ID_EBML || h.id === ID.Segment) {
      chained = true;
      segEnd = q;
      break;
    }
    const isCluster = h.id === ID.Cluster;
    if (h.size === UNKNOWN_SIZE && !isCluster) throw new MetadataError('Unsupported Matroska layout: level-1 element of unknown size');
    if (!full && isCluster) {
      elements.push({ id: h.id, pos: q, headerSize: h.headerSize, end: q + h.headerSize, unknownSize: h.size === UNKNOWN_SIZE });
      complete = false;
      break;
    }
    let end = q + h.headerSize + h.size;
    let cut = false;
    if (h.size === UNKNOWN_SIZE) ({ end, cut } = await clusterEnd(src, q + h.headerSize, segEnd));
    if (end > segEnd) {
      end = segEnd;
      cut = true;
    }
    if (cut) truncated = isCluster ? 'cluster' : 'damaged';
    const el: L1 = { id: h.id, pos: q, headerSize: h.headerSize, end, unknownSize: h.size === UNKNOWN_SIZE };
    if (isCluster) el.position = await clusterPosition(cur, el);
    elements.push(el);
    q = end;
  }
  if (!chained && segEnd < src.size) {
    const next = await src.read(segEnd, 4);
    chained = readHeader(next, 0)?.id === ID_EBML;
  }

  const layout: Layout = {
    docType,
    maxSizeLength: ms ? readUint(ms.data) || 8 : 8,
    segPos: p,
    segData,
    segEnd,
    segUnknown: sh.size === UNKNOWN_SIZE,
    elements,
    complete,
    truncated,
    chained,
  };
  if (!complete) await followSeekHeads(src, layout);
  return layout;
}

/** Add level-1 metadata elements that lie beyond the first cluster, located via SeekHead. */
async function followSeekHeads(src: Source, layout: Layout): Promise<void> {
  const known = new Set(layout.elements.map((e) => e.pos));
  const queue = layout.elements.filter((e) => e.id === ID.SeekHead);
  const wanted = new Set<number>([ID.Info, ID.Tracks, ID.Tags, ID.Attachments, ID.Chapters, ID.Cues, ID.SeekHead]);
  for (let guard = 0; queue.length && guard < 16; guard++) {
    const sh = queue.shift()!;
    const data = await src.read(sh.pos + sh.headerSize, sh.end - sh.pos - sh.headerSize);
    for (const seek of parseChildren(data).filter((e) => e.id === ID.Seek)) {
      const kids = parseChildren(seek.data);
      const sid = child(kids, ID.SeekID);
      const spos = child(kids, ID.SeekPosition);
      if (!sid || !spos) continue;
      const id = readUint(sid.data);
      const at = layout.segData + readUint(spos.data);
      if (!wanted.has(id) || known.has(at) || at >= layout.segEnd) continue;
      const h = readHeader(await src.read(at, 12), 0);
      if (!h || h.id !== id || h.size === UNKNOWN_SIZE || at + h.headerSize + h.size > layout.segEnd) continue;
      const el: L1 = { id, pos: at, headerSize: h.headerSize, end: at + h.headerSize + h.size, unknownSize: false };
      known.add(at);
      layout.elements.push(el);
      if (id === ID.SeekHead) queue.push(el);
    }
  }
  layout.elements.sort((a, b) => a.pos - b.pos);
}

// -------------------------------------------------------------------- model

interface Track {
  children: EbmlElement[];
  number: number;
  uid: bigint | null;
  type: number;
  codecId: string;
  codecName: string;
  name: string | null;
  language: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  /** ns per frame */
  defaultDuration?: number;
  /** serialized TrackEntry; null when it must be rebuilt */
  raw: Uint8Array | null;
}

interface SimpleTag {
  name: string;
  /** TagLanguage / TagLanguageBCP47, '' when unspecified */
  lang: string;
  value: string | null;
  binary: Uint8Array | null;
  /** TagLanguage, TagDefault … */
  extra: Uint8Array[];
  children: SimpleTag[];
  /** original element; null when modified */
  raw: Uint8Array | null;
}

interface Tag {
  /** serialized Targets element */
  targets: Uint8Array;
  key: string;
  ttv: number;
  targetType: string;
  trackUids: bigint[];
  simple: SimpleTag[];
}

interface Attachment {
  pos: number;
  end: number;
  uid: bigint | null;
  name: string;
  mime: string;
  description: string;
  dataSize: number;
  /** loaded for images */
  data: Uint8Array | null;
  /** new serialized AttachedFile (added or replaced) */
  rebuilt: Uint8Array | null;
}

interface Doc {
  src: Source;
  layout: Layout;
  info: EbmlElement[];
  hasInfo: boolean;
  tracks: Track[];
  tracksExtra: EbmlElement[];
  tags: Tag[];
  attachments: Attachment[];
  chapters: L1[];
  editions: number;
  chapterCount: number;
  cues: L1[];
  unknown: L1[];
  useCrc: boolean;
  warnings: string[];
}

async function elementData(src: Source, el: L1): Promise<Uint8Array> {
  const n = el.end - el.pos - el.headerSize;
  if (n > MAX_META) throw new MetadataError('Matroska metadata element is too large');
  return src.read(el.pos + el.headerSize, n);
}

/** Children without CRC-32 / Void (both are regenerated or dropped on write). */
const meaningful = (list: EbmlElement[]) => list.filter((e) => e.id !== ID_CRC32 && e.id !== ID_VOID);

function parseTrack(entry: Uint8Array): Track {
  const kids = parseChildren(entry);
  const get = (id: number) => child(kids, id);
  const t: Track = {
    children: meaningful(kids),
    number: get(ID.TrackNumber) ? readUint(get(ID.TrackNumber)!.data) : 0,
    uid: get(ID.TrackUID) ? readBigUint(get(ID.TrackUID)!.data) : null,
    type: get(ID.TrackType) ? readUint(get(ID.TrackType)!.data) : 0,
    codecId: get(ID.CodecID) ? readText(get(ID.CodecID)!.data) : '',
    codecName: get(ID.CodecName) ? readText(get(ID.CodecName)!.data) : '',
    name: get(ID.Name) ? readText(get(ID.Name)!.data) : null,
    language: get(ID.LanguageBCP47) ? readText(get(ID.LanguageBCP47)!.data) : get(ID.Language) ? readText(get(ID.Language)!.data) : 'eng',
    raw: null,
  };
  const dd = get(ID.DefaultDuration);
  if (dd) t.defaultDuration = readUint(dd.data);
  const video = get(ID.Video);
  if (video) {
    const v = parseChildren(video.data);
    const w = child(v, ID.PixelWidth);
    const h = child(v, ID.PixelHeight);
    if (w) t.width = readUint(w.data);
    if (h) t.height = readUint(h.data);
  }
  const audio = get(ID.Audio);
  if (audio) {
    const a = parseChildren(audio.data);
    const sr = child(a, ID.SamplingFrequency);
    const ch = child(a, ID.Channels);
    t.sampleRate = sr ? readFloat(sr.data) : 8000;
    t.channels = ch ? readUint(ch.data) : 1;
  }
  return t;
}

function parseSimpleTag(el: EbmlElement, depth = 1): SimpleTag {
  const kids = parseChildren(el.data);
  const s: SimpleTag = { name: '', lang: '', value: null, binary: null, extra: [], children: [], raw: el.raw };
  for (const k of kids) {
    if (k.id === ID.TagLanguage || k.id === ID.TagLanguageBCP47) s.lang ||= readText(k.data);
    if (k.id === ID.TagName) s.name = readText(k.data);
    else if (k.id === ID.TagString) s.value = readText(k.data);
    else if (k.id === ID.TagBinary) s.binary = k.data;
    else if (k.id === ID.SimpleTag && depth < MAX_NESTING) s.children.push(parseSimpleTag(k, depth + 1));
    else if (k.id !== ID_CRC32 && k.id !== ID_VOID) s.extra.push(k.raw);
  }
  return s;
}

function targetKey(ttv: number, uids: string[]): string {
  if (!uids.length) return String(ttv);
  return uids.join('+') + (ttv !== 50 ? `@${ttv}` : '');
}

function parseTag(el: EbmlElement): Tag {
  const kids = parseChildren(el.data);
  const targets = child(kids, ID.Targets);
  const tk = targets ? parseChildren(targets.data) : [];
  const ttvEl = child(tk, ID.TargetTypeValue);
  const ttEl = child(tk, ID.TargetType);
  const ttv = ttvEl ? readUint(ttvEl.data) : 50;
  const trackUids: bigint[] = [];
  const uids: string[] = [];
  const kinds: Array<[number, string]> = [
    [ID.TagTrackUID, 'track'],
    [ID.TagEditionUID, 'edition'],
    [ID.TagChapterUID, 'chapter'],
    [ID.TagAttachmentUID, 'attachment'],
  ];
  for (const [id, kind] of kinds) {
    for (const u of tk.filter((e) => e.id === id)) {
      const v = readBigUint(u.data);
      if (id === ID.TagTrackUID) trackUids.push(v);
      uids.push(`${kind}${v}`);
    }
  }
  return {
    targets: targets ? targets.raw : element(ID.Targets),
    key: targetKey(ttv, uids),
    ttv,
    targetType: ttEl ? readText(ttEl.data) : '',
    trackUids,
    simple: kids.filter((k) => k.id === ID.SimpleTag).map((k) => parseSimpleTag(k)),
  };
}

/** Targets element for a key produced by targetKey(), or null if unsupported. */
function targetsFor(key: string): Uint8Array | null {
  if (/^\d+$/.test(key)) return element(ID.Targets, uintElement(ID.TargetTypeValue, +key));
  const m = /^track(\d+)(?:@(\d+))?$/.exec(key);
  if (m) {
    const kids = [uintElement(ID.TagTrackUID, BigInt(m[1]))];
    if (m[2]) kids.unshift(uintElement(ID.TargetTypeValue, +m[2]));
    return element(ID.Targets, ...kids);
  }
  return null;
}

async function readAttachments(src: Source, el: L1, warnings: string[]): Promise<Attachment[]> {
  const cur = new EbmlCursor(src, 4096);
  const out: Attachment[] = [];
  let p = el.pos + el.headerSize;
  while (p < el.end) {
    const h = await cur.header(p);
    if (!h || h.size === UNKNOWN_SIZE || p + h.headerSize + h.size > el.end) {
      warnings.push('Attachments element is damaged');
      break;
    }
    const end = p + h.headerSize + h.size;
    if (h.id === ID.AttachedFile) {
      const a: Attachment = { pos: p, end, uid: null, name: '', mime: '', description: '', dataSize: 0, data: null, rebuilt: null };
      let dataAt = -1;
      let q = p + h.headerSize;
      while (q < end) {
        const k = await cur.header(q);
        if (!k || k.size === UNKNOWN_SIZE || q + k.headerSize + k.size > end) break;
        const at = q + k.headerSize;
        if (k.id === ID.FileData) {
          dataAt = at;
          a.dataSize = k.size;
        } else if (k.size <= 4096) {
          const d = await cur.bytes(at, k.size);
          if (k.id === ID.FileName) a.name = readText(d);
          else if (k.id === ID.FileMediaType) a.mime = readText(d).toLowerCase();
          else if (k.id === ID.FileDescription) a.description = readText(d);
          else if (k.id === ID.FileUID) a.uid = readBigUint(d);
        }
        q = at + k.size;
      }
      if (isImage(a) && dataAt >= 0 && a.dataSize <= MAX_COVER) a.data = await src.read(dataAt, a.dataSize);
      out.push(a);
    }
    p = end;
  }
  return out;
}

function isImage(a: Attachment): boolean {
  return a.mime.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(a.name);
}

/** Fonts render subtitles: the one kind of attachment playback needs. */
function isFont(a: Attachment): boolean {
  return /font|truetype|opentype|sfnt/i.test(a.mime) || /\.(ttf|otf|ttc|woff2?)$/i.test(a.name);
}

function countChapters(data: Uint8Array): { editions: number; chapters: number } {
  let editions = 0;
  let chapters = 0;
  const atoms = (list: EbmlElement[], depth: number) => {
    for (const a of list.filter((e) => e.id === ID.ChapterAtom)) {
      chapters++;
      if (depth < MAX_NESTING) atoms(parseChildren(a.data), depth + 1);
    }
  };
  for (const ed of parseChildren(data).filter((e) => e.id === ID.EditionEntry)) {
    editions++;
    atoms(parseChildren(ed.data), 1);
  }
  return { editions, chapters };
}

async function loadDoc(src: Source, full: boolean): Promise<Doc> {
  const layout = await scanLayout(src, full);
  const doc: Doc = {
    src,
    layout,
    info: [],
    hasInfo: false,
    tracks: [],
    tracksExtra: [],
    tags: [],
    attachments: [],
    chapters: [],
    editions: 0,
    chapterCount: 0,
    cues: [],
    unknown: [],
    useCrc: false,
    warnings: [],
  };
  if (layout.truncated !== 'none') doc.warnings.push('The file appears to be truncated (incomplete recording?).');
  for (const el of layout.elements) {
    switch (el.id) {
      case ID.Info: {
        if (doc.hasInfo) {
          doc.warnings.push('Multiple Segment Info elements; only the first is used.');
          break;
        }
        const kids = parseChildren(await elementData(src, el));
        doc.useCrc ||= kids[0]?.id === ID_CRC32;
        doc.info = meaningful(kids);
        doc.hasInfo = true;
        break;
      }
      case ID.Tracks: {
        const kids = parseChildren(await elementData(src, el));
        doc.useCrc ||= kids[0]?.id === ID_CRC32;
        for (const k of meaningful(kids)) {
          if (k.id === ID.TrackEntry) doc.tracks.push({ ...parseTrack(k.data), raw: k.raw });
          else doc.tracksExtra.push(k);
        }
        break;
      }
      case ID.Tags:
        for (const t of parseChildren(await elementData(src, el))) if (t.id === ID.Tag) doc.tags.push(parseTag(t));
        break;
      case ID.Attachments:
        doc.attachments.push(...(await readAttachments(src, el, doc.warnings)));
        break;
      case ID.Chapters: {
        doc.chapters.push(el);
        const c = countChapters(await elementData(src, el));
        doc.editions += c.editions;
        doc.chapterCount += c.chapters;
        break;
      }
      case ID.Cues:
        doc.cues.push(el);
        break;
      case ID.Cluster:
      case ID.SeekHead:
      case ID_VOID:
      case ID_CRC32:
        break;
      default:
        doc.unknown.push(el);
    }
  }
  return doc;
}

// ------------------------------------------------------------------- labels

type TagDef = [label: string, sensitivity?: Sensitivity, kind?: FieldKind];

const TAG_DEFS: Record<string, TagDef> = {
  TITLE: ['Title', 'content'],
  SUBTITLE: ['Subtitle', 'content'],
  ALBUM: ['Album', 'content'],
  ARTIST: ['Artist', 'identity'],
  ALBUM_ARTIST: ['Album artist', 'identity'],
  LEAD_PERFORMER: ['Lead performer', 'identity'],
  ACTOR: ['Actor', 'identity'],
  DIRECTOR: ['Director', 'identity'],
  PRODUCER: ['Producer', 'identity'],
  COMPOSER: ['Composer', 'identity'],
  LYRICIST: ['Lyricist', 'identity'],
  WRITTEN_BY: ['Written by', 'identity'],
  PUBLISHER: ['Publisher', 'identity'],
  LABEL: ['Label', 'identity'],
  DISTRIBUTED_BY: ['Distributed by', 'identity'],
  ENCODED_BY: ['Encoded by', 'identity'],
  COPYRIGHT: ['Copyright', 'identity'],
  PRODUCTION_COPYRIGHT: ['Production copyright', 'identity'],
  LICENSE: ['License', 'identity'],
  TERMS_OF_USE: ['Terms of use', 'identity'],
  URL: ['URL', 'identity'],
  EMAIL: ['E-mail', 'identity'],
  COMMENT: ['Comment', 'content', 'multiline'],
  DESCRIPTION: ['Description', 'content', 'multiline'],
  SYNOPSIS: ['Synopsis', 'content', 'multiline'],
  SUMMARY: ['Summary', 'content', 'multiline'],
  LYRICS: ['Lyrics', 'content', 'multiline'],
  KEYWORDS: ['Keywords', 'content'],
  GENRE: ['Genre', 'content'],
  MOOD: ['Mood', 'content'],
  SUBJECT: ['Subject', 'content'],
  PART_NUMBER: ['Part number'],
  TOTAL_PARTS: ['Total parts'],
  ISRC: ['ISRC'],
  BARCODE: ['Barcode'],
  CATALOG_NUMBER: ['Catalog number'],
  LAW_RATING: ['Rating (law)'],
  RATING: ['Rating'],
  DATE_RELEASED: ['Release date', 'time', 'datetime'],
  DATE_RECORDED: ['Recording date', 'time', 'datetime'],
  DATE_ENCODED: ['Encoding date', 'time', 'datetime'],
  DATE_TAGGED: ['Tagging date', 'time', 'datetime'],
  DATE_DIGITIZED: ['Digitizing date', 'time', 'datetime'],
  DATE_WRITTEN: ['Writing date', 'time', 'datetime'],
  DATE_PURCHASED: ['Purchase date', 'time', 'datetime'],
  CREATION_TIME: ['Creation time', 'time', 'datetime'],
  RECORDING_LOCATION: ['Recording location', 'location'],
  COMPOSITION_LOCATION: ['Composition location', 'location'],
  LOCATION: ['Location', 'location'],
  'COM.APPLE.QUICKTIME.LOCATION.ISO6709': ['Location (ISO 6709)', 'location'],
  'COM.APPLE.QUICKTIME.MAKE': ['Camera make', 'device'],
  'COM.APPLE.QUICKTIME.MODEL': ['Camera model', 'device'],
  'COM.APPLE.QUICKTIME.SOFTWARE': ['Camera software', 'software'],
  ENCODER: ['Encoder', 'software'],
  ENCODER_SETTINGS: ['Encoder settings', 'software'],
  HANDLER_NAME: ['Handler name', 'software'],
  VENDOR_ID: ['Vendor ID', 'device'],
  MAJOR_BRAND: ['Major brand', 'software'],
  MINOR_VERSION: ['Minor version', 'software'],
  COMPATIBLE_BRANDS: ['Compatible brands', 'software'],
  _STATISTICS_WRITING_APP: ['Statistics writing app', 'software'],
  _STATISTICS_WRITING_DATE_UTC: ['Statistics writing date', 'time', 'datetime'],
  _STATISTICS_TAGS: ['Statistics tags'],
  DURATION: ['Duration'],
  BPS: ['Bit rate'],
  NUMBER_OF_FRAMES: ['Number of frames'],
  NUMBER_OF_BYTES: ['Number of bytes'],
};

/** Global tags offered in the "add field" menu. */
const ADDABLE_TAGS = [
  'TITLE',
  'ARTIST',
  'DATE_RELEASED',
  'DATE_RECORDED',
  'COMMENT',
  'DESCRIPTION',
  'GENRE',
  'KEYWORDS',
  'COPYRIGHT',
  'ENCODED_BY',
  'DIRECTOR',
  'PRODUCER',
  'COMPOSER',
  'PUBLISHER',
  'RECORDING_LOCATION',
  'URL',
];

const TTV_NAMES: Record<number, string> = {
  70: 'collection',
  60: 'season / volume',
  50: 'movie / album',
  40: 'part / session',
  30: 'chapter / track',
  20: 'scene / movement',
  10: 'shot',
};

function tagDef(name: string): TagDef {
  const d = TAG_DEFS[name.toUpperCase()];
  if (d) return d;
  const pretty = name.replace(/_+/g, ' ').trim().toLowerCase();
  return [pretty ? pretty[0].toUpperCase() + pretty.slice(1) : name, 'content'];
}

const CODECS: Array<[string, string]> = [
  ['V_MPEG4/ISO/AVC', 'H.264 (AVC)'],
  ['V_MPEGH/ISO/HEVC', 'H.265 (HEVC)'],
  ['V_MPEGI/ISO/VVC', 'H.266 (VVC)'],
  ['V_MPEG4/ISO', 'MPEG-4 Part 2'],
  ['V_MPEG4/MS', 'MS MPEG-4'],
  ['V_MPEG2', 'MPEG-2 video'],
  ['V_MPEG1', 'MPEG-1 video'],
  ['V_VP8', 'VP8'],
  ['V_VP9', 'VP9'],
  ['V_AV1', 'AV1'],
  ['V_THEORA', 'Theora'],
  ['V_PRORES', 'ProRes'],
  ['V_FFV1', 'FFV1'],
  ['V_MJPEG', 'Motion JPEG'],
  ['V_MS/VFW/FOURCC', 'Video for Windows'],
  ['V_QUICKTIME', 'QuickTime video'],
  ['V_UNCOMPRESSED', 'Uncompressed video'],
  ['V_REAL', 'RealVideo'],
  ['A_AAC', 'AAC'],
  ['A_OPUS', 'Opus'],
  ['A_VORBIS', 'Vorbis'],
  ['A_FLAC', 'FLAC'],
  ['A_MPEG/L3', 'MP3'],
  ['A_MPEG/L2', 'MP2'],
  ['A_MPEG/L1', 'MP1'],
  ['A_AC3', 'AC-3'],
  ['A_EAC3', 'E-AC-3'],
  ['A_DTS', 'DTS'],
  ['A_TRUEHD', 'Dolby TrueHD'],
  ['A_MLP', 'MLP'],
  ['A_ALAC', 'ALAC'],
  ['A_PCM/FLOAT', 'PCM (float)'],
  ['A_PCM', 'PCM'],
  ['A_WAVPACK4', 'WavPack'],
  ['A_TTA1', 'TTA'],
  ['A_MS/ACM', 'ACM audio'],
  ['A_REAL', 'RealAudio'],
  ['S_TEXT/UTF8', 'SubRip text'],
  ['S_TEXT/ASS', 'ASS'],
  ['S_TEXT/SSA', 'SSA'],
  ['S_TEXT/WEBVTT', 'WebVTT'],
  ['S_TEXT/USF', 'USF'],
  ['S_HDMV/PGS', 'PGS'],
  ['S_HDMV/TEXTST', 'HDMV text'],
  ['S_VOBSUB', 'VobSub'],
  ['S_DVBSUB', 'DVB subtitles'],
  ['S_KATE', 'Kate'],
  ['D_WEBVTT', 'WebVTT'],
];

const TRACK_TYPES: Record<number, string> = {
  1: 'Video',
  2: 'Audio',
  3: 'Complex',
  0x10: 'Logo',
  0x11: 'Subtitles',
  0x12: 'Buttons',
  0x20: 'Control',
  0x21: 'Metadata',
};

function codecLabel(t: Track): string {
  const hit = CODECS.find(([prefix]) => t.codecId.startsWith(prefix));
  return hit ? hit[1] : t.codecName || t.codecId || 'unknown codec';
}

function trackSummary(t: Track): string {
  const parts = [TRACK_TYPES[t.type] ?? 'Track', codecLabel(t)];
  if (t.width && t.height) parts.push(`${t.width} × ${t.height}`);
  if (t.type === 1 && t.defaultDuration) parts.push(`${fmtRate(1e9 / t.defaultDuration)} fps`);
  if (t.sampleRate) parts.push(`${Math.round(t.sampleRate)} Hz`);
  if (t.channels) parts.push(`${t.channels} ch`);
  if (t.name) parts.push(`“${t.name}”`);
  if (t.language && t.language !== 'und') parts.push(t.language);
  return parts.join(' · ');
}

const fmtRate = (r: number) => String(Math.round(r * 1000) / 1000);

// ------------------------------------------------------------------ reading

function dateFromNs(ns: bigint): string {
  const ms = Number(ns / 1_000_000n) + EPOCH_2001;
  const p = dateToParts(new Date(ms));
  const frac = ((ms % 1000) + 1000) % 1000;
  if (frac) p.fraction = String(frac).padStart(3, '0');
  return toIso(p);
}

function nsFromValue(v: FieldValue): bigint {
  const p = requireDate(v, 'Date');
  const ms = partsToDate(p).getTime() + (p.fraction ? Math.round(Number(`0.${p.fraction}`) * 1000) : 0);
  if (!Number.isFinite(ms)) throw new MetadataError('Date is out of range');
  return BigInt(ms - EPOCH_2001) * 1_000_000n;
}

function infoChild(doc: Doc, id: number): EbmlElement | undefined {
  return child(doc.info, id);
}

/** Enumerate SimpleTags with their field ids (numbering repeats as NAME#2 …). */
interface TagRef {
  id: string;
  key: string;
  path: string;
  node: SimpleTag;
  owner: SimpleTag[];
  ancestors: SimpleTag[];
  tag: Tag;
}

function tagRefs(tags: Tag[]): Map<string, TagRef> {
  const out = new Map<string, TagRef>();
  const visit = (s: SimpleTag, owner: SimpleTag[], tag: Tag, ancestors: SimpleTag[], prefix: string, counts: Map<string, number>) => {
    const n = (counts.get(s.name) ?? 0) + 1;
    counts.set(s.name, n);
    const path = `${prefix}${n > 1 ? `${s.name}#${n}` : s.name}`;
    const id = `mkv:tag:${tag.key}:${path}`;
    out.set(id, { id, key: tag.key, path, node: s, owner, ancestors, tag });
    const sub = new Map<string, number>();
    for (const c of s.children) visit(c, s.children, tag, [...ancestors, s], `${path}/`, sub);
  };
  const counters = new Map<string, Map<string, number>>();
  for (const t of tags) {
    if (!counters.has(t.key)) counters.set(t.key, new Map());
    for (const s of t.simple) visit(s, t.simple, t, [], '', counters.get(t.key)!);
  }
  return out;
}

function tagField(ref: TagRef): Field {
  const s = ref.node;
  const path = ref.path.split('/');
  const leaf = path[path.length - 1].replace(/#\d+$/, '');
  const [label0, sensitivity] = tagDef(leaf);
  const lang = s.lang && s.lang !== 'und' ? ` (${s.lang})` : '';
  const label = (path.length > 1 ? `${tagDef(path[0].replace(/#\d+$/, ''))[0]} › ${label0}` : label0) + lang;
  const tag = ref.path.replace(/#\d+/g, '');
  if (s.binary) {
    return rawField(ref.id, label, `Binary data, ${formatBytes(s.binary.length)}`, { sensitivity, tag });
  }
  const value = s.value ?? '';
  let kind = tagDef(leaf)[2] ?? 'text';
  let v = value;
  if (kind === 'datetime') {
    const p = parseDate(value);
    if (p) v = toIso(p);
    else kind = 'text';
  }
  return makeField({ id: ref.id, label, kind, sensitivity, tag }, v, kind === 'datetime' ? { display: displayDate(v) } : {});
}

function tagGroupLabel(t: Tag, tracks: Track[]): string {
  if (t.trackUids.length) {
    const names = t.trackUids.map((u) => {
      const tr = tracks.find((x) => x.uid === u);
      return tr ? `track ${tr.number}${TRACK_TYPES[tr.type] ? ` (${TRACK_TYPES[tr.type].toLowerCase()})` : ''}` : `track UID ${u}`;
    });
    return `Tags — ${names.join(', ')}`;
  }
  if (/^\d+$/.test(t.key)) return t.ttv === 50 ? 'Tags' : `Tags — level ${t.ttv} (${t.targetType || TTV_NAMES[t.ttv] || 'other'})`;
  return `Tags — ${t.key}`;
}

const attachmentId = (a: Attachment, i: number) => `mkv:attachment:${a.uid !== null ? String(a.uid) : `@${i}`}`;

export async function readMatroska(src: Source): Promise<Metadata> {
  const doc = await loadDoc(src, false);
  const L = doc.layout;
  const warnings = [...doc.warnings];
  const info: InfoItem[] = [];
  const groups: FieldGroup[] = [];
  const webm = L.docType === 'webm';

  info.push({ label: 'Container', value: webm ? 'WebM' : 'Matroska' });
  const scale = infoChild(doc, ID.TimestampScale);
  const dur = infoChild(doc, ID.Duration);
  if (dur) info.push({ label: 'Duration', value: formatDuration((readFloat(dur.data) * (scale ? readUint(scale.data) : 1_000_000)) / 1e9) });
  const video = doc.tracks.find((t) => t.type === 1);
  if (video?.width && video.height) info.push({ label: 'Dimensions', value: `${video.width} × ${video.height}` });
  for (const t of doc.tracks) info.push({ label: `Track ${t.number}`, value: trackSummary(t) });
  if (doc.chapterCount) {
    info.push({
      label: 'Chapters',
      value: `${doc.chapterCount}${doc.editions > 1 ? ` in ${doc.editions} editions` : ''}`,
    });
  }
  if (L.chained) warnings.push('The file contains more than one Matroska segment; only the first one is shown and edited.');

  // Segment info
  const segFields: Field[] = [];
  const segAdd: FieldSpec[] = [];
  const titleSpec = spec('mkv:title', 'Title', 'text', { sensitivity: 'content', tag: 'Info/Title' });
  const dateSpec = spec('mkv:date', 'Date', 'datetime', {
    sensitivity: 'time',
    tag: 'Info/DateUTC',
    description: 'Date the file was created (UTC).',
  });
  const title = infoChild(doc, ID.Title);
  if (title) segFields.push(makeField(titleSpec, readText(title.data)));
  else segAdd.push(titleSpec);
  const date = infoChild(doc, ID.DateUTC);
  if (date) {
    const iso = dateFromNs(readBigInt(date.data));
    segFields.push(makeField(dateSpec, iso, { display: displayDate(iso) }));
  } else segAdd.push(dateSpec);
  const mux = infoChild(doc, ID.MuxingApp);
  const wr = infoChild(doc, ID.WritingApp);
  const appNote = `Mandatory: removing it stores “${NEUTRAL_APP}”.`;
  if (mux)
    segFields.push(
      makeField(
        spec('mkv:muxingapp', 'Muxing application', 'text', { sensitivity: 'software', tag: 'Info/MuxingApp', description: appNote }),
        readText(mux.data),
      ),
    );
  if (wr)
    segFields.push(
      makeField(
        spec('mkv:writingapp', 'Writing application', 'text', { sensitivity: 'software', tag: 'Info/WritingApp', description: appNote }),
        readText(wr.data),
      ),
    );
  const fname = infoChild(doc, ID.SegmentFilename);
  if (fname)
    segFields.push(rawField('mkv:segmentfilename', 'Segment file name', readText(fname.data), { sensitivity: 'content', tag: 'Info/SegmentFilename' }));
  const uid = infoChild(doc, ID.SegmentUID);
  if (uid) {
    segFields.push(
      rawField('mkv:segmentuid', 'Segment UID', toHex(uid.data, 16).replace(/ /g, ''), {
        tag: 'Info/SegmentUID',
        removable: false,
        description: 'Random identifier used to link segments and ordered chapters.',
      }),
    );
  }
  groups.push({ id: 'mkv.info', label: 'Segment info', source: webm ? 'WebM' : 'Matroska', fields: segFields, addable: segAdd });

  // Track names
  const trackFields: Field[] = [];
  const trackAdd: FieldSpec[] = [];
  for (const t of doc.tracks) {
    const s = spec(`mkv:track:${t.number}:name`, `Track ${t.number} name`, 'text', {
      sensitivity: 'content',
      tag: 'TrackEntry/Name',
      description: `${TRACK_TYPES[t.type] ?? 'Track'}: ${codecLabel(t)}`,
    });
    if (t.name !== null) trackFields.push(makeField(s, t.name));
    else trackAdd.push(s);
  }
  if (doc.tracks.length) groups.push({ id: 'mkv.tracks', label: 'Tracks', source: webm ? 'WebM' : 'Matroska', fields: trackFields, addable: trackAdd });

  // Tags
  const refs = [...tagRefs(doc.tags).values()];
  const keys = [...new Set(doc.tags.map((t) => t.key))];
  if (!keys.includes('50')) keys.unshift('50');
  for (const key of keys) {
    const first = doc.tags.find((t) => t.key === key);
    const fields = refs.filter((r) => r.key === key).map(tagField);
    const g: FieldGroup = {
      id: `mkv.tags.${key}`,
      label: first ? tagGroupLabel(first, doc.tracks) : 'Tags',
      source: 'Matroska tags',
      fields,
      removable: fields.length > 0,
    };
    if (key === '50') {
      const present = new Set(fields.map((f) => f.id));
      g.addable = ADDABLE_TAGS.filter((n) => !present.has(`mkv:tag:50:${n}`)).map((n) => {
        const [label, sensitivity, kind] = tagDef(n);
        return spec(`mkv:tag:50:${n}`, label, kind ?? 'text', { sensitivity, tag: n });
      });
    }
    groups.push(g);
  }

  // Attachments
  const attFields: Field[] = doc.attachments.map((a, i) => {
    const id = attachmentId(a, i);
    const tag = `AttachedFile ${a.name || '(unnamed)'}`;
    if (isImage(a) && a.data) {
      const v = imageValue(a.data, a.mime, a.description ? { description: a.description } : {});
      return makeField({ id, label: /cover/i.test(a.name) ? 'Cover art' : `Image “${a.name}”`, kind: 'image', sensitivity: 'content', tag }, v, {
        display: `${a.name} — ${describeImage(v)}`,
      });
    }
    const font = isFont(a);
    return rawField(id, font ? `Font “${a.name}”` : `Attachment “${a.name}”`, `${a.mime || 'unknown type'}, ${formatBytes(a.dataSize)}`, {
      tag,
      sensitivity: font ? undefined : 'content',
      description: font ? 'Fonts are used to render subtitles and are kept when stripping.' : undefined,
    });
  });
  const attAdd: FieldSpec[] = [];
  if (!webm && !doc.attachments.some((a) => /^cover\./i.test(a.name))) {
    attAdd.push(spec('mkv:attachment:cover', 'Cover art', 'image', { sensitivity: 'content', tag: 'AttachedFile cover' }));
  }
  groups.push({ id: 'mkv.attachments', label: 'Attachments', source: 'Matroska', fields: attFields, addable: attAdd });

  // Unknown level-1 elements and data after the segment
  const other: Field[] = doc.unknown.map((u) =>
    rawField(`mkv:element:${u.pos}`, `Unknown element 0x${u.id.toString(16).toUpperCase()}`, formatBytes(u.end - u.pos), { tag: 'Segment child' }),
  );
  if (!L.chained && L.segEnd < src.size) {
    other.push(
      rawField('mkv:trailer', 'Data after segment', `${formatBytes(src.size - L.segEnd)} after the end of the Matroska segment`, {
        sensitivity: 'content',
        tag: 'Trailer',
      }),
    );
  }
  if (other.length) groups.push({ id: 'mkv.other', label: 'Embedded data', source: 'Matroska', fields: other, removable: true });

  const hasVideo = doc.tracks.some((t) => t.type === 1);
  const hasAudio = doc.tracks.some((t) => t.type === 2);
  return {
    format: formatInfo(L.docType, hasVideo, hasAudio, src.name),
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

function formatInfo(docType: string, hasVideo: boolean, hasAudio: boolean, name: string): FormatInfo {
  const webm = docType === 'webm';
  if (!hasVideo && hasAudio) {
    return { id: 'matroska', name: webm ? 'WebM audio' : 'Matroska audio', mime: webm ? 'audio/webm' : 'audio/x-matroska', category: 'audio' };
  }
  const label = webm ? 'WebM video' : /\.mk3d$/i.test(name) ? 'Matroska 3D video' : 'Matroska video';
  return { id: 'matroska', name: label, mime: webm ? 'video/webm' : 'video/x-matroska', category: 'video' };
}

// ------------------------------------------------------------------ editing

/** Replace (in place) or remove every Info child with `id`; `el` is a serialized element. */
function setInfo(doc: Doc, id: number, el: Uint8Array | null): void {
  const at = doc.info.findIndex((e) => e.id === id);
  const next = doc.info.filter((e) => e.id !== id);
  if (el) next.splice(at >= 0 ? doc.info.slice(0, at).filter((e) => e.id !== id).length : next.length, 0, parseChildren(el)[0]);
  doc.info = next;
}

function setTrackName(t: Track, name: string | null): void {
  const kids = t.children.filter((c) => c.id !== ID.Name);
  if (name !== null) {
    const el = parseChildren(stringElement(ID.Name, name))[0];
    const after = kids.findIndex((c) => c.id === ID.TrackType);
    kids.splice(after >= 0 ? after + 1 : kids.length, 0, el);
  }
  t.children = kids;
  t.name = name;
  t.raw = null;
}

function newSimpleTag(name: string, value: string): SimpleTag {
  return { name, lang: '', value, binary: null, extra: [], children: [], raw: null };
}

function randomUid(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  b[0] &= 0x7f;
  const v = readBigUint(b);
  return v || 1n;
}

function attachedFile(a: Attachment, data: Uint8Array): Uint8Array {
  const kids: Uint8Array[] = [];
  if (a.description) kids.push(stringElement(ID.FileDescription, a.description));
  kids.push(
    stringElement(ID.FileName, a.name),
    stringElement(ID.FileMediaType, a.mime),
    element(ID.FileData, data),
    uintElement(ID.FileUID, a.uid ?? randomUid()),
  );
  return element(ID.AttachedFile, ...kids);
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

function setImage(a: Attachment, v: ReturnType<typeof asImage>): void {
  const mime = v.mime === 'image/jpg' ? 'image/jpeg' : v.mime;
  const ext = EXT[mime] ?? 'bin';
  a.name = a.name ? a.name.replace(/\.[^.]*$/, '') + `.${ext}` : `cover.${ext}`;
  a.mime = mime;
  a.data = v.data;
  a.dataSize = v.data.length;
  a.rebuilt = attachedFile(a, v.data);
}

function applyEdits(doc: Doc, edits: Edits): { dropTrailer: boolean; dropUnknown: Set<number> } {
  const webm = doc.layout.docType === 'webm';

  // Segment info
  for (const [k, e] of edits) {
    if (k === 'mkv:title') setInfo(doc, ID.Title, e.op === 'set' ? stringElement(ID.Title, asText(e.value, 'Title')) : null);
    else if (k === 'mkv:date') setInfo(doc, ID.DateUTC, e.op === 'set' ? int64Element(ID.DateUTC, nsFromValue(e.value)) : null);
    else if (k === 'mkv:muxingapp' || k === 'mkv:writingapp') {
      const id = k === 'mkv:muxingapp' ? ID.MuxingApp : ID.WritingApp;
      setInfo(doc, id, stringElement(id, e.op === 'set' ? asText(e.value, 'Application') : NEUTRAL_APP));
    } else if (k === 'mkv:segmentfilename' && e.op === 'remove') setInfo(doc, ID.SegmentFilename, null);
  }

  // Track names
  for (const [k, e] of edits) {
    const m = /^mkv:track:(\d+):name$/.exec(k);
    if (!m) continue;
    const t = doc.tracks.find((x) => x.number === +m[1]);
    if (t) setTrackName(t, e.op === 'set' ? asText(e.value, 'Track name') : null);
  }

  // Tags
  const refs = tagRefs(doc.tags);
  const dirty = (r: TagRef) => {
    r.node.raw = null;
    for (const a of r.ancestors) a.raw = null;
  };
  for (const [k, e] of edits) {
    if (k.startsWith('@group:mkv.tags.') && e.op === 'remove') {
      const key = k.slice('@group:mkv.tags.'.length);
      doc.tags = doc.tags.filter((t) => t.key !== key);
    }
  }
  for (const [k, e] of edits) {
    if (!k.startsWith('mkv:tag:')) continue;
    const ref = refs.get(k);
    if (ref) {
      if (!doc.tags.includes(ref.tag)) continue; // whole group removed
      if (e.op === 'remove') {
        const i = ref.owner.indexOf(ref.node);
        if (i >= 0) ref.owner.splice(i, 1);
        for (const a of ref.ancestors) a.raw = null;
      } else {
        if (ref.node.binary) throw new MetadataError(`Tag ${ref.path} holds binary data and cannot be edited`);
        ref.node.value = asText(e.value, ref.path);
        dirty(ref);
      }
      continue;
    }
    if (e.op !== 'set') continue;
    const m = /^mkv:tag:([^:]+):(.+)$/.exec(k);
    if (!m) continue;
    const [, key, path] = m;
    const segs = path.split('/');
    const name = segs[segs.length - 1].replace(/#\d+$/, '');
    if (!name) continue;
    const value = asText(e.value, name);
    if (segs.length > 1) {
      const parent = refs.get(`mkv:tag:${key}:${segs.slice(0, -1).join('/')}`);
      if (!parent || !doc.tags.includes(parent.tag)) continue;
      parent.node.children.push(newSimpleTag(name, value));
      dirty(parent);
      continue;
    }
    let tag = doc.tags.find((t) => t.key === key);
    if (!tag) {
      const targets = targetsFor(key);
      if (!targets) continue;
      tag = parseTag(parseChildren(element(ID.Tag, targets))[0]);
      doc.tags.push(tag);
    }
    tag.simple.push(newSimpleTag(name, value));
  }

  // Attachments
  for (const [k, e] of edits) {
    if (!k.startsWith('mkv:attachment:')) continue;
    if (k === 'mkv:attachment:cover') {
      if (e.op !== 'set') continue;
      if (webm) throw new MetadataError('WebM files cannot contain attachments (cover art)');
      const img = asImage(e.value);
      let a = doc.attachments.find((x) => /^cover\./i.test(x.name));
      if (!a) {
        a = { pos: -1, end: -1, uid: randomUid(), name: '', mime: '', description: '', dataSize: 0, data: null, rebuilt: null };
        doc.attachments.push(a);
      }
      setImage(a, img);
      continue;
    }
    const idx = doc.attachments.findIndex((a, i) => attachmentId(a, i) === k);
    if (idx < 0) continue;
    if (e.op === 'remove') doc.attachments.splice(idx, 1);
    else {
      const a = doc.attachments[idx];
      if (!isImage(a)) throw new MetadataError(`Attachment “${a.name}” is not an image and cannot be replaced`);
      setImage(a, asImage(e.value));
    }
  }

  const dropUnknown = new Set<number>();
  for (const [k, e] of edits) {
    const m = /^mkv:element:(\d+)$/.exec(k);
    if (m && e.op === 'remove') dropUnknown.add(+m[1]);
  }
  return { dropTrailer: edits.get('mkv:trailer')?.op === 'remove', dropUnknown };
}

// ----------------------------------------------------------------- assembly

type Part = Uint8Array | Blob;
const partSize = (p: Part) => (p instanceof Uint8Array ? p.length : p.size);

function serializeSimpleTag(s: SimpleTag): Uint8Array {
  if (s.raw) return s.raw;
  const kids = [stringElement(ID.TagName, s.name), ...s.extra];
  if (s.binary) kids.push(element(ID.TagBinary, s.binary));
  else kids.push(stringElement(ID.TagString, s.value ?? ''));
  for (const c of s.children) kids.push(serializeSimpleTag(c));
  return element(ID.SimpleTag, ...kids);
}

function serializeTags(tags: Tag[], crc: boolean): Uint8Array | null {
  const list = tags.filter((t) => t.simple.length).map((t) => element(ID.Tag, t.targets, ...t.simple.map(serializeSimpleTag)));
  return list.length ? master(ID.Tags, list, crc) : null;
}

function serializeTracks(doc: Doc): Uint8Array | null {
  if (!doc.tracks.length && !doc.tracksExtra.length) return null;
  const kids = doc.tracks.map((t) => t.raw ?? element(ID.TrackEntry, ...t.children.map((c) => c.raw)));
  return master(ID.Tracks, [...kids, ...doc.tracksExtra.map((e) => e.raw)], doc.useCrc);
}

function seekHead(entries: Array<{ id: number; pos: number }>, crc: boolean): Uint8Array {
  const kids = entries.map((e) => element(ID.Seek, element(ID.SeekID, encodeId(e.id)), uintElement(ID.SeekPosition, e.pos, 8)));
  return master(ID.SeekHead, kids, crc);
}

/** Rewrite Cues through `remap` (old relative position → new, or null when gone). */
function rebuildCues(points: EbmlElement[], remap: (rel: number) => number | null, fixed: boolean, crc: boolean): Uint8Array | null {
  const pos = (id: number, v: number) => uintElement(id, v, fixed ? 8 : 0);
  const out: Uint8Array[] = [];
  for (const cp of points) {
    const kids: Uint8Array[] = [];
    let positions = 0;
    for (const k of meaningful(parseChildren(cp.data))) {
      if (k.id !== ID.CueTrackPositions) {
        kids.push(k.raw);
        continue;
      }
      const tp: Uint8Array[] = [];
      let ok = false;
      for (const x of meaningful(parseChildren(k.data))) {
        if (x.id === ID.CueClusterPosition) {
          const v = remap(readUint(x.data));
          if (v === null) break;
          tp.push(pos(x.id, v));
          ok = true;
        } else if (x.id === ID.CueCodecState) {
          const old = readUint(x.data);
          const v = old ? remap(old) : 0;
          if (v !== null) tp.push(pos(x.id, v));
        } else if (x.id === ID.CueReference) {
          const ref: Uint8Array[] = [];
          let refOk = true;
          for (const r of meaningful(parseChildren(x.data))) {
            if (r.id === ID.CueRefCluster || r.id === ID.CueRefCodecState) {
              const old = readUint(r.data);
              const v = old || r.id === ID.CueRefCluster ? remap(old) : 0;
              if (v === null) refOk = false;
              else ref.push(pos(r.id, v));
            } else ref.push(r.raw);
          }
          if (refOk) tp.push(element(x.id, ...ref));
        } else tp.push(x.raw);
      }
      if (!ok) continue;
      kids.push(element(ID.CueTrackPositions, ...tp));
      positions++;
    }
    if (positions) out.push(element(ID.CuePoint, ...kids));
  }
  return out.length ? master(ID.Cues, out, crc) : null;
}

interface Piece {
  oldStart: number;
  oldEnd: number;
  /** new position relative to the segment payload */
  newStart: number;
  clusters: L1[];
}

async function assemble(doc: Doc, opts: { keepUnknown: (el: L1) => boolean; keepTrailer: boolean }): Promise<Blob> {
  const { layout: L, src } = doc;
  if (!L.complete) throw new MetadataError('Internal error: incomplete Matroska layout');
  if (L.truncated === 'damaged') throw new MetadataError('This file appears to be truncated or damaged, so it cannot be rewritten safely.');
  // A cut-off last cluster runs to the end of the file: nothing may follow it.
  const openTail = L.truncated === 'cluster';
  if (!doc.hasInfo) throw new MetadataError('This Matroska file has no Segment Info element and cannot be rewritten.');
  const crc = doc.useCrc;
  const els = L.elements;

  // Metadata elements placed before the clusters.
  const infoBytes = master(
    ID.Info,
    doc.info.map((c) => c.raw),
    crc,
  );
  const tracksBytes = serializeTracks(doc);
  const tagsBytes = serializeTags(doc.tags, crc);
  let attParts: Part[] = [];
  if (doc.attachments.length) {
    const kids = doc.attachments.map((a) => a.rebuilt ?? src.slice(a.pos, a.end));
    const size = kids.reduce((n, p) => n + partSize(p), 0);
    attParts = [header(ID.Attachments, size), ...kids];
  }

  // Cluster region: from the first to the last Cluster, keeping Clusters (and
  // unknown elements in write mode); Voids and metadata are rebuilt elsewhere.
  const firstC = els.findIndex((e) => e.id === ID.Cluster);
  let lastC = -1;
  for (let i = els.length - 1; i >= 0; i--) {
    if (els[i].id === ID.Cluster) {
      lastC = i;
      break;
    }
  }
  const unknownSet = new Set(doc.unknown);
  const isUnknown = (e: L1) => unknownSet.has(e);
  const unknownPre = els.filter((e, i) => isUnknown(e) && opts.keepUnknown(e) && (firstC < 0 || i < firstC));
  const unknownPost = els.filter((e, i) => isUnknown(e) && opts.keepUnknown(e) && firstC >= 0 && i > lastC);
  const pieces: Piece[] = [];
  if (firstC >= 0) {
    let run: Piece | null = null;
    for (let i = firstC; i <= lastC; i++) {
      const e = els[i];
      const keep = e.id === ID.Cluster || (isUnknown(e) && opts.keepUnknown(e));
      if (!keep) {
        run = null;
        continue;
      }
      if (run && run.oldEnd === e.pos) run.oldEnd = e.end;
      else {
        run = { oldStart: e.pos, oldEnd: e.end, newStart: 0, clusters: [] };
        pieces.push(run);
      }
      if (e.id === ID.Cluster) run.clusters.push(e);
    }
  }
  /** Old segment-relative position → new one (pieces are sorted and disjoint). */
  const remap = (rel: number): number | null => {
    const abs = L.segData + rel;
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = pieces[mid];
      if (abs < p.oldStart) hi = mid - 1;
      else if (abs >= p.oldEnd) lo = mid + 1;
      else return p.newStart + (abs - p.oldStart);
    }
    return null;
  };

  // Cues
  const cuePoints: EbmlElement[] = [];
  for (const c of doc.cues) cuePoints.push(...parseChildren(await elementData(src, c)).filter((e) => e.id === ID.CuePoint));
  const cuesFront = doc.cues.length > 0 && firstC >= 0 && (openTail || doc.cues[0].pos < els[firstC].pos);

  // Front block layout (sizes do not depend on positions: fixed-width values).
  const front: Array<{ id: number; parts: Part[]; seek: boolean }> = [];
  front.push({ id: ID.Info, parts: [infoBytes], seek: true });
  if (tracksBytes) front.push({ id: ID.Tracks, parts: [tracksBytes], seek: true });
  for (const c of doc.chapters) front.push({ id: ID.Chapters, parts: [src.slice(c.pos, c.end)], seek: true });
  if (attParts.length) front.push({ id: ID.Attachments, parts: attParts, seek: true });
  if (tagsBytes) front.push({ id: ID.Tags, parts: [tagsBytes], seek: true });
  for (const u of unknownPre) front.push({ id: u.id, parts: [src.slice(u.pos, u.end)], seek: false });

  const anyCues = cuePoints.length > 0 && pieces.length > 0;
  const dummyCues = anyCues ? rebuildCues(cuePoints, (r) => (remap(r) === null ? null : 0), cuesFront, crc) : null;
  const seekIds = front.filter((f) => f.seek).map((f) => f.id);
  if (dummyCues) seekIds.push(ID.Cues);
  const shSize = seekHead(
    seekIds.map((id) => ({ id, pos: 0 })),
    crc,
  ).length;

  let off = shSize;
  const entries: Array<{ id: number; pos: number }> = [];
  for (const f of front) {
    if (f.seek) entries.push({ id: f.id, pos: off });
    off += f.parts.reduce((n, p) => n + partSize(p), 0);
  }
  let cuesAt = -1;
  if (dummyCues && cuesFront) {
    cuesAt = off;
    off += dummyCues.length;
  }
  for (const p of pieces) {
    p.newStart = off;
    off += p.oldEnd - p.oldStart;
  }
  if (dummyCues && !cuesFront) cuesAt = off;
  const cuesBytes = dummyCues ? rebuildCues(cuePoints, remap, cuesFront, crc) : null;
  if (cuesBytes && cuesFront && cuesBytes.length !== dummyCues!.length) throw new MetadataError('Internal error: Cues size changed');
  if (cuesBytes) {
    entries.push({ id: ID.Cues, pos: cuesAt });
    if (!cuesFront) off += cuesBytes.length;
  }
  for (const u of unknownPost) off += u.end - u.pos;
  const sh = seekHead(entries, crc);

  // Region parts, patching cluster Position elements.
  const regionParts: Part[] = [];
  for (const p of pieces) {
    let at = p.oldStart;
    for (const c of p.clusters) {
      if (!c.position) continue;
      const newPos = p.newStart + (c.pos - p.oldStart);
      const { at: pAt, length, width } = c.position;
      regionParts.push(src.slice(at, pAt));
      regionParts.push(newPos < 2 ** (8 * width) ? uintElementFixed(ID.Position, newPos, width, length) : voidElement(length));
      at = pAt + length;
    }
    regionParts.push(src.slice(at, p.oldEnd));
  }

  const sizeWidth = Math.min(8, Math.max(1, L.maxSizeLength));
  const head = await src.read(0, L.segPos);
  const segSize = L.segUnknown || openTail ? unknownSize(sizeWidth) : encodeSize(off, sizeWidth);
  const parts: Part[] = [head, encodeId(ID.Segment), segSize, sh];
  for (const f of front) parts.push(...f.parts);
  if (cuesBytes && cuesFront) parts.push(cuesBytes);
  parts.push(...regionParts);
  if (cuesBytes && !cuesFront) parts.push(cuesBytes);
  for (const u of unknownPost) parts.push(src.slice(u.pos, u.end));
  if (opts.keepTrailer && !openTail && L.segEnd < src.size) parts.push(src.slice(L.segEnd));
  return toBlob(parts, L.docType === 'webm' ? 'video/webm' : 'video/x-matroska');
}

/** Uint element whose header+payload occupy exactly `total` bytes (the original Position slot). */
function uintElementFixed(id: number, v: number, width: number, total: number): Uint8Array {
  const idb = encodeId(id);
  const sizeLen = total - idb.length - width;
  const out = new Uint8Array(total);
  out.set(idb, 0);
  out.set(encodeSize(width, sizeLen), idb.length);
  let x = v;
  for (let i = total - 1; i >= total - width; i--) {
    out[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return out;
}

export async function writeMatroska(src: Source, edits: Edits): Promise<Blob> {
  const doc = await loadDoc(src, true);
  const { dropTrailer, dropUnknown } = applyEdits(doc, edits);
  const dropOther = edits.get(groupKey('mkv.other'))?.op === 'remove';
  if (dropOther) for (const u of doc.unknown) dropUnknown.add(u.pos);
  return assemble(doc, { keepUnknown: (e) => !dropUnknown.has(e.pos), keepTrailer: doc.layout.chained || !(dropTrailer || dropOther) });
}

export async function stripMatroska(src: Source, opts: StripOptions): Promise<Blob> {
  const doc = await loadDoc(src, true);
  for (const id of [ID.Title, ID.DateUTC, ID.SegmentFilename, ID.PrevFilename, ID.NextFilename]) setInfo(doc, id, null);
  setInfo(doc, ID.MuxingApp, stringElement(ID.MuxingApp, NEUTRAL_APP));
  setInfo(doc, ID.WritingApp, stringElement(ID.WritingApp, NEUTRAL_APP));
  for (const t of doc.tracks) if (t.name !== null) setTrackName(t, null);
  doc.tags = [];
  // Fonts stay (subtitles need them), covers on request; anything else (.nfo, .txt, .pdf…) is content.
  doc.attachments = doc.attachments.filter((a) => (isImage(a) ? opts.keepCoverArt : isFont(a)));
  return assemble(doc, { keepUnknown: () => false, keepTrailer: doc.layout.chained });
}

export const matroskaHandler: FormatHandler = {
  id: 'matroska',
  name: 'Matroska / WebM',
  category: 'video',
  extensions: ['mkv', 'mka', 'mk3d', 'webm'],
  mime: 'video/x-matroska',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) {
      const s = latin1(h.subarray(0, 64));
      return s.includes('matroska') || s.includes('webm') ? 3 : 2;
    }
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readMatroska,
  write: writeMatroska,
  strip: stripMatroska,
};
