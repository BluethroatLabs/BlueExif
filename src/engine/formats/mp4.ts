/**
 * MP4 / QuickTime / M4A / M4B / M4V / 3GPP (ISO base media file format).
 *
 * Metadata lives in the `moov` box:
 *  - iTunes-style tags: `moov/udta/meta(hdlr mdir)/ilst`
 *  - QuickTime user data text atoms (`©nam`, `©xyz` …) and 3GPP atoms
 *    (`titl`, `loci` …) directly in `moov/udta`, plus vendor atoms
 *  - QuickTime metadata keys (iPhone): `moov/meta(hdlr mdta)/keys+ilst`
 *  - XMP: top-level `uuid` box or `moov/udta/XMP_`
 *  - creation/modification dates of the movie, track and media headers
 *
 * Only top-level box headers and `moov` are read; media data is carried over
 * with Source.slice(). When boxes before the media data change size, every
 * chunk offset (`stco`/`co64`), fragment base offset (`tfhd`) and `tfra`
 * entry is relocated.
 *
 * Timed-metadata tracks (GoPro GPMF, camm, Apple mebx, Sony rtmd …) carry
 * GPS and sensor logs. Removing one drops its `trak` and every reference to
 * it (`tref`, `iods`) and zero-fills its samples inside `mdat` in place, so
 * no data survives and all other offsets stay valid. Tracks of fragmented
 * files (samples in `moof`) are kept and reported instead.
 *
 * Strip keeps Nero chapters (`udta/chpl`) because they are navigation
 * structure, removes timed-metadata tracks where possible and blanks the
 * encoder / device fingerprints of the remaining tracks (sample-entry vendor
 * and compressor name, handler names).
 */

import { Reader, Writer, concat, encodeLatin1, encodeUtf8, formatBytes, indexOfBytes, latin1, utf16, utf8OrLatin1 } from '../core/binary';
import {
  asGps,
  asImage,
  asInteger,
  asText,
  describeImage,
  displayDate,
  fmtNum,
  formatDuration,
  formatGps,
  imageValue,
  makeField,
  parseIso6709,
  rawField,
  requireDate,
  toIso,
  toIso6709,
  parseDate,
} from '../core/fields';
import {
  XMP_UUID,
  applyHeaderDateEdits,
  assemble,
  child,
  childrenOf,
  container,
  copyWithZeros,
  findPath,
  fourcc,
  fullHead,
  handlerType,
  headerDateGroup,
  hexBytes,
  leaf,
  mergeRanges,
  metaHeadSize,
  packLanguage,
  parseBoxes,
  parseFtyp,
  parseIloc,
  patchChunkOffsets,
  readPayload,
  relocateIloc,
  relocator,
  removeChildren,
  scanTopLevel,
  scrubTrackFingerprints,
  serializeIloc,
  showFourcc,
  sniffFtyp,
  sniffTopTypes,
  trackId,
  trackSampleRanges,
  zeroHeaderDates,
  HEIF_BRANDS,
  type BoxNode,
  type ContainerFn,
  type Ftyp,
  type Piece,
  type Relocate,
  type TopBox,
} from '../core/isobmff';
import {
  MetadataError,
  groupKey,
  type Category,
  type DetectContext,
  type Edit,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldSpec,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Sensitivity,
  type Source,
  type StripOptions,
} from '../core/types';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';

const G_ILST = 'mp4.ilst';
const G_MDTA = 'mp4.mdta';
const G_UDTA = 'mp4.udta';
const G_DATES = 'mp4.dates';
const G_OTHER = 'mp4.other';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex', 'tref', 'ilst']);

const isContainer: ContainerFn = (type, payload, path) => {
  if (type === 'meta') return metaHeadSize(payload);
  if (path[path.length - 1] === 'ilst') return 0; // tag items hold data/mean/name boxes
  return CONTAINERS.has(type) ? 0 : null;
};

/** Top-level boxes needed for playback; everything else is metadata or padding. */
const ESSENTIAL_TOP = new Set(['ftyp', 'moov', 'mdat', 'moof', 'mfra', 'sidx', 'ssix', 'styp', 'pdin', 'emsg']);
const PADDING = new Set(['free', 'skip', 'wide']);

// ----------------------------------------------------------------- catalogs

type IlstKind = 'text' | 'multiline' | 'int' | 'bool' | 'pair' | 'genre' | 'image' | 'gps' | 'id';

interface IlstDef {
  label: string;
  kind: IlstKind;
  sens?: Sensitivity;
  /** integer byte width */
  size?: number;
  add?: boolean;
}

const I = (label: string, kind: IlstKind, extra: Partial<IlstDef> = {}): IlstDef => ({ label, kind, ...extra });

const ILST: Record<string, IlstDef> = {
  '©nam': I('Title', 'text', { sens: 'content', add: true }),
  '©ART': I('Artist', 'text', { sens: 'identity', add: true }),
  aART: I('Album artist', 'text', { sens: 'identity', add: true }),
  '©alb': I('Album', 'text', { add: true }),
  '©day': I('Date / year', 'text', { sens: 'time', add: true }),
  '©gen': I('Genre', 'text', { add: true }),
  gnre: I('Genre (ID3 index)', 'genre'),
  trkn: I('Track number', 'pair', { add: true }),
  disk: I('Disc number', 'pair', { add: true }),
  '©cmt': I('Comment', 'multiline', { sens: 'content', add: true }),
  desc: I('Description', 'multiline', { sens: 'content', add: true }),
  ldes: I('Long description', 'multiline', { sens: 'content' }),
  '©lyr': I('Lyrics', 'multiline', { sens: 'content', add: true }),
  '©wrt': I('Composer', 'text', { sens: 'identity', add: true }),
  '©too': I('Encoder', 'text', { sens: 'software', add: true }),
  '©enc': I('Encoded by', 'text', { sens: 'identity' }),
  cprt: I('Copyright', 'text', { sens: 'identity', add: true }),
  tmpo: I('Tempo (BPM)', 'int', { size: 2, add: true }),
  cpil: I('Compilation', 'bool', { size: 1, add: true }),
  pgap: I('Gapless album', 'bool', { size: 1 }),
  '©grp': I('Grouping', 'text', { add: true }),
  '©wrk': I('Work', 'text'),
  '©mvn': I('Movement name', 'text'),
  '©mvi': I('Movement number', 'int', { size: 2 }),
  '©mvc': I('Movement count', 'int', { size: 2 }),
  shwm: I('Show movement', 'bool', { size: 1 }),
  '©st3': I('Subtitle', 'text'),
  '©dir': I('Director', 'text', { sens: 'identity' }),
  '©prd': I('Producer', 'text', { sens: 'identity' }),
  '©pub': I('Publisher', 'text', { sens: 'identity' }),
  '©lab': I('Label', 'text'),
  '©con': I('Conductor', 'text', { sens: 'identity' }),
  '©nrt': I('Narrator', 'text', { sens: 'identity' }),
  '©ope': I('Original artist', 'text', { sens: 'identity' }),
  '©prf': I('Performers', 'text', { sens: 'identity' }),
  '©xyz': I('GPS location', 'gps', { sens: 'location' }),
  sonm: I('Sort title', 'text'),
  soar: I('Sort artist', 'text', { sens: 'identity' }),
  soal: I('Sort album', 'text'),
  soaa: I('Sort album artist', 'text', { sens: 'identity' }),
  soco: I('Sort composer', 'text', { sens: 'identity' }),
  sosn: I('Sort show', 'text'),
  tvsh: I('TV show', 'text'),
  tven: I('TV episode ID', 'text'),
  tvnn: I('TV network', 'text'),
  tvsn: I('TV season', 'int', { size: 4 }),
  tves: I('TV episode', 'int', { size: 4 }),
  catg: I('Category', 'text'),
  keyw: I('Keywords', 'text', { sens: 'content' }),
  purl: I('Podcast URL', 'text'),
  egid: I('Episode GUID', 'text'),
  pcst: I('Podcast', 'bool', { size: 1 }),
  stik: I('Media kind', 'int', { size: 1 }),
  rtng: I('Content rating', 'int', { size: 1 }),
  hdvd: I('HD video', 'int', { size: 1 }),
  covr: I('Cover art', 'image', { sens: 'content' }),
  apID: I('Apple ID (purchaser)', 'text', { sens: 'identity' }),
  ownr: I('Owner', 'text', { sens: 'identity' }),
  purd: I('Purchase date', 'text', { sens: 'time' }),
  'xid ': I('Vendor ID', 'text', { sens: 'identity' }),
  atID: I('iTunes artist ID', 'id', { sens: 'identity' }),
  cnID: I('iTunes catalog ID', 'id', { sens: 'identity' }),
  plID: I('iTunes playlist ID', 'id', { sens: 'identity' }),
  geID: I('iTunes genre ID', 'id'),
  sfID: I('iTunes store country', 'id', { sens: 'identity' }),
  cmID: I('iTunes composer ID', 'id', { sens: 'identity' }),
  akID: I('iTunes account type', 'id', { sens: 'identity' }),
};

interface TextDef {
  label: string;
  sens?: Sensitivity;
  add?: boolean;
  kind?: 'multiline' | 'gps';
}

const T = (label: string, sens?: Sensitivity, add = false, kind?: TextDef['kind']): TextDef => ({ label, sens, add, kind });

/** QuickTime user-data text atoms (moov/udta/©xxx). */
const QT_TEXT: Record<string, TextDef> = {
  '©xyz': T('GPS location', 'location', true, 'gps'),
  '©nam': T('Title', 'content', true),
  '©ART': T('Artist', 'identity'),
  '©aut': T('Author', 'identity', true),
  '©alb': T('Album'),
  '©cmt': T('Comment', 'content', true, 'multiline'),
  '©cpy': T('Copyright', 'identity', true),
  '©day': T('Date', 'time', true),
  '©des': T('Description', 'content', true, 'multiline'),
  '©dir': T('Director', 'identity'),
  '©dis': T('Disclaimer'),
  '©fmt': T('Format'),
  '©gen': T('Genre'),
  '©hst': T('Host computer', 'device'),
  '©inf': T('Information', 'content', true, 'multiline'),
  '©key': T('Keywords', 'content'),
  '©mak': T('Make', 'device', true),
  '©mod': T('Model', 'device', true),
  '©ope': T('Original artist', 'identity'),
  '©PRD': T('Product'),
  '©prd': T('Producer', 'identity'),
  '©prf': T('Performers', 'identity'),
  '©req': T('Requirements'),
  '©snm': T('Subtitle'),
  '©src': T('Source credits', 'identity'),
  '©swf': T('Songwriter', 'identity'),
  '©swr': T('Software', 'software', true),
  '©too': T('Encoder', 'software'),
  '©enc': T('Encoded by', 'identity'),
  '©wrn': T('Warning'),
  '©wrt': T('Composer', 'identity'),
  '©com': T('Composer', 'identity'),
  '©url': T('URL'),
  '©lab': T('Record label'),
  '©arg': T('Arranger', 'identity'),
  '©ard': T('Art director', 'identity'),
  '©phg': T('Phonogram rights', 'identity'),
};

/** 3GPP asset atoms (moov/udta/xxxx). */
const GPP: Record<string, TextDef> = {
  titl: T('Title', 'content'),
  auth: T('Author', 'identity'),
  dscp: T('Description', 'content', false, 'multiline'),
  cprt: T('Copyright', 'identity'),
  perf: T('Performer', 'identity'),
  gnre: T('Genre'),
  albm: T('Album'),
  loci: T('Location', 'location', false, 'gps'),
  yrrc: T('Recording year', 'time'),
  kywd: T('Keywords', 'content'),
  clsf: T('Classification'),
  rtng: T('Rating'),
};

const GPP_STRING = new Set(['titl', 'auth', 'dscp', 'cprt', 'perf', 'gnre', 'albm']);

/** Vendor user-data atoms shown as raw data. */
const VENDOR_UDTA: Record<string, [string, Sensitivity?]> = {
  smta: ['Samsung metadata', 'device'],
  SDLN: ['Samsung capture mode', 'device'],
  sefd: ['Samsung extra data', 'device'],
  GPMF: ['GoPro settings / telemetry', 'device'],
  FIRM: ['GoPro firmware', 'device'],
  LENS: ['GoPro lens', 'device'],
  CAME: ['GoPro camera serial', 'device'],
  SETT: ['GoPro settings', 'device'],
  MUID: ['GoPro media ID', 'device'],
  HMMT: ['GoPro highlights', 'content'],
  BCID: ['GoPro capture ID', 'device'],
  GUMI: ['GoPro media ID', 'device'],
  NCDT: ['Nikon metadata', 'device'],
  CNCV: ['Canon compressor version', 'device'],
  CNMN: ['Canon model name', 'device'],
  CNTH: ['Canon thumbnail', 'content'],
  CNOP: ['Canon options', 'device'],
  PANA: ['Panasonic metadata', 'device'],
  LEIC: ['Leica metadata', 'device'],
  MMTA: ['Minolta metadata', 'device'],
  TAGS: ['Camera tags', 'device'],
  FFMV: ['Fujifilm metadata', 'device'],
  manu: ['Manufacturer', 'device'],
  modl: ['Model', 'device'],
  Xtra: ['Windows Media tags', 'content'],
  name: ['Name', 'content'],
  chpl: ['Chapters (Nero)', 'content'],
  hinf: ['Hint statistics'],
  hnti: ['Hint info'],
  ptv: ['Print-to-video settings'],
  WLOC: ['Player window position'],
  LOOP: ['Player loop setting'],
  SelO: ['Player selection setting'],
  AllF: ['Player frame setting'],
};

interface KeyDef {
  label: string;
  sens?: Sensitivity;
  kind?: 'multiline' | 'gps' | 'datetime';
  add?: boolean;
}

const QT = 'com.apple.quicktime.';

/** QuickTime metadata keys (moov/meta hdlr 'mdta'). */
const MDTA: Record<string, KeyDef> = {
  [`${QT}location.ISO6709`]: { label: 'GPS location', sens: 'location', kind: 'gps', add: true },
  [`${QT}make`]: { label: 'Make', sens: 'device', add: true },
  [`${QT}model`]: { label: 'Model', sens: 'device', add: true },
  [`${QT}software`]: { label: 'Software', sens: 'software', add: true },
  [`${QT}creationdate`]: { label: 'Creation date', sens: 'time', kind: 'datetime', add: true },
  [`${QT}title`]: { label: 'Title', sens: 'content', add: true },
  [`${QT}description`]: { label: 'Description', sens: 'content', kind: 'multiline', add: true },
  [`${QT}comment`]: { label: 'Comment', sens: 'content', kind: 'multiline', add: true },
  [`${QT}author`]: { label: 'Author', sens: 'identity', add: true },
  [`${QT}artist`]: { label: 'Artist', sens: 'identity' },
  [`${QT}copyright`]: { label: 'Copyright', sens: 'identity', add: true },
  [`${QT}keywords`]: { label: 'Keywords', sens: 'content' },
  [`${QT}information`]: { label: 'Information', sens: 'content' },
  [`${QT}displayname`]: { label: 'Display name', sens: 'content' },
  [`${QT}location.name`]: { label: 'Location name', sens: 'location' },
  [`${QT}location.body`]: { label: 'Location body', sens: 'location' },
  [`${QT}location.note`]: { label: 'Location note', sens: 'location' },
  [`${QT}location.role`]: { label: 'Location role', sens: 'location' },
  [`${QT}location.date`]: { label: 'Location date', sens: 'time' },
  [`${QT}location.accuracy.horizontal`]: { label: 'GPS horizontal accuracy', sens: 'location' },
  [`${QT}content.identifier`]: { label: 'Content identifier (Live Photo)', sens: 'content' },
  [`${QT}camera.identifier`]: { label: 'Camera', sens: 'device' },
  [`${QT}camera.lens_model`]: { label: 'Lens model', sens: 'device' },
  [`${QT}camera.focal_length.35mm_equivalent`]: { label: 'Focal length (35 mm)', sens: 'device' },
  'com.android.version': { label: 'Android version', sens: 'software' },
  'com.android.manufacturer': { label: 'Manufacturer', sens: 'device' },
  'com.android.model': { label: 'Model', sens: 'device' },
  encoder: { label: 'Encoder', sens: 'software' },
};

const GENRES =
  'Blues,Classic Rock,Country,Dance,Disco,Funk,Grunge,Hip-Hop,Jazz,Metal,New Age,Oldies,Other,Pop,R&B,Rap,Reggae,Rock,Techno,Industrial,Alternative,Ska,Death Metal,Pranks,Soundtrack,Euro-Techno,Ambient,Trip-Hop,Vocal,Jazz+Funk,Fusion,Trance,Classical,Instrumental,Acid,House,Game,Sound Clip,Gospel,Noise,Alternative Rock,Bass,Soul,Punk,Space,Meditative,Instrumental Pop,Instrumental Rock,Ethnic,Gothic,Darkwave,Techno-Industrial,Electronic,Pop-Folk,Eurodance,Dream,Southern Rock,Comedy,Cult,Gangsta,Top 40,Christian Rap,Pop/Funk,Jungle,Native American,Cabaret,New Wave,Psychedelic,Rave,Showtunes,Trailer,Lo-Fi,Tribal,Acid Punk,Acid Jazz,Polka,Retro,Musical,Rock & Roll,Hard Rock'.split(
    ',',
  );

const CODECS: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'HEVC',
  hev1: 'HEVC',
  dvh1: 'Dolby Vision (HEVC)',
  dvhe: 'Dolby Vision (HEVC)',
  dva1: 'Dolby Vision (H.264)',
  av01: 'AV1',
  vp08: 'VP8',
  vp09: 'VP9',
  vvc1: 'VVC',
  mp4v: 'MPEG-4 Visual',
  s263: 'H.263',
  h263: 'H.263',
  jpeg: 'Motion JPEG',
  mjpa: 'Motion JPEG',
  mjpb: 'Motion JPEG',
  'png ': 'PNG',
  'rle ': 'QuickTime Animation',
  apch: 'Apple ProRes 422 HQ',
  apcn: 'Apple ProRes 422',
  apcs: 'Apple ProRes 422 LT',
  apco: 'Apple ProRes 422 Proxy',
  ap4h: 'Apple ProRes 4444',
  ap4x: 'Apple ProRes 4444 XQ',
  mp4a: 'AAC',
  alac: 'Apple Lossless (ALAC)',
  'ac-3': 'AC-3',
  'ec-3': 'E-AC-3',
  'ac-4': 'AC-4',
  Opus: 'Opus',
  fLaC: 'FLAC',
  '.mp3': 'MP3',
  'mp3 ': 'MP3',
  samr: 'AMR-NB',
  sawb: 'AMR-WB',
  sowt: 'PCM',
  twos: 'PCM',
  lpcm: 'PCM',
  ipcm: 'PCM',
  fpcm: 'PCM',
  in24: 'PCM',
  in32: 'PCM',
  fl32: 'PCM',
  fl64: 'PCM',
  ulaw: 'µ-law',
  alaw: 'A-law',
  ima4: 'IMA ADPCM',
  tx3g: '3GPP timed text',
  text: 'QuickTime text',
  c608: 'CEA-608 captions',
  c708: 'CEA-708 captions',
  wvtt: 'WebVTT',
  stpp: 'TTML',
  mebx: 'QuickTime metadata',
  mett: 'Text metadata',
  metx: 'XML metadata',
  gpmd: 'GoPro telemetry (GPMF)',
  fdsc: 'GoPro SOS data',
  camm: 'Camera motion metadata',
  rtmd: 'Sony real-time metadata',
  djmd: 'DJI flight / camera metadata',
  dbgi: 'DJI debug data',
  tmcd: 'Timecode',
};

const TIMED_META = new Set(['mebx', 'mett', 'metx', 'urim', 'gpmd', 'fdsc', 'camm', 'rtmd', 'djmd', 'dbgi']);

const AAC_PROFILES: Record<number, string> = { 1: 'AAC Main', 2: 'AAC-LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'HE-AAC', 23: 'AAC-LD', 29: 'HE-AAC v2', 39: 'AAC-ELD', 42: 'xHE-AAC' };

const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

// --------------------------------------------------------------- parsing

interface Mp4 {
  size: number;
  top: TopBox[];
  /** start of non-box data after the last box */
  trailing: number | null;
  ftyp: Ftyp | null;
  moovBox: TopBox;
  moov: BoxNode;
  xmpBox: TopBox | null;
  xmpUuid: Uint8Array | null;
  warnings: string[];
}

async function parseMp4(src: Source): Promise<Mp4> {
  const { boxes: top, trailing } = await scanTopLevel(src);
  const warnings: string[] = [];
  const ftypBox = top.find((b) => b.type === 'ftyp');
  const ftyp = ftypBox ? parseFtyp(await readPayload(src, ftypBox)) : null;
  const moovs = top.filter((b) => b.type === 'moov');
  if (!moovs.length) throw new MetadataError('No movie header (moov box) found — the file may be incomplete or damaged');
  if (moovs.length > 1) warnings.push('File contains more than one movie header; only the first is used');
  const moovBox = moovs[0];
  const bytes = await readPayload(src, moovBox);
  const tree = parseBoxes(bytes, 0, bytes.length, isContainer, ['moov'], warnings);
  const moov: BoxNode = { type: 'moov', children: tree.boxes, tail: tree.tail };
  const xmpBox = top.find((b) => b.type === 'uuid' && b.uuid === XMP_UUID) ?? null;
  const xmpUuid = xmpBox ? await readPayload(src, xmpBox) : null;
  if (trailing !== null) warnings.push(`${formatBytes(src.size - trailing)} of unrecognised data after the last box`);
  return { size: src.size, top, trailing, ftyp, moovBox, moov, xmpBox, xmpUuid, warnings };
}

const u32 = (n: number) => new Writer(false, 4).u32(n).finish();

function dataType(d: BoxNode): number {
  return d.data && d.data.length >= 8 ? new Reader(d.data).u32(0) & 0xffffff : -1;
}

function dataValue(d: BoxNode): Uint8Array {
  return d.data ? d.data.subarray(8) : new Uint8Array(0);
}

function dataBox(type: number, value: Uint8Array): BoxNode {
  return leaf('data', u32(type), u32(0), value);
}

function readInt(v: Uint8Array, signed: boolean): number | null {
  if (!v.length || v.length > 8 || v.length === 5 || v.length === 6 || v.length === 7) return null;
  const r = new Reader(v);
  if (v.length === 8) return signed ? Number(new DataView(v.buffer, v.byteOffset).getBigInt64(0)) : r.u64(0);
  if (v.length === 1) return signed ? r.i8(0) : r.u8(0);
  if (v.length === 2) return signed ? r.i16(0) : r.u16(0);
  if (v.length === 3) {
    const n = r.u24(0);
    return signed && n & 0x800000 ? n - 0x1000000 : n;
  }
  return signed ? r.i32(0) : r.u32(0);
}

function encodeInt(n: number, size: number): Uint8Array {
  const w = new Writer(false, 8);
  if (size === 1) w.u8(n & 0xff);
  else if (size === 2) w.u16(n & 0xffff);
  else if (size === 8) {
    const d = new DataView(new ArrayBuffer(8));
    d.setBigInt64(0, BigInt(n));
    return new Uint8Array(d.buffer);
  } else w.i32(n);
  return w.finish();
}

function intSize(n: number, min = 1): number {
  for (const s of [1, 2, 4]) {
    const lim = 2 ** (s * 8 - 1);
    if (s >= min && n >= -lim && n < lim) return s;
  }
  return 8;
}

function decodeText(v: Uint8Array, type: number): string {
  if (type === 2) return utf16(v, false).replace(/\0+$/, '');
  return utf8OrLatin1(v).replace(/\0+$/, '');
}

const isPrintable = (v: Uint8Array) => v.length > 0 && v.every((c) => c >= 0x20 || c === 9 || c === 10 || c === 13);

// --------------------------------------------------------------- tracks

interface Track {
  trak: BoxNode;
  id: number;
  handler: string;
  entry: string;
  codec: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  /** seconds */
  duration: number;
  samples: number;
}

function headerFields(n: BoxNode | undefined): { version: number; timescale: number; duration: number } | null {
  const d = n?.data;
  if (!d || d.length < 24) return null;
  const r = new Reader(d);
  const v = d[0];
  if (v === 1 && d.length >= 32) return { version: 1, timescale: r.u32(20), duration: r.u64(24) };
  return { version: 0, timescale: r.u32(12), duration: r.u32(16) };
}

function esdsCodec(entry: Uint8Array): string | null {
  const i = indexOfBytes(entry, 'esds');
  if (i < 4) return null;
  const r = new Reader(entry);
  const end = Math.min(entry.length, i - 4 + r.u32(i - 4));
  let p = i + 8; // after version/flags
  const descLen = () => {
    let n = 0;
    for (let k = 0; k < 4 && p < end; k++) {
      const b = entry[p++];
      n = (n << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return n;
  };
  let oti = -1;
  while (p < end) {
    const tag = entry[p++];
    const len = descLen();
    if (tag === 0x03) {
      const flags = entry[p + 2];
      p += 3;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + entry[p];
      if (flags & 0x20) p += 2;
      continue;
    }
    if (tag === 0x04) {
      oti = entry[p];
      p += 13;
      continue;
    }
    if (tag === 0x05 && oti === 0x40) {
      let aot = entry[p] >> 3;
      if (aot === 31) aot = 32 + (((entry[p] & 7) << 3) | (entry[p + 1] >> 5));
      return AAC_PROFILES[aot] ?? 'AAC';
    }
    p += len;
  }
  if (oti === 0x40 || (oti >= 0x66 && oti <= 0x68)) return 'AAC';
  if (oti === 0x69 || oti === 0x6b) return 'MP3';
  if (oti === 0xa5) return 'AC-3';
  if (oti === 0xa6) return 'E-AC-3';
  if (oti === 0xa9 || oti === 0xaa) return 'DTS';
  if (oti === 0xdd) return 'Vorbis';
  if (oti === 0x20) return 'MPEG-4 Visual';
  return null;
}

function trackOf(trak: BoxNode): Track {
  const tkhd = child(trak, 'tkhd')?.data;
  const id = trackId(trak);
  const mdia = child(trak, 'mdia');
  const handler = handlerType(child(mdia, 'hdlr')) ?? '';
  const mdhd = headerFields(child(mdia, 'mdhd'));
  const stbl = findPath(mdia, 'minf/stbl');
  const stsd = child(stbl, 'stsd')?.data;
  const t: Track = {
    trak,
    id,
    handler,
    entry: '',
    codec: '',
    duration: mdhd && mdhd.timescale ? mdhd.duration / mdhd.timescale : 0,
    samples: 0,
  };
  const stsz = child(stbl, 'stsz')?.data ?? child(stbl, 'stz2')?.data;
  if (stsz && stsz.length >= 12) t.samples = new Reader(stsz).u32(8);
  if (stsd && stsd.length >= 16) {
    const r = new Reader(stsd);
    const size = Math.min(r.u32(8), stsd.length - 8);
    t.entry = fourcc(stsd, 12);
    const e = stsd.subarray(16, 8 + size); // sample entry payload
    t.codec = CODECS[t.entry] ?? showFourcc(t.entry);
    if (t.entry === 'mp4a') t.codec = esdsCodec(stsd.subarray(8, 8 + size)) ?? 'AAC';
    const er = new Reader(e);
    if (handler === 'vide' && e.length >= 28) {
      t.width = er.u16(24);
      t.height = er.u16(26);
    } else if (handler === 'soun' && e.length >= 28) {
      const qtVersion = er.u16(8);
      if (qtVersion === 2 && e.length >= 48) {
        t.sampleRate = Math.round(er.f64(32));
        t.channels = er.u32(40);
      } else {
        t.channels = er.u16(16);
        t.sampleRate = er.u32(24) / 65536;
      }
      if (!t.sampleRate && mdhd) t.sampleRate = mdhd.timescale;
    }
  }
  if (!t.width && handler === 'vide' && tkhd && tkhd.length >= 8) {
    const r = new Reader(tkhd);
    t.width = Math.round(r.u32(tkhd.length - 8) / 65536);
    t.height = Math.round(r.u32(tkhd.length - 4) / 65536);
  }
  return t;
}

function isTimedMeta(t: Track): boolean {
  return TIMED_META.has(t.entry) || t.handler === 'meta' || t.handler === 'camm';
}

// ------------------------------------------------------ timed-metadata tracks

/** Fragments (moof/traf) can carry samples of any track; tracks of such files are never removed. */
function isFragmented(f: Mp4, moov: BoxNode): boolean {
  return !!child(moov, 'mvex') || f.top.some((b) => b.type === 'moof');
}

interface TrackData {
  trak: BoxNode;
  /** sample bytes in this file, merged (null = sample tables unreadable) */
  ranges: Array<[number, number]> | null;
}

const trackData = (moov: BoxNode): TrackData[] => childrenOf(moov, 'trak').map((trak) => ({ trak, ranges: trackSampleRanges(trak) }));

/** Do two sorted, disjoint range lists share a byte? */
function overlaps(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  let j = 0;
  for (const [s, e] of a) {
    while (j < b.length && b[j][1] <= s) j++;
    if (j < b.length && b[j][0] < e) return true;
  }
  return false;
}

/**
 * Why a track cannot be dropped with its samples blanked in place, or null if
 * it can: the file is not fragmented, every sample lies inside an mdat
 * payload, and no byte is shared with another track.
 */
function removalProblem(f: Mp4, moov: BoxNode, data: TrackData[], trak: BoxNode): string | null {
  if (isFragmented(f, moov)) return 'the file is fragmented';
  const mine = data.find((d) => d.trak === trak)?.ranges;
  if (!mine) return 'its sample tables cannot be read';
  const mdats = f.top.filter((b) => b.type === 'mdat');
  let j = 0;
  for (const [s, e] of mine) {
    while (j < mdats.length && mdats[j].end <= s) j++;
    const b = mdats[j];
    if (!b || s < b.start + b.headerSize || e > b.end) return 'its samples lie outside the media data';
  }
  const others = mergeRanges(data.filter((d) => d.trak !== trak).flatMap((d) => d.ranges ?? []));
  if (overlaps(mine, others)) return 'its samples overlap those of another track';
  return null;
}

/** Drop track ids from the track references (tref) of a kept track. */
function dropTrackRefs(trak: BoxNode, ids: Set<number>): void {
  const tref = child(trak, 'tref');
  if (!tref?.children) return;
  for (const ref of tref.children) {
    const d = ref.data;
    if (!d) continue;
    const r = new Reader(d);
    const all: number[] = [];
    for (let p = 0; p + 4 <= d.length; p += 4) all.push(r.u32(p));
    const kept = all.filter((id) => !ids.has(id));
    if (kept.length === all.length) continue;
    const w = new Writer(false, kept.length * 4);
    for (const id of kept) w.u32(id);
    ref.data = w.finish();
  }
  removeChildren(tref, (c) => !!c.data && c.data.length < 4);
  if (!tref.children.length) removeChildren(trak, (c) => c === tref);
}

/** MPEG-4 descriptor header: tag, then a 1–4 byte length (7 bits per byte). */
function descriptor(d: Uint8Array, at: number, end: number): { tag: number; body: number; end: number } | null {
  if (at >= end) return null;
  let p = at + 1;
  let len = 0;
  for (let k = 0; k < 4; k++) {
    if (p >= end) return null;
    const b = d[p++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return p + len <= end ? { tag: d[at], body: p, end: p + len } : null;
}

/** Drop the ES_ID_Inc entries of removed tracks from the initial object descriptor (iods). */
function dropIodsRefs(moov: BoxNode, ids: Set<number>): void {
  const iods = child(moov, 'iods');
  const d = iods?.data;
  const od = d ? descriptor(d, 4, d.length) : null;
  // MP4_IOD (0x10) / IOD (0x02): flags(2) [URL | 5 profile bytes] then sub-descriptors
  if (!d || !od || (od.tag !== 0x10 && od.tag !== 0x02) || od.end - od.body < 7 || d[od.body + 1] & 0x20) return;
  const r = new Reader(d);
  const keep: Uint8Array[] = [d.subarray(od.body, od.body + 7)];
  let changed = false;
  for (let p = od.body + 7; p < od.end; ) {
    const sub = descriptor(d, p, od.end);
    if (!sub) {
      keep.push(d.subarray(p, od.end));
      break;
    }
    if (sub.tag === 0x0e && sub.end - sub.body >= 4 && ids.has(r.u32(sub.body))) changed = true;
    else keep.push(d.subarray(p, sub.end));
    p = sub.end;
  }
  if (!changed) return;
  const body = concat(keep);
  const w = new Writer(false, body.length + 16);
  w.bytes(d.subarray(0, 4)).u8(od.tag);
  if (body.length < 0x80) w.u8(body.length);
  else w.u8(0x80 | ((body.length >> 21) & 0x7f)).u8(0x80 | ((body.length >> 14) & 0x7f)).u8(0x80 | ((body.length >> 7) & 0x7f)).u8(body.length & 0x7f);
  iods!.data = w.bytes(body).bytes(d.subarray(od.end)).finish();
}

/**
 * Drop tracks and every reference to them (other tracks' tref, iods). Returns
 * the source ranges of their samples, to be blanked in place so that no data
 * survives while every other chunk offset stays valid.
 */
function removeTracks(moov: BoxNode, data: TrackData[], traks: Set<BoxNode>): Array<[number, number]> {
  const kept = childrenOf(moov, 'trak').filter((t) => !traks.has(t));
  const keptIds = new Set(kept.map(trackId));
  const ids = new Set([...traks].map(trackId).filter((id) => !keptIds.has(id)));
  removeChildren(moov, (c) => traks.has(c));
  for (const trak of kept) dropTrackRefs(trak, ids);
  dropIodsRefs(moov, ids);
  return data.filter((d) => traks.has(d.trak)).flatMap((d) => d.ranges ?? []);
}

function channelText(n: number | undefined): string {
  if (!n) return '';
  return n === 1 ? 'mono' : n === 2 ? 'stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : `${n} channels`;
}

// ------------------------------------------------------------ format info

function describeFormat(f: Mp4, tracks: Track[]): { name: string; mime: string; category: Category } {
  const major = f.ftyp?.major ?? 'qt  ';
  const hasVideo = tracks.some((t) => t.handler === 'vide' && !isTimedMeta(t));
  const audioOnly = AUDIO_BRANDS.has(major) || (!hasVideo && tracks.some((t) => t.handler === 'soun'));
  if (audioOnly) {
    if (major === 'M4B ' || major === 'F4B ') return { name: 'MPEG-4 audiobook', mime: 'audio/mp4', category: 'audio' };
    if (major.startsWith('3g')) return { name: '3GPP audio', mime: 'audio/3gpp', category: 'audio' };
    return { name: 'MPEG-4 audio', mime: 'audio/mp4', category: 'audio' };
  }
  if (major === 'qt  ') return { name: 'QuickTime movie', mime: 'video/quicktime', category: 'video' };
  if (major.startsWith('3g2')) return { name: '3GPP2 video', mime: 'video/3gpp2', category: 'video' };
  if (major.startsWith('3g')) return { name: '3GPP video', mime: 'video/3gpp', category: 'video' };
  if (major === 'M4V ' || major === 'M4VH' || major === 'M4VP') return { name: 'MPEG-4 video (iTunes)', mime: 'video/x-m4v', category: 'video' };
  return { name: 'MPEG-4 video', mime: 'video/mp4', category: 'video' };
}

function isQuickTime(f: Mp4): boolean {
  return !f.ftyp || f.ftyp.major === 'qt  ';
}

// ----------------------------------------------------------------- dates

const dateGroup = (moov: BoxNode): FieldGroup => headerDateGroup(moov, 'mp4', { id: G_DATES, source: 'QuickTime' });

const applyDateEdits = (moov: BoxNode, edits: Edits): boolean => applyHeaderDateEdits(moov, edits, 'mp4', G_DATES);

// ------------------------------------------------------------- ilst (iTunes)

interface IlstLoc {
  parent: BoxNode;
  meta: BoxNode;
  ilst: BoxNode;
}

/** iTunes-style tag list: udta/meta or moov/meta whose handler is not 'mdta'. */
function findIlst(moov: BoxNode): IlstLoc | null {
  for (const parent of [child(moov, 'udta'), moov]) {
    for (const meta of childrenOf(parent, 'meta')) {
      if (handlerType(meta) === 'mdta') continue;
      const ilst = child(meta, 'ilst');
      if (ilst && parent) return { parent, meta, ilst };
    }
  }
  return null;
}

function ensureUdta(moov: BoxNode): BoxNode {
  let udta = child(moov, 'udta');
  if (!udta) {
    udta = container('udta', []);
    moov.children!.push(udta);
  }
  return udta;
}

function hdlrBox(handler: string, maker = '\0\0\0\0'): BoxNode {
  return leaf('hdlr', fullHead(0), u32(0), encodeLatin1(handler), encodeLatin1(maker), new Uint8Array(9));
}

function createIlst(moov: BoxNode): IlstLoc {
  const udta = ensureUdta(moov);
  let meta = childrenOf(udta, 'meta').find((m) => handlerType(m) !== 'mdta');
  if (!meta) {
    meta = container('meta', [hdlrBox('mdir', 'appl')], fullHead(0));
    udta.children!.push(meta);
  }
  let ilst = child(meta, 'ilst');
  if (!ilst) {
    ilst = container('ilst', []);
    meta.children!.push(ilst);
  }
  return { parent: udta, meta, ilst };
}

interface IlstEntry {
  item: BoxNode;
  key: string;
  id: string;
  datas: BoxNode[];
  mean?: string;
  name?: string;
}

function freeformString(n: BoxNode | undefined): string {
  return n?.data && n.data.length >= 4 ? utf8OrLatin1(n.data.subarray(4)).replace(/\0+$/, '') : '';
}

function ilstEntries(ilst: BoxNode): IlstEntry[] {
  const seen = new Map<string, number>();
  return (ilst.children ?? []).map((item) => {
    let id: string;
    let mean: string | undefined;
    let name: string | undefined;
    if (item.type === '----') {
      mean = freeformString(child(item, 'mean'));
      name = freeformString(child(item, 'name'));
      id = `mp4:----:${mean}:${name}`;
    } else id = `mp4:ilst:${item.type}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `#${n}`;
    return { item, key: item.type, id, datas: childrenOf(item, 'data'), mean, name };
  });
}

function pairText(v: Uint8Array): string | null {
  if (v.length < 4) return null;
  const r = new Reader(v);
  const n = r.u16(2);
  const total = v.length >= 6 ? r.u16(4) : 0;
  return total ? `${n}/${total}` : String(n);
}

const imageMime = (type: number, v: Uint8Array) =>
  type === 13 ? 'image/jpeg' : type === 14 ? 'image/png' : type === 27 ? 'image/bmp' : imageValue(v).mime;

function ilstSpec(key: string, id: string, def: IlstDef | undefined): FieldSpec {
  const label = def?.label ?? `Tag ${showFourcc(key)}`;
  const kind =
    def?.kind === 'multiline'
      ? 'multiline'
      : def?.kind === 'int'
        ? 'integer'
        : def?.kind === 'bool'
          ? 'enum'
          : def?.kind === 'image'
            ? 'image'
            : def?.kind === 'gps'
              ? 'gps'
              : 'text';
  return {
    id,
    label,
    kind,
    sensitivity: def?.sens,
    tag: showFourcc(key),
    options: def?.kind === 'bool' ? [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }] : undefined,
    placeholder: def?.kind === 'pair' ? 'e.g. 3/12' : undefined,
  };
}

function freeformLabel(name: string): string {
  return name.replace(/^iTun/, 'iTunes ').replace(/_/g, ' ') || 'Custom tag';
}

function ilstFields(ilst: BoxNode): Field[] {
  const fields: Field[] = [];
  let covr = 0;
  for (const e of ilstEntries(ilst)) {
    if (e.key === 'covr') {
      for (const d of e.datas) {
        const v = dataValue(d);
        const img = imageValue(v.slice(), imageMime(dataType(d), v));
        const spec: FieldSpec = { id: `mp4:ilst:covr:${covr++}`, label: 'Cover art', kind: 'image', sensitivity: 'content', tag: 'covr' };
        fields.push(makeField(spec, img, { display: describeImage(img) }));
      }
      continue;
    }
    const def = e.key === '----' ? undefined : ILST[e.key];
    const tag = e.key === '----' ? `----:${e.mean}:${e.name}` : showFourcc(e.key);
    const label = e.key === '----' ? freeformLabel(e.name ?? '') : (def?.label ?? `Tag ${showFourcc(e.key)}`);
    const d = e.datas[0];
    if (!d) {
      fields.push(rawField(e.id, label, '(empty)', { tag, sensitivity: def?.sens }));
      continue;
    }
    const type = dataType(d);
    const v = dataValue(d);
    const raw = (display: string) => rawField(e.id, label, display, { tag, sensitivity: def?.sens });
    const spec = { ...ilstSpec(e.key, e.id, def), label, tag };
    const kind = def?.kind ?? (type === 1 || type === 2 ? 'text' : type === 21 || type === 22 ? 'int' : null);
    switch (kind) {
      case 'text':
      case 'multiline': {
        if (type !== 1 && type !== 2 && !(type === 0 && isPrintable(v))) {
          fields.push(raw(formatBytes(v.length)));
          break;
        }
        const s = decodeText(v, type);
        const extra = e.datas.length > 1 ? ` (+${e.datas.length - 1} more)` : '';
        fields.push(makeField({ ...spec, kind: kind === 'multiline' || s.length > 80 ? 'multiline' : 'text' }, s, extra ? { display: s + extra } : {}));
        break;
      }
      case 'gps': {
        const g = parseIso6709(decodeText(v, type));
        fields.push(g ? makeField(spec, g, { display: formatGps(g) }) : raw(decodeText(v, type)));
        break;
      }
      case 'int':
      case 'bool': {
        const n = readInt(v, type !== 22);
        if (n === null) fields.push(raw(formatBytes(v.length)));
        else if (kind === 'bool') fields.push(makeField({ ...spec, kind: 'enum' }, n ? '1' : '0', { display: n ? 'Yes' : 'No' }));
        else fields.push(makeField({ ...spec, kind: 'integer' }, n));
        break;
      }
      case 'pair': {
        const p = pairText(v);
        fields.push(p ? makeField(spec, p, { display: p.replace('/', ' of ') }) : raw(formatBytes(v.length)));
        break;
      }
      case 'genre': {
        const n = readInt(v, false) ?? 0;
        fields.push(raw(GENRES[n - 1] ?? `Genre #${n}`));
        break;
      }
      case 'id': {
        const n = readInt(v, false);
        fields.push(raw(n === null ? decodeText(v, type) : String(n)));
        break;
      }
      default:
        fields.push(raw(type === 1 ? decodeText(v, 1) : `${formatBytes(v.length)} (type ${type})`));
    }
  }
  return fields;
}

function ilstAddable(present: Set<string>, audio: boolean): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const [key, def] of Object.entries(ILST)) {
    if (!def.add) continue;
    if (!audio && (key === 'tmpo' || key === 'cpil' || key === 'trkn' || key === 'disk' || key === '©lyr')) continue;
    const id = `mp4:ilst:${key}`;
    if (present.has(id)) continue;
    out.push(ilstSpec(key, id, def));
  }
  out.push({ id: 'mp4:ilst:covr:new', label: 'Cover art', kind: 'image', sensitivity: 'content', tag: 'covr' });
  return out;
}

function encodeIlstValue(key: string, def: IlstDef | undefined, value: Edit & { op: 'set' }, existing: BoxNode | undefined): BoxNode[] {
  const label = def?.label ?? showFourcc(key);
  const v = value.value;
  const oldType = existing ? dataType(existing) : -1;
  const kind = def?.kind ?? (oldType === 21 || oldType === 22 ? 'int' : 'text');
  switch (kind) {
    case 'gps':
      return [dataBox(1, encodeUtf8(toIso6709(asGps(v))))];
    case 'int': {
      const n = asInteger(v, label);
      const oldLen = existing ? dataValue(existing).length : 0;
      return [dataBox(21, encodeInt(n, def?.size ?? (oldLen && intSize(n) <= oldLen ? oldLen : intSize(n))))];
    }
    case 'bool': {
      const s = asText(v, label).trim().toLowerCase();
      const on = s === '1' || s === 'yes' || s === 'true';
      if (!on && !['0', 'no', 'false', ''].includes(s)) throw new MetadataError(`${label}: expected yes or no`);
      return [dataBox(21, encodeInt(on ? 1 : 0, 1))];
    }
    case 'pair': {
      const m = /^\s*(\d+)\s*(?:(?:\/|of)\s*(\d+))?\s*$/i.exec(asText(v, label));
      if (!m) throw new MetadataError(`${label}: use "3" or "3/12"`);
      const n = +m[1];
      const total = m[2] ? +m[2] : 0;
      if (n > 0xffff || total > 0xffff) throw new MetadataError(`${label}: number too large`);
      const w = new Writer(false, 8).u16(0).u16(n).u16(total);
      if (key === 'trkn') w.u16(0);
      return [dataBox(0, w.finish())];
    }
    case 'image': {
      const img = asImage(v);
      const type = img.mime === 'image/jpeg' ? 13 : img.mime === 'image/png' ? 14 : img.mime === 'image/bmp' ? 27 : 0;
      if (!type) throw new MetadataError('Cover art must be a JPEG, PNG or BMP image');
      return [dataBox(type, img.data)];
    }
    case 'genre':
    case 'id':
      throw new MetadataError(`${label} cannot be edited`);
    default:
      return [dataBox(1, encodeUtf8(asText(v, label)))];
  }
}

function freeformItem(mean: string, name: string): BoxNode {
  return container('----', [leaf('mean', fullHead(0), encodeUtf8(mean)), leaf('name', fullHead(0), encodeUtf8(name))]);
}

function applyIlstEdits(moov: BoxNode, edits: Edits): boolean {
  const relevant = [...edits].filter(([k]) => k.startsWith('mp4:ilst:') || k.startsWith('mp4:----:'));
  const removeAll = edits.get(groupKey(G_ILST))?.op === 'remove';
  if (!relevant.length && !removeAll) return false;
  let loc = findIlst(moov);
  if (removeAll && loc) loc.ilst.children = [];
  for (const [id, edit] of relevant) {
    if (removeAll && edit.op === 'remove') continue;
    if (!loc) {
      if (edit.op === 'remove') continue;
      loc = createIlst(moov);
    }
    const ilst = loc.ilst;
    const entries = ilstEntries(ilst);
    // Cover art: one field per picture.
    const covr = /^mp4:ilst:covr:(\d+|new)$/.exec(id);
    if (covr) {
      const pics = entries.filter((e) => e.key === 'covr').flatMap((e) => e.datas.map((d) => ({ e, d })));
      if (covr[1] === 'new') {
        if (edit.op !== 'set') continue;
        let item = entries.find((e) => e.key === 'covr')?.item;
        if (!item) {
          item = container('covr', []);
          ilst.children!.push(item);
        }
        item.children!.push(...encodeIlstValue('covr', ILST.covr, edit, undefined));
        continue;
      }
      const pic = pics[+covr[1]];
      if (!pic) continue;
      const kids = pic.e.item.children!;
      const at = kids.indexOf(pic.d);
      if (edit.op === 'remove') kids.splice(at, 1);
      else kids.splice(at, 1, ...encodeIlstValue('covr', ILST.covr, edit, pic.d));
      if (!childrenOf(pic.e.item, 'data').length) removeChildren(ilst, (c) => c === pic.e.item);
      continue;
    }
    const entry = entries.find((e) => e.id === id);
    if (edit.op === 'remove') {
      if (entry) removeChildren(ilst, (c) => c === entry.item);
      continue;
    }
    let key: string;
    let item = entry?.item;
    if (id.startsWith('mp4:----:')) {
      key = '----';
      if (!item) {
        const m = /^mp4:----:(.+):([^:#]+)$/.exec(id);
        if (!m) throw new MetadataError(`Invalid custom tag id ${id}`);
        item = freeformItem(m[1], m[2]);
        ilst.children!.push(item);
      }
    } else {
      key = id.slice('mp4:ilst:'.length).replace(/#\d+$/, '');
      if (encodeLatin1(key).length !== 4 || /[^\x20-\x7e\xa9]/.test(key)) continue;
      if (!item) {
        item = container(key, []);
        ilst.children!.push(item);
      }
    }
    const def = key === '----' ? undefined : ILST[key];
    const fresh = encodeIlstValue(key, def, edit, childrenOf(item, 'data')[0]);
    item.children = [...item.children!.filter((c) => c.type !== 'data'), ...fresh];
    // A text genre supersedes the numeric ID3 genre.
    if (key === '©gen') removeChildren(ilst, (c) => c.type === 'gnre');
  }
  if (loc) cleanupIlst(moov, loc);
  return true;
}

/** Drop an empty ilst and the meta/udta boxes it leaves empty. */
function cleanupIlst(moov: BoxNode, loc: IlstLoc): void {
  if (loc.ilst.children!.length) return;
  removeChildren(loc.meta, (c) => c === loc.ilst);
  if (loc.meta.children!.every((c) => c.type === 'hdlr' || c.type === 'free')) removeChildren(loc.parent, (c) => c === loc.meta);
  cleanupUdta(moov);
}

function cleanupUdta(moov: BoxNode): void {
  const udta = child(moov, 'udta');
  if (udta && !udta.children!.some((c) => !PADDING.has(c.type))) removeChildren(moov, (c) => c === udta);
}

// ------------------------------------------------------- mdta (QuickTime keys)

interface MdtaEntry {
  ns: string;
  key: string;
  item: BoxNode | null;
}

interface MdtaLoc {
  parent: BoxNode;
  meta: BoxNode;
  entries: MdtaEntry[];
  orphans: number;
}

function findMdta(moov: BoxNode): MdtaLoc | null {
  for (const parent of [moov, child(moov, 'udta')]) {
    if (!parent) continue;
    const meta = childrenOf(parent, 'meta').find((m) => handlerType(m) === 'mdta');
    if (!meta) continue;
    const keys = child(meta, 'keys')?.data;
    const entries: MdtaEntry[] = [];
    if (keys && keys.length >= 8) {
      const r = new Reader(keys);
      const n = r.u32(4);
      let p = 8;
      for (let i = 0; i < n && p + 8 <= keys.length; i++) {
        const size = r.u32(p);
        if (size < 8 || p + size > keys.length) break;
        entries.push({ ns: fourcc(keys, p + 4), key: utf8OrLatin1(keys.subarray(p + 8, p + size)), item: null });
        p += size;
      }
    }
    let orphans = 0;
    for (const item of child(meta, 'ilst')?.children ?? []) {
      const idx = new Reader(encodeLatin1(item.type)).u32(0);
      if (idx >= 1 && idx <= entries.length && !entries[idx - 1].item) entries[idx - 1].item = item;
      else orphans++;
    }
    return { parent, meta, entries, orphans };
  }
  return null;
}

function keyLabel(key: string): string {
  const def = MDTA[key];
  if (def) return def.label;
  const last = key.split('.').pop() ?? key;
  return last.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function keySens(key: string): Sensitivity | undefined {
  const def = MDTA[key];
  if (def) return def.sens;
  if (/location|ISO6709|gps/i.test(key)) return 'location';
  if (/make|model|camera|lens|serial|device/i.test(key)) return 'device';
  if (/date|time/i.test(key)) return 'time';
  if (/software|version|encoder/i.test(key)) return 'software';
  if (/author|artist|owner|copyright|user/i.test(key)) return 'identity';
  return undefined;
}

function mdtaSpec(key: string): FieldSpec {
  const def = MDTA[key];
  const kind = def?.kind === 'gps' ? 'gps' : def?.kind === 'datetime' ? 'datetime' : def?.kind === 'multiline' ? 'multiline' : 'text';
  return { id: `mp4:mdta:${key}`, label: keyLabel(key), kind, sensitivity: keySens(key), tag: key };
}

/** Apple stores dates like "2024-05-01T18:29:59-0700". */
function appleDate(s: string): string | null {
  const p = parseDate(s.trim());
  return p ? toIso(p) : null;
}

function mdtaValue(d: BoxNode): { kind: 'text' | 'int' | 'float' | 'raw'; text?: string; num?: number; bytes: Uint8Array; type: number } {
  const type = dataType(d);
  const v = dataValue(d);
  if (type === 1 || type === 2) return { kind: 'text', text: decodeText(v, type), bytes: v, type };
  const r = new Reader(v);
  if ((type === 23 && v.length === 4) || (type === 24 && v.length === 8)) return { kind: 'float', num: type === 23 ? r.f32(0) : r.f64(0), bytes: v, type };
  if (type === 21 || type === 65 || type === 66 || type === 67 || type === 74) {
    const n = readInt(v, true);
    if (n !== null) return { kind: 'int', num: n, bytes: v, type };
  }
  if (type === 22 || (type >= 75 && type <= 78)) {
    const n = readInt(v, false);
    if (n !== null) return { kind: 'int', num: n, bytes: v, type };
  }
  return { kind: 'raw', bytes: v, type };
}

function mdtaFields(loc: MdtaLoc): Field[] {
  const fields: Field[] = [];
  const seen = new Set<string>();
  for (const e of loc.entries) {
    if (!e.item) continue;
    const spec = mdtaSpec(e.key);
    if (seen.has(spec.id)) continue;
    seen.add(spec.id);
    const d = childrenOf(e.item, 'data')[0];
    if (!d) continue;
    const val = mdtaValue(d);
    const def = MDTA[e.key];
    if (val.kind === 'text') {
      const s = val.text!;
      if (def?.kind === 'gps') {
        const g = parseIso6709(s);
        fields.push(g ? makeField(spec, g, { display: formatGps(g) }) : makeField({ ...spec, kind: 'text' }, s));
      } else if (def?.kind === 'datetime') {
        const iso = appleDate(s);
        fields.push(iso ? makeField(spec, iso, { display: displayDate(iso) }) : makeField({ ...spec, kind: 'text' }, s));
      } else fields.push(makeField({ ...spec, kind: spec.kind === 'multiline' || s.length > 80 ? 'multiline' : 'text' }, s));
    } else if (val.kind === 'int') fields.push(makeField({ ...spec, kind: 'integer' }, val.num!));
    else if (val.kind === 'float') fields.push(makeField({ ...spec, kind: 'number' }, val.num!, { display: fmtNum(val.num!, 6) }));
    else if (val.type === 13 || val.type === 14) {
      const img = imageValue(val.bytes.slice(), imageMime(val.type, val.bytes));
      fields.push(makeField({ ...spec, kind: 'image' }, img, { display: describeImage(img), editable: false }));
    } else fields.push(rawField(spec.id, spec.label, `${formatBytes(val.bytes.length)} (type ${val.type})`, { tag: e.key, sensitivity: spec.sensitivity }));
  }
  return fields;
}

function mdtaAddable(present: Set<string>): FieldSpec[] {
  return Object.entries(MDTA)
    .filter(([key, def]) => def.add && !present.has(`mp4:mdta:${key}`))
    .map(([key]) => mdtaSpec(key));
}

function encodeMdtaValue(key: string, edit: Edit & { op: 'set' }, existing: BoxNode | undefined): BoxNode {
  const def = MDTA[key];
  const label = keyLabel(key);
  const v = edit.value;
  if (def?.kind === 'gps') return dataBox(1, encodeUtf8(toIso6709(asGps(v))));
  if (def?.kind === 'datetime') {
    const p = requireDate(v, label);
    const iso = toIso({ ...p, fraction: undefined });
    return dataBox(1, encodeUtf8(iso.replace(/([+-]\d{2}):(\d{2})$/, '$1$2')));
  }
  const old = existing ? mdtaValue(existing) : null;
  if (old?.kind === 'int') {
    const n = asInteger(v, label);
    return dataBox(old.type, encodeInt(n, Math.max(old.bytes.length, intSize(n))));
  }
  if (old?.kind === 'float') {
    const n = Number(asText(v, label));
    if (!Number.isFinite(n)) throw new MetadataError(`${label}: expected a number`);
    const b = new Uint8Array(old.type === 23 ? 4 : 8);
    const dv = new DataView(b.buffer);
    if (old.type === 23) dv.setFloat32(0, n);
    else dv.setFloat64(0, n);
    return dataBox(old.type, b);
  }
  return dataBox(1, encodeUtf8(asText(v, label)));
}

/** New keys live in moov/meta, a plain (QuickTime-style) container as Apple and ExifTool write it. */
function createMdta(moov: BoxNode): MdtaLoc {
  const meta = container('meta', [hdlrBox('mdta'), leaf('keys', fullHead(0), u32(0)), container('ilst', [])]);
  moov.children!.push(meta);
  return { parent: moov, meta, entries: [], orphans: 0 };
}

function writeMdta(loc: MdtaLoc): void {
  const live = loc.entries.filter((e) => e.item);
  if (!live.length) {
    removeChildren(loc.parent, (c) => c === loc.meta);
    return;
  }
  const w = new Writer(false, 256);
  w.bytes(fullHead(0)).u32(live.length);
  for (const e of live) {
    const k = encodeUtf8(e.key);
    w.u32(k.length + 8).ascii(e.ns).bytes(k);
  }
  const keys: BoxNode = { type: 'keys', data: w.finish() };
  const items = live.map((e, i) => ({ ...e.item!, type: latin1(u32(i + 1)) }));
  const ilst = container('ilst', items);
  const kids = loc.meta.children!.filter((c) => c.type !== 'keys' && c.type !== 'ilst');
  const at = kids.findIndex((c) => c.type === 'hdlr') + 1;
  kids.splice(at, 0, keys, ilst);
  loc.meta.children = kids;
}

function applyMdtaEdits(moov: BoxNode, edits: Edits): boolean {
  const relevant = [...edits].filter(([k]) => k.startsWith('mp4:mdta:'));
  const removeAll = edits.get(groupKey(G_MDTA))?.op === 'remove';
  if (!relevant.length && !removeAll) return false;
  let loc = findMdta(moov);
  if (removeAll && loc) for (const e of loc.entries) e.item = null;
  for (const [id, edit] of relevant) {
    const key = id.slice('mp4:mdta:'.length);
    if (!key) continue;
    if (!loc) {
      if (edit.op === 'remove') continue;
      loc = createMdta(moov);
    }
    const matches = loc.entries.filter((e) => e.key === key && e.item);
    if (edit.op === 'remove') {
      for (const e of matches) e.item = null;
      continue;
    }
    const existing = matches[0];
    const data = encodeMdtaValue(key, edit, existing ? childrenOf(existing.item, 'data')[0] : undefined);
    if (existing) {
      existing.item = { ...existing.item!, children: [...existing.item!.children!.filter((c) => c.type !== 'data'), data] };
      for (const e of matches.slice(1)) e.item = null;
    } else loc.entries.push({ ns: 'mdta', key, item: container('xxxx', [data]) });
  }
  if (loc) {
    writeMdta(loc);
    cleanupUdta(moov);
  }
  return true;
}

// --------------------------------------------------- udta (QuickTime / 3GPP)

interface QtString {
  lang: number;
  text: string;
}

/** QuickTime international text: [u16 length][u16 language][text]… */
function parseQtText(d: Uint8Array): QtString[] | null {
  const r = new Reader(d);
  const out: QtString[] = [];
  let p = 0;
  while (p + 4 <= d.length) {
    const len = r.u16(p);
    const lang = r.u16(p + 2);
    if (len === 0 && lang === 0) break;
    if (p + 4 + len > d.length) return null;
    const b = d.subarray(p + 4, p + 4 + len);
    const text = b[0] === 0xfe && b[1] === 0xff ? utf16(b.subarray(2), false) : utf8OrLatin1(b);
    out.push({ lang, text: text.replace(/\0+$/, '') });
    p += 4 + len;
  }
  if (!out.length || d.subarray(p).some((c) => c !== 0)) return null;
  return out;
}

function qtTextPayload(text: string, lang: number): Uint8Array {
  const b = encodeUtf8(text);
  // Mac language codes (< 0x400) imply Mac Roman; switch to 'und' (UTF-8) for non-ASCII.
  const l = lang < 0x400 && b.some((c) => c > 0x7f) ? packLanguage('und') : lang;
  return new Writer(false, b.length + 4).u16(b.length).u16(l).bytes(b).finish();
}

interface GppString {
  text: string;
  next: number;
}

function gppString(d: Uint8Array, at: number): GppString {
  if (d[at] === 0xfe && d[at + 1] === 0xff) {
    let e = at + 2;
    while (e + 1 < d.length && !(d[e] === 0 && d[e + 1] === 0)) e += 2;
    return { text: utf16(d.subarray(at + 2, e), false), next: Math.min(d.length, e + 2) };
  }
  let e = at;
  while (e < d.length && d[e] !== 0) e++;
  return { text: utf8OrLatin1(d.subarray(at, e)), next: Math.min(d.length, e + 1) };
}

interface Loci {
  lang: number;
  name: string;
  role: number;
  lon: number;
  lat: number;
  alt: number;
  rest: Uint8Array;
}

function parseLoci(d: Uint8Array): Loci | null {
  if (d.length < 7) return null;
  const r = new Reader(d);
  const lang = r.u16(4);
  const name = gppString(d, 6);
  const p = name.next;
  if (p + 13 > d.length) return null;
  return { lang, name: name.text, role: d[p], lon: r.i32(p + 1) / 65536, lat: r.i32(p + 5) / 65536, alt: r.i32(p + 9) / 65536, rest: d.slice(p + 13) };
}

function lociPayload(l: Loci, g: { lat: number; lon: number; alt?: number | null }): Uint8Array {
  const fx = (n: number) => Math.round(n * 65536);
  const w = new Writer(false, 64);
  w.bytes(fullHead(0)).u16(l.lang).bytes(encodeUtf8(l.name)).u8(0).u8(l.role);
  w.i32(fx(g.lon)).i32(fx(g.lat)).i32(fx(g.alt ?? 0));
  w.bytes(l.rest.length ? l.rest : new Uint8Array([0x65, 0x61, 0x72, 0x74, 0x68, 0, 0])); // "earth\0" + notes
  return w.finish();
}

interface UdtaEntry {
  node: BoxNode;
  id: string;
}

function udtaEntries(udta: BoxNode | undefined): UdtaEntry[] {
  const seen = new Map<string, number>();
  return (udta?.children ?? []).map((node) => {
    let id = `mp4:udta:${node.type}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `#${n}`;
    return { node, id };
  });
}

type UdtaClass = 'text' | '3gp' | 'meta' | 'xmp' | 'pad' | 'vendor';

function classifyUdta(n: BoxNode): UdtaClass {
  if (n.type === 'meta') return 'meta';
  if (n.type === 'XMP_') return 'xmp';
  if (PADDING.has(n.type)) return 'pad';
  if (n.data && n.type.startsWith('©') && parseQtText(n.data)) return 'text';
  if (n.data && GPP[n.type] && n.data.length >= 6 && n.data[0] === 0) return '3gp';
  return 'vendor';
}

function udtaTextField(e: UdtaEntry): Field {
  const type = e.node.type;
  const strings = parseQtText(e.node.data!)!;
  const def = QT_TEXT[type];
  const s = strings[0].text;
  const spec: FieldSpec = {
    id: e.id,
    label: def?.label ?? `Text ${showFourcc(type)}`,
    kind: def?.kind === 'multiline' || s.length > 80 ? 'multiline' : 'text',
    sensitivity: def?.sens ?? (/^©ed\d$/.test(type) ? 'time' : undefined),
    tag: showFourcc(type),
  };
  if (def?.kind === 'gps') {
    const g = parseIso6709(s);
    if (g) return makeField({ ...spec, kind: 'gps' }, g, { display: formatGps(g) });
  }
  const more = strings.length > 1 ? ` (+${strings.length - 1} translation${strings.length > 2 ? 's' : ''})` : '';
  return makeField(spec, s, more ? { display: s + more } : {});
}

function gppField(e: UdtaEntry): Field {
  const type = e.node.type;
  const d = e.node.data!;
  const def = GPP[type];
  const r = new Reader(d);
  const spec: FieldSpec = { id: e.id, label: def.label, kind: def.kind === 'multiline' ? 'multiline' : 'text', sensitivity: def.sens, tag: type };
  const raw = (display: string) => rawField(e.id, def.label, display, { tag: type, sensitivity: def.sens });
  try {
    if (GPP_STRING.has(type)) return makeField(spec, gppString(d, 6).text);
    if (type === 'yrrc') return makeField({ ...spec, kind: 'integer' }, r.u16(4));
    if (type === 'loci') {
      const l = parseLoci(d);
      if (!l) return raw(formatBytes(d.length));
      const g = { lat: l.lat, lon: l.lon, alt: l.alt || null };
      return makeField({ ...spec, kind: 'gps' }, g, { display: `${formatGps(g)}${l.name ? ` (${l.name})` : ''}` });
    }
    if (type === 'kywd') {
      const n = d[6];
      const words: string[] = [];
      let p = 7;
      for (let i = 0; i < n && p < d.length; i++) {
        const len = d[p];
        words.push(gppString(d.subarray(p + 1, p + 1 + len), 0).text);
        p += 1 + len;
      }
      return raw(words.join(', '));
    }
    if (type === 'clsf') return raw(gppString(d, 12).text);
    if (type === 'rtng') return raw(gppString(d, 14).text);
  } catch {
    /* fall through */
  }
  return raw(formatBytes(d.length));
}

function vendorField(e: UdtaEntry): Field {
  const t = e.node.type;
  const [label, sens] = VENDOR_UDTA[t.trim()] ?? VENDOR_UDTA[t] ?? [`User data ${showFourcc(t)}`, undefined];
  const size = e.node.children ? e.node.children.length : (e.node.data?.length ?? 0);
  let display = e.node.children ? `${size} entries` : formatBytes(size);
  if (t === 'chpl' && e.node.data && e.node.data.length > 8) display = `${e.node.data[8]} chapters`;
  const d = e.node.data;
  if (d && d.length && d.length < 64 && isPrintable(d.subarray(0, d.indexOf(0) >= 0 ? d.indexOf(0) : d.length))) {
    const s = utf8OrLatin1(d).replace(/\0[\s\S]*$/, '').trim();
    if (s.length >= 2) display = s;
  }
  return rawField(e.id, label, display, {
    tag: showFourcc(t),
    sensitivity: sens,
    description: t === 'chpl' ? 'Chapter titles and times. Kept when removing all metadata.' : undefined,
  });
}

function udtaAddable(present: Set<string>): FieldSpec[] {
  return Object.entries(QT_TEXT)
    .filter(([key, def]) => def.add && !present.has(`mp4:udta:${key}`))
    .map(([key, def]) => ({
      id: `mp4:udta:${key}`,
      label: def.label,
      kind: def.kind ?? 'text',
      sensitivity: def.sens,
      tag: key,
    }));
}

function applyUdtaEdits(moov: BoxNode, edits: Edits): boolean {
  const relevant = [...edits].filter(([k]) => k.startsWith('mp4:udta:'));
  const removeAll = edits.get(groupKey(G_UDTA))?.op === 'remove';
  if (!relevant.length && !removeAll) return false;
  let udta = child(moov, 'udta');
  if (removeAll && udta) {
    const shown = new Set(udtaEntries(udta).filter((e) => ['text', '3gp'].includes(classifyUdta(e.node))).map((e) => e.node));
    removeChildren(udta, (c) => shown.has(c));
  }
  for (const [id, edit] of relevant) {
    const entry = udtaEntries(udta).find((e) => e.id === id);
    if (edit.op === 'remove') {
      if (entry && udta) removeChildren(udta, (c) => c === entry.node);
      continue;
    }
    const type = id.slice('mp4:udta:'.length).replace(/#\d+$/, '');
    const cls = entry ? classifyUdta(entry.node) : type.startsWith('©') ? 'text' : GPP[type] ? '3gp' : 'vendor';
    let data: Uint8Array;
    if (cls === 'text') {
      const lang = entry ? parseQtText(entry.node.data!)![0].lang : type === '©xyz' ? 0x15c7 : packLanguage('und');
      const text = QT_TEXT[type]?.kind === 'gps' ? toIso6709(asGps(edit.value)) : asText(edit.value, QT_TEXT[type]?.label ?? type);
      data = qtTextPayload(text, lang);
    } else if (cls === '3gp' && entry) {
      const old = entry.node.data!;
      const label = GPP[type].label;
      if (GPP_STRING.has(type)) {
        const s = gppString(old, 6);
        const tail = type === 'albm' && s.next < old.length ? old.subarray(s.next, s.next + 1) : new Uint8Array(0);
        data = new Writer(false, 64).bytes(old.subarray(0, 6)).bytes(encodeUtf8(asText(edit.value, label))).u8(0).bytes(tail).finish();
      } else if (type === 'yrrc') {
        const y = asInteger(edit.value, label);
        if (y < 0 || y > 0xffff) throw new MetadataError(`${label}: invalid year`);
        data = new Writer(false, 8).bytes(old.subarray(0, 4)).u16(y).finish();
      } else if (type === 'loci') {
        const l = parseLoci(old);
        if (!l) throw new MetadataError('Location atom is damaged and cannot be edited');
        data = lociPayload(l, asGps(edit.value));
      } else throw new MetadataError(`${label} cannot be edited`);
    } else continue;
    if (!udta) udta = ensureUdta(moov);
    if (entry) entry.node.data = data;
    else udta.children!.push({ type, data });
  }
  cleanupUdta(moov);
  return true;
}

// -------------------------------------------------------------------- XMP

interface XmpLoc {
  packet: XmpPacket | null;
  error?: string;
  /** where the packet was read from */
  where: 'uuid' | 'udta' | null;
  both: boolean;
}

function xmpOf(f: Mp4, moov: BoxNode): XmpLoc {
  const udtaXmp = child(child(moov, 'udta'), 'XMP_')?.data;
  const raw = f.xmpUuid ? f.xmpUuid : udtaXmp;
  const where = f.xmpUuid ? 'uuid' : udtaXmp ? 'udta' : null;
  if (!raw) return { packet: null, where: null, both: false };
  try {
    return { packet: parseXmp(utf8OrLatin1(raw)), where, both: !!(f.xmpUuid && udtaXmp) };
  } catch (e) {
    return { packet: null, error: `XMP could not be parsed: ${(e as Error).message}`, where, both: false };
  }
}

// ------------------------------------------------------------------ reading

const trackLabel = (t: Track) => (t.handler === 'vide' ? 'Video' : t.handler === 'soun' ? 'Audio' : t.handler === 'sbtl' || t.handler === 'subt' || t.handler === 'text' ? 'Subtitles' : t.handler === 'tmcd' ? 'Timecode' : 'Track');

function timedMetaLabel(t: Track): string {
  const what = CODECS[t.entry] ?? (t.entry ? showFourcc(t.entry) : 'metadata');
  return `Timed metadata track (${what})`;
}

export async function readMp4(src: Source): Promise<Metadata> {
  const f = await parseMp4(src);
  const moov = f.moov;
  const warnings = [...f.warnings];
  const info: InfoItem[] = [];
  const groups: FieldGroup[] = [];
  const tracks = childrenOf(moov, 'trak').map(trackOf);
  const fmt = describeFormat(f, tracks);
  const audio = fmt.category === 'audio';
  const qt = isQuickTime(f);
  const compressed = !!child(moov, 'cmov');
  if (compressed) warnings.push('The movie header is compressed (cmov); metadata cannot be edited');

  // ---- info
  if (f.ftyp) {
    const compat = [...new Set(f.ftyp.compatible)].map((b) => b.trim()).join(', ');
    info.push({ label: 'Brand', value: `${f.ftyp.major.trim()}${compat ? ` (${compat})` : ''}` });
  }
  const mvhd = headerFields(child(moov, 'mvhd'));
  let duration = mvhd && mvhd.timescale ? mvhd.duration / mvhd.timescale : 0;
  const mehd = findPath(moov, 'mvex/mehd')?.data;
  if (!duration && mehd && mvhd?.timescale) {
    const r = new Reader(mehd);
    duration = (mehd[0] === 1 ? r.u64(4) : r.u32(4)) / mvhd.timescale;
  }
  if (duration) info.push({ label: 'Duration', value: formatDuration(duration) });
  for (const t of tracks) {
    if (t.handler === 'vide' && !isTimedMeta(t)) {
      const fps = t.samples && t.duration ? ` · ${fmtNum(t.samples / t.duration, 2)} fps` : '';
      info.push({ label: 'Video', value: `${t.codec}${t.width ? ` · ${t.width} × ${t.height}` : ''}${fps}` });
    } else if (t.handler === 'soun') {
      const ch = channelText(t.channels);
      info.push({ label: 'Audio', value: `${t.codec}${t.sampleRate ? ` · ${Math.round(t.sampleRate).toLocaleString('en-US')} Hz` : ''}${ch ? ` · ${ch}` : ''}` });
    } else if (isTimedMeta(t)) {
      info.push({ label: 'Timed metadata', value: CODECS[t.entry] ?? showFourcc(t.entry || t.handler) });
    } else if (t.handler) {
      info.push({ label: trackLabel(t), value: t.codec || showFourcc(t.handler) });
    }
  }
  if (duration) info.push({ label: 'Bitrate', value: `${Math.round((f.size * 8) / duration / 1000).toLocaleString('en-US')} kbps` });
  const moofs = f.top.filter((b) => b.type === 'moof').length;
  const firstMdat = f.top.find((b) => b.type === 'mdat');
  if (moofs) info.push({ label: 'Layout', value: `Fragmented (${moofs} fragment${moofs > 1 ? 's' : ''})` });
  else if (firstMdat) info.push({ label: 'Layout', value: f.moovBox.start < firstMdat.start ? 'Fast start (index before media)' : 'Index after media' });

  // ---- iTunes tags
  const ilstLoc = findIlst(moov);
  const ilstF = ilstLoc ? ilstFields(ilstLoc.ilst) : [];
  groups.push({
    id: G_ILST,
    label: audio ? 'Tags' : 'iTunes tags',
    source: 'MP4 (ilst)',
    fields: ilstF,
    addable: compressed ? undefined : ilstAddable(new Set(ilstF.map((x) => x.id)), audio),
    removable: true,
  });

  // ---- QuickTime keys
  const mdta = findMdta(moov);
  const mdtaF = mdta ? mdtaFields(mdta) : [];
  if (mdta?.orphans) warnings.push(`${mdta.orphans} QuickTime metadata item(s) refer to missing keys`);
  if (mdtaF.length || !audio) {
    groups.push({
      id: G_MDTA,
      label: 'QuickTime metadata',
      source: 'QuickTime keys',
      fields: mdtaF,
      addable: compressed || audio ? undefined : mdtaAddable(new Set(mdtaF.map((x) => x.id))),
      removable: true,
    });
  }

  // ---- user data atoms
  const udta = child(moov, 'udta');
  const udtaF: Field[] = [];
  const other: Field[] = [];
  for (const e of udtaEntries(udta)) {
    const cls = classifyUdta(e.node);
    if (cls === 'text') udtaF.push(udtaTextField(e));
    else if (cls === '3gp') udtaF.push(gppField(e));
    else if (cls === 'vendor') other.push(vendorField(e));
    else if (cls === 'meta' && e.node !== ilstLoc?.meta && e.node !== mdta?.meta) {
      other.push(rawField(e.id, `Metadata box (${showFourcc(handlerType(e.node) ?? '?')})`, `${e.node.children?.length ?? 0} boxes`, { tag: 'udta/meta' }));
    }
  }
  if (udtaF.length || (qt && !audio)) {
    groups.push({
      id: G_UDTA,
      label: 'QuickTime user data',
      source: 'QuickTime',
      fields: udtaF,
      addable: qt && !audio && !compressed ? udtaAddable(new Set(udtaF.map((x) => x.id))) : undefined,
      removable: true,
    });
  }

  // ---- XMP
  const xmp = xmpOf(f, moov);
  if (xmp.error) warnings.push(xmp.error);
  if (xmp.both) warnings.push('File contains two XMP packets (uuid box and udta/XMP_); showing the first');
  groups.push(...xmpGroups(xmp.packet ?? { props: [] }, { addable: !compressed }));

  // ---- dates
  groups.push(dateGroup(moov));

  // ---- other embedded data
  for (const c of moov.children ?? []) {
    if (c.type === 'uuid' && c.uuid) {
      const hex = Array.from(c.uuid, (x) => x.toString(16).padStart(2, '0')).join('');
      other.push(rawField(`mp4:moov:uuid:${hex}`, 'Vendor data (uuid)', `${formatBytes(c.data?.length ?? 0)} · ${hex}`, { tag: 'moov/uuid', sensitivity: 'device' }));
    } else if (c.type === 'meta' && c !== ilstLoc?.meta && c !== mdta?.meta) {
      other.push(rawField('mp4:moov:meta', `Metadata box (${showFourcc(handlerType(c) ?? '?')})`, `${c.children?.length ?? 0} boxes`, { tag: 'moov/meta' }));
    }
  }
  let data: TrackData[] | null = null;
  for (const t of tracks) {
    if (child(t.trak, 'udta')) other.push(rawField(`mp4:trak:${t.id}:udta`, `Track ${t.id} user data`, `${child(t.trak, 'udta')!.children?.length ?? 0} entries`, { tag: 'trak/udta' }));
    if (child(t.trak, 'meta')) other.push(rawField(`mp4:trak:${t.id}:meta`, `Track ${t.id} metadata`, `${child(t.trak, 'meta')!.children?.length ?? 0} boxes`, { tag: 'trak/meta' }));
    if (isTimedMeta(t)) {
      data ??= trackData(moov);
      const problem = removalProblem(f, moov, data, t.trak);
      other.push(
        rawField(`mp4:trak:${t.id}:timed`, timedMetaLabel(t), `${t.samples} samples`, {
          tag: `trak ${t.id}`,
          sensitivity: 'location',
          removable: !problem,
          description: problem
            ? `Per-frame metadata (e.g. GPS, motion sensors) stored as a track. It is kept when removing metadata because ${problem}.`
            : 'Per-frame metadata (e.g. GPS, motion sensors) stored as a track. Removing it drops the track and blanks its data; audio and video stay untouched.',
        }),
      );
      if (problem) warnings.push(`${timedMetaLabel(t)} may contain location or sensor data; it is kept when removing metadata because ${problem}`);
    }
  }
  const seenTop = new Map<string, number>();
  for (const b of f.top) {
    if (ESSENTIAL_TOP.has(b.type) || PADDING.has(b.type) || b === f.xmpBox) continue;
    let id = b.uuid ? `mp4:box:uuid:${b.uuid}` : `mp4:box:${b.type}`;
    const n = (seenTop.get(id) ?? 0) + 1;
    seenTop.set(id, n);
    if (n > 1) id += `#${n}`;
    const label =
      b.type === 'uuid'
        ? 'Vendor data (uuid)'
        : b.type === 'meta'
          ? 'Top-level metadata box'
          : b.type === 'udta'
            ? 'Top-level user data'
            : b.type === 'pnot' || b.type === 'PICT'
              ? 'QuickTime preview'
              : b.type === 'prft'
                ? 'Producer reference time'
                : `Box ${showFourcc(b.type)}`;
    other.push(
      rawField(id, label, `${formatBytes(b.size)}${b.uuid ? ` · ${b.uuid}` : ''}`, {
        tag: showFourcc(b.type),
        sensitivity: b.type === 'prft' ? 'time' : b.type === 'uuid' ? 'device' : undefined,
      }),
    );
  }
  if (f.trailing !== null) {
    const tail = await src.read(Math.max(f.trailing, f.size - 8), 8);
    const sef = latin1(tail).includes('SEFT');
    other.push(
      rawField('mp4:trailer', sef ? 'Samsung trailer (SEF)' : 'Data after last box', formatBytes(f.size - f.trailing), {
        tag: 'Trailer',
        sensitivity: 'content',
        description: 'Extra data appended after the movie (e.g. phone-specific extras). Not needed for playback.',
      }),
    );
  }
  if (other.length) groups.push({ id: G_OTHER, label: 'Embedded data', source: fmt.name.includes('QuickTime') ? 'QuickTime' : 'MP4', fields: other });

  return {
    format: { id: 'mp4', name: fmt.name, mime: fmt.mime, category: fmt.category },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: !compressed,
    canStrip: !compressed,
  };
}

// --------------------------------------------------------------- writing

interface Plan {
  /** top-level boxes to drop */
  remove: Set<TopBox>;
  /** replacement bytes for top-level boxes */
  replace: Map<TopBox, Uint8Array>;
  /** new top-level boxes placed right after moov */
  afterMoov: Uint8Array[];
  dropTrailing: boolean;
  /** source ranges inside mdat to blank in place (samples of removed tracks) */
  zero: Array<[number, number]>;
}

const newPlan = (): Plan => ({ remove: new Set(), replace: new Map(), afterMoov: [], dropTrailing: false, zero: [] });

function xmpUuidBox(xml: Uint8Array): Uint8Array {
  const w = new Writer(false, xml.length + 24);
  w.u32(xml.length + 24).ascii('uuid').bytes(hexBytes(XMP_UUID)).bytes(xml);
  return w.finish();
}

function applyXmp(f: Mp4, moov: BoxNode, edits: Edits, plan: Plan): void {
  const removeAll = edits.get(groupKey('xmp'))?.op === 'remove';
  const has = [...edits.keys()].some((k) => k.startsWith('xmp:'));
  if (!removeAll && !has) return;
  const udta = child(moov, 'udta');
  const dropUdtaXmp = () => {
    if (udta) removeChildren(udta, (c) => c.type === 'XMP_');
  };
  const cur = xmpOf(f, moov);
  let packet: XmpPacket | null = null;
  if (!removeAll) {
    if (cur.error) throw new MetadataError(cur.error);
    packet = cur.packet ?? { props: [] };
    applyXmpEdits(packet, edits);
    if (!packet.props.length) packet = null;
  }
  if (!packet) {
    if (f.xmpBox) plan.remove.add(f.xmpBox);
    dropUdtaXmp();
    cleanupUdta(moov);
    return;
  }
  const xml = encodeUtf8(serializeXmp(packet));
  if (f.xmpBox) {
    plan.replace.set(f.xmpBox, xmpUuidBox(xml));
    dropUdtaXmp();
  } else if (cur.where === 'udta' || isQuickTime(f)) {
    const u = ensureUdta(moov);
    const node = child(u, 'XMP_');
    if (node) node.data = xml;
    else u.children!.push({ type: 'XMP_', data: xml });
  } else plan.afterMoov.push(xmpUuidBox(xml));
  cleanupUdta(moov);
}

function applyRawRemovals(f: Mp4, moov: BoxNode, edits: Edits, plan: Plan): void {
  const udta = child(moov, 'udta');
  const seenTop = new Map<string, number>();
  const topIds = new Map<string, TopBox>();
  for (const b of f.top) {
    if (ESSENTIAL_TOP.has(b.type) || PADDING.has(b.type) || b === f.xmpBox) continue;
    let id = b.uuid ? `mp4:box:uuid:${b.uuid}` : `mp4:box:${b.type}`;
    const n = (seenTop.get(id) ?? 0) + 1;
    seenTop.set(id, n);
    if (n > 1) id += `#${n}`;
    topIds.set(id, b);
  }
  const removeGroup = edits.get(groupKey(G_OTHER))?.op === 'remove';
  let cached: TrackData[] | null = null;
  const data = () => (cached ??= trackData(moov));
  const timed = new Set<BoxNode>();
  for (const [id, e] of edits) {
    if (e.op !== 'remove') continue;
    if (id === 'mp4:trailer') plan.dropTrailing = true;
    const tm = /^mp4:trak:(\d+):timed$/.exec(id);
    const track = tm && childrenOf(moov, 'trak').map(trackOf).find((t) => t.id === +tm[1] && isTimedMeta(t));
    if (track) {
      const problem = removalProblem(f, moov, data(), track.trak);
      if (problem) throw new MetadataError(`${timedMetaLabel(track)} cannot be removed: ${problem}`);
      timed.add(track.trak);
    }
    const top = topIds.get(id);
    if (top) plan.remove.add(top);
    const m = /^mp4:trak:(\d+):(udta|meta)$/.exec(id);
    if (m) {
      const trak = childrenOf(moov, 'trak').find((t) => trackOf(t).id === +m[1]);
      if (trak) removeChildren(trak, (c) => c.type === m[2]);
    }
    const u = /^mp4:moov:uuid:([0-9a-f]{32})$/.exec(id);
    if (u) removeChildren(moov, (c) => c.type === 'uuid' && !!c.uuid && Array.from(c.uuid, (x) => x.toString(16).padStart(2, '0')).join('') === u[1]);
    if (id === 'mp4:moov:meta') {
      const keep = new Set([findIlst(moov)?.meta, findMdta(moov)?.meta]);
      removeChildren(moov, (c) => c.type === 'meta' && !keep.has(c));
    }
    if (id.startsWith('mp4:udta:') && udta) {
      const entry = udtaEntries(udta).find((x) => x.id === id);
      if (entry && classifyUdta(entry.node) === 'vendor') removeChildren(udta, (c) => c === entry.node);
    }
  }
  if (removeGroup) {
    if (udta) removeChildren(udta, (c) => classifyUdta(c) === 'vendor');
    removeChildren(moov, (c) => c.type === 'uuid');
    for (const trak of childrenOf(moov, 'trak')) removeChildren(trak, (c) => c.type === 'udta' || c.type === 'meta');
    for (const b of topIds.values()) plan.remove.add(b);
    plan.dropTrailing = true;
    for (const t of childrenOf(moov, 'trak').map(trackOf)) if (isTimedMeta(t) && !removalProblem(f, moov, data(), t.trak)) timed.add(t.trak);
  }
  if (timed.size) plan.zero.push(...removeTracks(moov, data(), timed));
  cleanupUdta(moov);
}

function parseSidxRange(d: Uint8Array, end: number): [number, number] | null {
  if (d.length < 24) return null;
  const r = new Reader(d);
  const v = d[0];
  let p = 12;
  p += v === 0 ? 4 : 8; // earliest presentation time
  const firstOffset = v === 0 ? r.u32(p) : r.u64(p);
  p += v === 0 ? 4 : 8;
  p += 2;
  const count = r.u16(p);
  p += 2;
  let total = 0;
  for (let i = 0; i < count && p + 12 <= d.length; i++, p += 12) total += r.u32(p) & 0x7fffffff;
  return [end + firstOffset, end + firstOffset + total];
}

/** Relocate explicit tfhd base_data_offsets inside a moof (in place). */
function patchMoof(bytes: Uint8Array, headerSize: number, relocate: Relocate): void {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(bytes);
  let p = headerSize;
  while (p + 8 <= bytes.length) {
    const size = r.u32(p);
    if (size < 8 || p + size > bytes.length) break;
    if (fourcc(bytes, p + 4) === 'traf') {
      let q = p + 8;
      while (q + 8 <= p + size) {
        const s = r.u32(q);
        if (s < 8) break;
        if (fourcc(bytes, q + 4) === 'tfhd' && s >= 24 && r.u24(q + 9) & 1) {
          const o = relocate(r.u64(q + 16));
          v.setUint32(q + 16, Math.floor(o / 0x1_0000_0000));
          v.setUint32(q + 20, o >>> 0);
        }
        q += s;
      }
    }
    p += size;
  }
}

function patchMfra(bytes: Uint8Array, headerSize: number, relocate: Relocate): void {
  const r = new Reader(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = headerSize;
  while (p + 8 <= bytes.length) {
    const size = r.u32(p);
    if (size < 8 || p + size > bytes.length) break;
    if (fourcc(bytes, p + 4) === 'tfra' && size >= 24) {
      const ver = bytes[p + 8];
      const sizes = r.u32(p + 16);
      const trafLen = ((sizes >> 4) & 3) + 1;
      const trunLen = ((sizes >> 2) & 3) + 1;
      const sampleLen = (sizes & 3) + 1;
      const n = r.u32(p + 20);
      let q = p + 24;
      for (let i = 0; i < n && q < p + size; i++) {
        q += ver === 1 ? 8 : 4; // time
        if (ver === 1) {
          const o = relocate(r.u64(q));
          v.setUint32(q, Math.floor(o / 0x1_0000_0000));
          v.setUint32(q + 4, o >>> 0);
          q += 8;
        } else {
          const o = relocate(r.u32(q));
          if (o > 0xffffffff) throw new MetadataError('Fragment index cannot address offsets beyond 4 GB');
          v.setUint32(q, o);
          q += 4;
        }
        q += trafLen + trunLen + sampleLen;
      }
    }
    p += size;
  }
}

/** Patch iloc of a moov-level meta (rare, e.g. HEIF-in-MP4 hybrids). */
function patchMoovIloc(moov: BoxNode, relocate: Relocate): void {
  for (const meta of childrenOf(moov, 'meta')) {
    const iloc = child(meta, 'iloc');
    if (!iloc?.data) continue;
    const l = parseIloc(iloc.data);
    relocateIloc(l, relocate);
    const next = serializeIloc(l);
    if (next.length !== iloc.data.length) throw new MetadataError('Item locations inside the movie header cannot be relocated');
    iloc.data = next;
  }
}

/** Lay out the new file and relocate every absolute offset. */
async function build(src: Source, f: Mp4, moov: BoxNode, plan: Plan, mime: string): Promise<Blob> {
  const pieces: Piece[] = [];
  const special: Array<{ index: number; box: TopBox }> = [];
  // Only ever samples inside mdat payloads (checked by removalProblem).
  const zeros = mergeRanges(plan.zero);
  for (const b of f.top) {
    if (plan.remove.has(b)) continue;
    if (b === f.moovBox) {
      pieces.push({ node: moov });
      for (const x of plan.afterMoov) pieces.push({ bytes: x });
      continue;
    }
    const rep = plan.replace.get(b);
    if (rep) pieces.push({ bytes: rep });
    else if (b.type === 'mdat' && zeros.length) pieces.push(...copyWithZeros(b.start, b.end, zeros));
    else {
      if (b.type === 'moof' || b.type === 'mfra') special.push({ index: pieces.length, box: b });
      pieces.push({ copy: [b.start, b.end] });
    }
  }
  if (f.trailing !== null && !plan.dropTrailing) pieces.push({ copy: [f.trailing, f.size] });
  const relocate = relocator(pieces);
  patchChunkOffsets(moov, relocate);
  patchMoovIloc(moov, relocate);
  // Fragments (moof) with absolute base offsets and the fragment index (mfra)
  // only need patching when some kept box moved.
  const moved = f.top.some((b) => {
    if (plan.remove.has(b) || plan.replace.has(b) || b === f.moovBox) return false;
    return relocate(b.start) !== b.start;
  });
  if (moved) {
    for (const { index, box } of special) {
      const copy = (await src.read(box.start, box.size)).slice();
      if (box.type === 'moof') patchMoof(copy, box.headerSize, relocate);
      else patchMfra(copy, box.headerSize, relocate);
      pieces[index] = { bytes: copy, mirror: box.start };
    }
  }
  // Segment indexes use relative offsets: refuse if something inside a
  // referenced range changed size.
  for (const b of f.top) {
    if (b.type !== 'sidx' || plan.remove.has(b)) continue;
    const range = parseSidxRange(await readPayload(src, b), b.end);
    if (!range || range[1] <= range[0]) continue;
    const ok = (() => {
      try {
        return relocate(range[1] - 1) - relocate(b.start) === range[1] - 1 - b.start;
      } catch {
        return false;
      }
    })();
    if (!ok) throw new MetadataError('This change would invalidate the segment index (sidx) of this fragmented file');
  }
  return assemble(src, pieces, mime);
}

export async function writeMp4(src: Source, edits: Edits): Promise<Blob> {
  const f = await parseMp4(src);
  if (child(f.moov, 'cmov')) throw new MetadataError('Files with a compressed movie header cannot be edited');
  const moov = f.moov;
  const plan = newPlan();
  applyIlstEdits(moov, edits);
  applyMdtaEdits(moov, edits);
  applyUdtaEdits(moov, edits);
  applyDateEdits(moov, edits);
  applyXmp(f, moov, edits, plan);
  applyRawRemovals(f, moov, edits, plan);
  const fmt = describeFormat(f, childrenOf(moov, 'trak').map(trackOf));
  return build(src, f, moov, plan, fmt.mime);
}

export async function stripMp4(src: Source, opts: StripOptions): Promise<Blob> {
  const f = await parseMp4(src);
  if (child(f.moov, 'cmov')) throw new MetadataError('Files with a compressed movie header cannot be cleaned');
  const moov = f.moov;
  const plan = newPlan();

  // Timed-metadata tracks (GPS / sensor logs): drop them and blank their samples.
  const traks = childrenOf(moov, 'trak').map(trackOf);
  if (traks.some(isTimedMeta)) {
    const data = trackData(moov);
    const timed = new Set(traks.filter((t) => isTimedMeta(t) && !removalProblem(f, moov, data, t.trak)).map((t) => t.trak));
    if (timed.size) plan.zero.push(...removeTracks(moov, data, timed));
  }

  // Keep chapters (moov/udta/chpl), and cover art when asked — wherever the
  // iTunes tags were (udta/meta or moov/meta), it goes back to udta/meta.
  const ilst = findIlst(moov);
  const covers = opts.keepCoverArt && ilst ? childrenOf(ilst.ilst, 'covr').map((c) => container('covr', childrenOf(c, 'data'))).filter((c) => c.children!.length) : [];
  const udta = child(moov, 'udta');
  if (udta) removeChildren(udta, (c) => c.type !== 'chpl');
  removeChildren(moov, (c) => c.type === 'meta' || c.type === 'uuid' || PADDING.has(c.type));
  if (covers.length) ensureUdta(moov).children!.push(container('meta', [hdlrBox('mdir', 'appl'), container('ilst', covers)], fullHead(0)));
  cleanupUdta(moov);
  for (const trak of childrenOf(moov, 'trak')) removeChildren(trak, (c) => c.type === 'udta' || c.type === 'meta');
  zeroHeaderDates(moov);
  scrubTrackFingerprints(moov);

  for (const b of f.top) {
    if (!ESSENTIAL_TOP.has(b.type)) plan.remove.add(b);
  }
  plan.dropTrailing = true;
  const fmt = describeFormat(f, childrenOf(moov, 'trak').map(trackOf));
  return build(src, f, moov, plan, fmt.mime);
}

// ---------------------------------------------------------------- detect

const MP4_BRANDS = /^(iso[2-9a-z]|isom|mp4[12]|mp71|avc1|M4[ABPV] |M4V[HP]|qt {2}|3g[2gp]\w|3ge\w|3gs\w|dash|msdh|msix|cmf[c2]|MSNV|NDAS|XAVC|mmp4|f4[vp ab]|kddi|dby1|hvc1|av01|isml|piff|nvr1|FACE|mqt |CAEP|caqv|sdv |JVC |NX\w\w)/;

export const mp4Handler: FormatHandler = {
  id: 'mp4',
  name: 'MPEG-4 / QuickTime',
  category: 'video',
  extensions: ['mp4', 'm4v', 'mov', 'qt', 'm4a', 'm4b', 'm4r', 'm4p', '3gp', '3g2', '3gpp', 'f4v'],
  mime: 'video/mp4',
  detect(ctx: DetectContext) {
    const ftyp = sniffFtyp(ctx.head);
    if (ftyp) {
      if (HEIF_BRANDS.has(ftyp.major)) return 2;
      if (ftyp.major === 'crx ' || ftyp.major.startsWith('jp2') || ftyp.major === 'jxl ') return 1;
      return MP4_BRANDS.test(ftyp.major) || ftyp.compatible.some((b) => MP4_BRANDS.test(b)) ? 3 : 2;
    }
    const types = sniffTopTypes(ctx.head);
    if (types.length && ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(types[0])) return 2;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readMp4,
  write: writeMp4,
  strip: stripMp4,
};
