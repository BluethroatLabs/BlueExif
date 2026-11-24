/**
 * JPEG: EXIF (APP1), XMP (APP1), IPTC (APP13), comments (COM), ICC (APP2),
 * MPF (APP2), C2PA/JUMBF (APP11), vendor APPn segments and trailing data
 * (MPF secondary images, motion-photo videos…).
 *
 * The entropy-coded image data is never touched: output = rebuilt header
 * segments + original bytes from the first SOS to EOI (+ trailer). APPn/COM
 * segments found between or after the scans (where most tools stop looking)
 * are listed and can be cut out of that range; everything else in it — scans,
 * DHT/DQT/DRI, restart markers — is copied byte for byte.
 *
 * The JFIF APP0 segment stays (it tells decoders the colour space) but its
 * uncompressed thumbnail can be dropped; JFXX extension thumbnails go entirely.
 */

import { Reader, Writer, concat, encodeUtf8, formatBytes, latin1, startsWith, toBlob, utf8OrLatin1 } from '../core/binary';
import { asText, makeField, rawField } from '../core/fields';
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
  type Sensitivity,
  type Source,
  type StripOptions,
} from '../core/types';
import { applyExifEdits, exifGroups, exifOrientation, orientationOnlyExif } from '../exif/fields';
import { emptyExif, isEmptyExif, parseTiff, writeTiff, type ExifData } from '../exif/tiff';
import {
  IRB_IPTC,
  IRB_IPTC_DIGEST,
  IRB_NAMES,
  applyIptcEdits,
  iptcGroups,
  isEmptyIptc,
  parseIptc,
  parseIrb,
  serializeIptc,
  serializeIrb,
  type IptcData,
  type IrbResource,
} from '../iptc/iptc';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';

const EXIF_ID = 'Exif\0\0';
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_ID = 'http://ns.adobe.com/xmp/extension/\0';
const PS_ID = 'Photoshop 3.0\0';
const ICC_ID = 'ICC_PROFILE\0';
const MPF_ID = 'MPF\0';
const MAX_SEG = 65533;

type SegKind = 'jfif' | 'jfxx' | 'exif' | 'xmp' | 'xmpext' | 'irb' | 'icc' | 'mpf' | 'adobe' | 'ducky' | 'c2pa' | 'com' | 'app' | 'other';

interface Segment {
  marker: number;
  /** payload after the 2-byte length */
  data: Uint8Array;
  kind: SegKind;
  /** offset of the 0xFF marker in the original file */
  offset: number;
}

interface Jpeg {
  bytes: Uint8Array;
  /** header segments, up to the first SOS */
  segments: Segment[];
  /** APPn/COM segments between the first SOS and EOI (between progressive scans, before EOI…) */
  late: Segment[];
  /** offset of the first SOS marker */
  scanStart: number;
  /** offset just past EOI (or file end if EOI is missing) */
  scanEnd: number;
  trailer: Uint8Array;
  sof: { marker: number; bits: number; height: number; width: number; components: number } | null;
}

function classify(marker: number, d: Uint8Array): SegKind {
  if (marker === 0xfe) return 'com';
  if (marker === 0xe0) return startsWith(d, 'JFIF\0') ? 'jfif' : startsWith(d, 'JFXX\0') ? 'jfxx' : 'app';
  if (marker === 0xe1) {
    if (startsWith(d, 'Exif\0')) return 'exif';
    if (startsWith(d, XMP_ID)) return 'xmp';
    if (startsWith(d, XMP_EXT_ID)) return 'xmpext';
    return 'app';
  }
  if (marker === 0xe2) return startsWith(d, ICC_ID) ? 'icc' : startsWith(d, MPF_ID) ? 'mpf' : 'app';
  if (marker === 0xeb) return startsWith(d, 'JP') ? 'c2pa' : 'app';
  if (marker === 0xec) return startsWith(d, 'Ducky') ? 'ducky' : 'app';
  if (marker === 0xed) return startsWith(d, PS_ID) ? 'irb' : 'app';
  if (marker === 0xee) return startsWith(d, 'Adobe') ? 'adobe' : 'app';
  if (marker >= 0xe0 && marker <= 0xef) return 'app';
  return 'other';
}

export function parseJpeg(bytes: Uint8Array): Jpeg {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new MetadataError('Not a JPEG file');
  const r = new Reader(bytes);
  const segments: Segment[] = [];
  let p = 2;
  let sof: Jpeg['sof'] = null;
  let scanStart = -1;
  while (p < bytes.length) {
    if (bytes[p] !== 0xff) {
      // Garbage between segments: tolerate by searching the next marker.
      p++;
      continue;
    }
    while (bytes[p + 1] === 0xff) p++; // fill bytes
    const marker = bytes[p + 1];
    if (marker === 0xda) {
      scanStart = p;
      break;
    }
    if (marker === 0xd9) {
      scanStart = p;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xd8) {
      p += 2;
      continue;
    }
    if (p + 4 > bytes.length) throw new MetadataError('Truncated JPEG header');
    const len = r.u16(p + 2);
    if (len < 2 || p + 2 + len > bytes.length) throw new MetadataError('Corrupt JPEG segment length');
    const data = bytes.subarray(p + 4, p + 2 + len);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && !sof) {
      sof = { marker, bits: data[0], height: r.u16(p + 5), width: r.u16(p + 7), components: data[5] };
    }
    segments.push({ marker, data, kind: classify(marker, data), offset: p });
    p += 2 + len;
  }
  if (scanStart < 0) throw new MetadataError('JPEG has no image data (SOS not found)');

  // Walk the scans to EOI. Marker segments (SOS headers, DHT/DQT/DRI between
  // progressive scans, APPn/COM…) are skipped by their length; entropy-coded
  // data runs until an FF that is not a stuffed FF00, a fill byte or RSTn.
  const late: Segment[] = [];
  let q = scanStart;
  let scanEnd = bytes.length;
  while (q < bytes.length - 1) {
    if (bytes[q] !== 0xff) {
      q = bytes.indexOf(0xff, q + 1);
      if (q < 0) break;
      continue;
    }
    const m = bytes[q + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      q += m === 0xff ? 1 : 2;
      continue;
    }
    if (m === 0xd9) {
      scanEnd = q + 2;
      break;
    }
    if (q + 4 > bytes.length) break;
    const len = r.u16(q + 2);
    if (!sof && m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      sof = { marker: m, bits: bytes[q + 4], height: r.u16(q + 5), width: r.u16(q + 7), components: bytes[q + 9] };
    }
    if (((m >= 0xe0 && m <= 0xef) || m === 0xfe) && len >= 2 && q + 2 + len <= bytes.length) {
      const data = bytes.subarray(q + 4, q + 2 + len);
      late.push({ marker: m, data, kind: classify(m, data), offset: q });
    }
    q += 2 + len;
  }
  return { bytes, segments, late, scanStart, scanEnd, trailer: bytes.subarray(scanEnd), sof };
}

// ------------------------------------------------------------- extraction

function exifOf(j: Jpeg): { data: ExifData | null; error?: string } {
  const seg = j.segments.find((s) => s.kind === 'exif');
  if (!seg) return { data: null };
  try {
    return { data: parseTiff(seg.data.subarray(6)) };
  } catch (e) {
    return { data: null, error: `EXIF could not be parsed: ${(e as Error).message}` };
  }
}

function xmpOf(j: Jpeg): { data: XmpPacket | null; error?: string } {
  const seg = j.segments.find((s) => s.kind === 'xmp');
  if (!seg) return { data: null };
  try {
    return { data: parseXmp(utf8OrLatin1(seg.data.subarray(XMP_ID.length))) };
  } catch (e) {
    return { data: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

function irbOf(j: Jpeg): IrbResource[] | null {
  const segs = j.segments.filter((s) => s.kind === 'irb');
  if (!segs.length) return null;
  return parseIrb(concat(segs.map((s) => s.data.subarray(PS_ID.length))));
}

function iptcOf(res: IrbResource[] | null): IptcData | null {
  const r = res?.find((x) => x.id === IRB_IPTC);
  return r ? parseIptc(r.data) : null;
}

function iccOf(j: Jpeg): Uint8Array | null {
  const chunks = j.segments.filter((s) => s.kind === 'icc');
  if (!chunks.length) return null;
  chunks.sort((a, b) => a.data[12] - b.data[12]);
  return concat(chunks.map((c) => c.data.subarray(14)));
}

function describeTrailer(j: Jpeg, mpfCount: number): string {
  const t = j.trailer;
  const parts: string[] = [];
  if (mpfCount > 1) parts.push(`${mpfCount - 1} additional image${mpfCount > 2 ? 's' : ''} (MPF)`);
  const ftyp = latin1(t.subarray(0, Math.min(t.length, 1 << 20))).indexOf('ftyp');
  if (ftyp >= 4) parts.push('embedded video (motion photo)');
  if (!parts.length && t.length >= 2 && t[0] === 0xff && t[1] === 0xd8) parts.push('embedded JPEG image');
  return `${parts.length ? `${parts.join(', ')} — ` : ''}${formatBytes(t.length)} after end of image`;
}

function mpfImageCount(seg: Segment | undefined): number {
  if (!seg) return 0;
  try {
    const tiff = seg.data.subarray(4);
    const d = parseTiff(tiff);
    const n = d.ifd0.entries.find((e) => e.tag === 0xb001);
    if (!n) return 0;
    return new Reader(n.data, d.le).u32(0);
  } catch {
    return 0;
  }
}

function appLabel(s: Segment): string {
  const n = s.marker - 0xe0;
  let ident = '';
  for (let i = 0; i < Math.min(s.data.length, 24); i++) {
    const c = s.data[i];
    if (c === 0) break;
    if (c < 0x20 || c > 0x7e) {
      ident = '';
      break;
    }
    ident += String.fromCharCode(c);
  }
  return `APP${n}${ident ? ` “${ident}”` : ''}`;
}

/** Width × height of the uncompressed thumbnail in a JFIF APP0 payload, or null when it has none. */
/** Width × height of the thumbnail in a JFIF APP0 payload, or null when it has none. */
export function jfifThumbnail(d: Uint8Array): [number, number] | null {
  if (d.length < 14) return null;
  return d[12] * d[13] > 0 || d.length > 14 ? [d[12], d[13]] : null;
}

/** The JFIF APP0 payload with a 0×0 thumbnail (version, units and density kept). */
function withoutThumbnail(d: Uint8Array): Uint8Array {
  if (!jfifThumbnail(d)) return d;
  const out = d.slice(0, 14);
  out[12] = out[13] = 0;
  return out;
}

const JFXX_CODING: Record<number, string> = { 0x10: 'JPEG', 0x11: 'palette', 0x13: 'RGB' };

/** Highest risk first, as in the privacy summary. */
const RISK: Sensitivity[] = ['location', 'identity', 'device', 'time', 'software', 'content'];

function riskiest(groups: FieldGroup[]): Sensitivity | undefined {
  const found = new Set(groups.flatMap((g) => g.fields.map((f) => f.sensitivity)));
  return RISK.find((s) => found.has(s));
}

const KIND_SENSITIVITY: Partial<Record<SegKind, Sensitivity>> = {
  exif: 'device',
  xmp: 'software',
  irb: 'software',
  ducky: 'software',
  c2pa: 'software',
  com: 'content',
  jfif: 'content',
  jfxx: 'content',
  xmpext: 'content',
  mpf: 'content',
};

/** What a segment found among the scans reveals: its parsed contents when readable, else its kind. */
function lateSensitivity(s: Segment): Sensitivity | undefined {
  try {
    if (s.kind === 'exif') return riskiest(exifGroups(parseTiff(s.data.subarray(6)))) ?? 'device';
    if (s.kind === 'xmp') return riskiest(xmpGroups(parseXmp(utf8OrLatin1(s.data.subarray(XMP_ID.length))))) ?? 'software';
    if (s.kind === 'irb') {
      const iptc = iptcOf(parseIrb(s.data.subarray(PS_ID.length)));
      return (iptc && riskiest(iptcGroups(iptc))) || 'software';
    }
  } catch {
    /* unreadable: judged by its kind */
  }
  return KIND_SENSITIVITY[s.kind];
}

const LATE_LABEL: Partial<Record<SegKind, string>> = { com: 'Comment', exif: 'EXIF', xmp: 'XMP', irb: 'Photoshop / IPTC', icc: 'Color profile' };

function lateField(s: Segment, i: number): Field {
  const text = s.kind === 'com' ? utf8OrLatin1(s.data).replace(/\0+$/, '').replace(/\s+/g, ' ').trim() : '';
  const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return rawField(`jpeg:late:${i}`, `${LATE_LABEL[s.kind] ?? appLabel(s)} inside the image data`, shown ? `“${shown}”` : formatBytes(s.data.length), {
    sensitivity: lateSensitivity(s),
    tag: s.kind === 'com' ? 'COM' : appLabel(s),
    description: 'Stored between or after the compressed image scans, where most tools do not look. Removing it leaves the image data unchanged.',
  });
}

const COLOR = ['', 'Grayscale', '', 'YCbCr', 'CMYK'];

export async function readJpeg(src: Source): Promise<Metadata> {
  const j = parseJpeg(await src.bytes());
  const warnings: string[] = [];
  const groups: FieldGroup[] = [];
  const info: InfoItem[] = [];

  if (j.sof) {
    info.push({ label: 'Dimensions', value: `${j.sof.width} × ${j.sof.height}` });
    info.push({ label: 'Color', value: `${COLOR[j.sof.components] ?? `${j.sof.components} components`}, ${j.sof.bits}-bit` });
    const enc = j.sof.marker === 0xc2 || j.sof.marker === 0xc6 ? 'Progressive' : j.sof.marker === 0xc3 ? 'Lossless' : 'Baseline';
    info.push({ label: 'Encoding', value: enc });
  }

  const exif = exifOf(j);
  if (exif.error) warnings.push(exif.error);
  if (exif.data) warnings.push(...exif.data.warnings.map((w) => `EXIF: ${w}`));
  groups.push(...exifGroups(exif.data ?? emptyExif(), { addable: true }));

  const xmp = xmpOf(j);
  if (xmp.error) warnings.push(xmp.error);
  groups.push(...xmpGroups(xmp.data ?? { props: [] }, { addable: true }));

  const irb = irbOf(j);
  const iptc = iptcOf(irb);
  groups.push(...iptcGroups(iptc ?? { datasets: [] }, { addable: true }));

  // Comments
  const comments: Field[] = j.segments
    .filter((s) => s.kind === 'com')
    .map((s, i) =>
      makeField({ id: `jpeg:com:${i}`, label: 'Comment', kind: 'multiline', sensitivity: 'content', tag: 'COM' }, utf8OrLatin1(s.data).replace(/\0+$/, '')),
    );
  groups.push({
    id: 'jpeg.comments',
    label: 'Comments',
    source: 'JPEG',
    fields: comments,
    addable: [{ id: 'jpeg:com:new', label: 'Comment', kind: 'multiline', sensitivity: 'content', tag: 'COM' }],
  });

  // Other embedded blocks
  const other: Field[] = [];
  const icc = iccOf(j);
  if (icc) {
    const desc = iccDescription(icc);
    info.push({ label: 'Color profile', value: desc ?? 'Embedded ICC profile' });
    other.push(
      rawField('jpeg:icc', 'Color profile (ICC)', `${desc ?? 'ICC profile'} — ${formatBytes(icc.length)}`, {
        tag: 'APP2 ICC_PROFILE',
        description: 'Removing the color profile can make colors look different.',
      }),
    );
  }
  const jfif = j.segments.find((s) => s.kind === 'jfif');
  if (jfif && jfif.data.length >= 12) {
    const units = ['', ' dpi', ' dpcm'][jfif.data[7]] ?? '';
    const r = new Reader(jfif.data);
    info.push({ label: 'JFIF', value: `v${jfif.data[5]}.${String(jfif.data[6]).padStart(2, '0')}, ${r.u16(8)}×${r.u16(10)}${units}` });
  }
  const thumb = j.segments.find((s) => s.kind === 'jfif' && jfifThumbnail(s.data));
  if (thumb) {
    const [w, h] = jfifThumbnail(thumb.data)!;
    const what = w * h ? `${w} × ${h} pixels, uncompressed` : 'Extra data after the JFIF header';
    other.push(
      rawField('jpeg:jfifthumb', 'JFIF thumbnail', `${what} — ${formatBytes(thumb.data.length - 14)}`, {
        sensitivity: 'content',
        tag: 'APP0 JFIF',
        description: 'A small copy of the picture. It can show the image as it was before an edit or crop; removing it keeps the JFIF header.',
      }),
    );
  }
  const jfxx = j.segments.filter((s) => s.kind === 'jfxx');
  if (jfxx.length) {
    const codings = [...new Set(jfxx.map((s) => JFXX_CODING[s.data[5]] ?? 'unknown'))].join(', ');
    const size = jfxx.reduce((n, s) => n + s.data.length, 0);
    other.push(
      rawField('jpeg:jfxx', 'JFIF thumbnail', `${jfxx.length > 1 ? `${jfxx.length} thumbnails` : 'Thumbnail'} (JFXX, ${codings}) — ${formatBytes(size)}`, {
        sensitivity: 'content',
        tag: 'APP0 JFXX',
        description: 'A small copy of the picture. It can show the image as it was before an edit or crop.',
      }),
    );
  }
  const ext = j.segments.filter((s) => s.kind === 'xmpext');
  if (ext.length) {
    const size = ext.reduce((n, s) => n + s.data.length, 0);
    other.push(
      rawField('jpeg:xmpext', 'Extended XMP', `${ext.length} segment${ext.length > 1 ? 's' : ''}, ${formatBytes(size)} (e.g. depth maps, HDR data)`, {
        sensitivity: 'content',
        tag: 'APP1 XMP extension',
      }),
    );
  }
  if (irb) {
    const rest = irb.filter((x) => x.id !== IRB_IPTC && x.id !== IRB_IPTC_DIGEST);
    if (rest.length) {
      const names = [...new Set(rest.map((x) => IRB_NAMES[x.id] ?? `#${x.id.toString(16)}`))].join(', ');
      other.push(rawField('jpeg:irb', 'Photoshop resources', names, { sensitivity: 'software', tag: 'APP13 Photoshop 3.0' }));
    }
  }
  if (j.segments.some((s) => s.kind === 'ducky')) {
    other.push(rawField('jpeg:ducky', 'Photoshop “Save for Web” data', 'Quality / comment / copyright', { sensitivity: 'software', tag: 'APP12 Ducky' }));
  }
  if (j.segments.some((s) => s.kind === 'c2pa')) {
    const size = j.segments.filter((s) => s.kind === 'c2pa').reduce((n, s) => n + s.data.length, 0);
    other.push(
      rawField('jpeg:c2pa', 'Content Credentials (C2PA)', `Provenance manifest, ${formatBytes(size)}`, {
        sensitivity: 'software',
        tag: 'APP11 JUMBF',
        description: 'Signed edit history / provenance. It may name the device, software or account used.',
      }),
    );
  }
  j.segments.forEach((s, i) => {
    if (s.kind === 'app') other.push(rawField(`jpeg:app:${i}`, appLabel(s), formatBytes(s.data.length), { tag: appLabel(s) }));
  });
  j.late.forEach((s, i) => other.push(lateField(s, i)));
  const mpf = j.segments.find((s) => s.kind === 'mpf');
  const mpfCount = mpfImageCount(mpf);
  const meaningfulTrailer = j.trailer.length > 16 || j.trailer.some((b) => b !== 0);
  if (meaningfulTrailer) {
    other.push(
      rawField('jpeg:trailer', 'Data after image', describeTrailer(j, mpfCount), {
        sensitivity: 'content',
        tag: 'Trailer',
        description: 'Extra images or videos stored after the main picture (depth maps, HDR gain maps, motion photos).',
      }),
    );
  }
  if (other.length) groups.push({ id: 'jpeg.other', label: 'Embedded data', source: 'JPEG', fields: other });

  return {
    format: { id: 'jpeg', name: 'JPEG image', mime: 'image/jpeg', category: 'image' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// --------------------------------------------------------------- writing

function seg(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_SEG) throw new MetadataError(`JPEG segment too large (${payload.length} bytes)`);
  const w = new Writer(false, payload.length + 4);
  w.u8(0xff)
    .u8(marker)
    .u16(payload.length + 2)
    .bytes(payload);
  return w.finish();
}

function exifSegment(d: ExifData): Uint8Array {
  let tiff = writeTiff(d);
  if (tiff.length + 6 > MAX_SEG && d.thumbnail) {
    d.thumbnail = null;
    d.ifd1 = null;
    tiff = writeTiff(d);
  }
  if (tiff.length + 6 > MAX_SEG) throw new MetadataError('EXIF data is too large to fit in a JPEG segment');
  return seg(0xe1, concat([new TextEncoder().encode(EXIF_ID), tiff]));
}

function xmpSegment(p: XmpPacket): Uint8Array {
  let xml = serializeXmp(p);
  if (XMP_ID.length + encodeUtf8(xml).length > MAX_SEG) xml = serializeXmp(p, { padding: 0 });
  const body = concat([new TextEncoder().encode(XMP_ID), encodeUtf8(xml)]);
  if (body.length > MAX_SEG) throw new MetadataError('XMP packet is too large for a JPEG segment');
  return seg(0xe1, body);
}

function irbSegments(res: IrbResource[]): Uint8Array[] {
  const data = serializeIrb(res);
  const head = new TextEncoder().encode(PS_ID);
  const room = MAX_SEG - head.length;
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += room) out.push(seg(0xed, concat([head, data.subarray(i, i + room)])));
  return out;
}

/** Shift MPF image offsets by `delta` (offsets are relative to the MPF header). */
function patchMpf(payload: Uint8Array, delta: number): Uint8Array {
  if (!delta) return payload;
  const out = payload.slice();
  try {
    const tiff = out.subarray(4);
    const le = tiff[0] === 0x49;
    const r = new Reader(tiff, le);
    const ifd = r.u32(4);
    const n = r.u16(ifd);
    for (let i = 0; i < n; i++) {
      const p = ifd + 2 + i * 12;
      if (r.u16(p) !== 0xb002) continue;
      const count = r.u32(p + 4);
      const at = r.u32(p + 8);
      const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
      for (let k = 0; k + 16 <= count; k += 16) {
        const off = r.u32(at + k + 8);
        if (off) view.setUint32(at + k + 8, off + delta, le);
      }
    }
  } catch {
    /* leave untouched */
  }
  return out;
}

interface Plan {
  exif?: ExifData | null; // undefined = keep original segment
  xmp?: XmpPacket | null;
  irb?: IrbResource[] | null;
  comments?: string[]; // full replacement list
  drop: Set<SegKind | `app:${number}`>;
  /** rewrite JFIF APP0 segments with a 0×0 thumbnail */
  dropJfifThumb: boolean;
  /** indexes into `late` of the segments to cut out of the scan data */
  dropLate: Set<number> | 'all';
  dropTrailer: boolean;
}

/** SOS..EOI with the dropped `late` segments cut out; every other byte is copied as is. */
function scanParts(j: Jpeg, plan: Plan): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let from = j.scanStart;
  j.late.forEach((s, i) => {
    if (plan.dropLate !== 'all' && !plan.dropLate.has(i)) return;
    parts.push(j.bytes.subarray(from, s.offset));
    from = s.offset + 4 + s.data.length;
  });
  parts.push(j.bytes.subarray(from, j.scanEnd));
  return parts;
}

function assemble(j: Jpeg, plan: Plan): Blob {
  const out: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  let size = 2;
  const push = (b: Uint8Array) => {
    out.push(b);
    size += b.length;
  };
  const exifSeg = plan.exif === undefined ? undefined : plan.exif && !isEmptyExif(plan.exif) ? exifSegment(plan.exif) : null;
  const xmpSeg = plan.xmp === undefined ? undefined : plan.xmp && plan.xmp.props.length ? xmpSegment(plan.xmp) : null;
  const irbSegs = plan.irb === undefined ? undefined : plan.irb && plan.irb.length ? irbSegments(plan.irb) : null;
  const comSegs = plan.comments?.filter((c) => c.length).map((c) => seg(0xfe, encodeUtf8(c)));

  let exifDone = false;
  let xmpDone = false;
  let irbDone = false;
  let comDone = false;
  let mpfPatch: { index: number; newPos: number; oldPos: number; payload: Uint8Array } | null = null;

  const placeExifXmp = () => {
    if (!exifDone && exifSeg) push(exifSeg);
    exifDone = true;
    if (!xmpDone && xmpSeg) push(xmpSeg);
    xmpDone = true;
  };

  const jfif = (s: Segment) => seg(s.marker, plan.dropJfifThumb ? withoutThumbnail(s.data) : s.data);
  const segs = j.segments;
  // EXIF/XMP go first (after JFIF APP0 if present) when they did not exist.
  let i = 0;
  if (segs[0]?.kind === 'jfif') {
    push(jfif(segs[0]));
    i = 1;
  }
  if (!segs.some((s) => s.kind === 'exif') && exifSeg) {
    push(exifSeg);
    exifDone = true;
  }
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (plan.drop.has(s.kind) || plan.drop.has(`app:${i}`)) continue;
    switch (s.kind) {
      case 'jfif':
        push(jfif(s));
        continue;
      case 'exif':
        if (exifDone) continue; // duplicate EXIF segments are dropped
        if (exifSeg === undefined) push(seg(s.marker, s.data));
        else if (exifSeg) push(exifSeg);
        exifDone = true;
        continue;
      case 'xmp':
        if (xmpDone) continue;
        if (xmpSeg === undefined) push(seg(s.marker, s.data));
        else if (xmpSeg) push(xmpSeg);
        xmpDone = true;
        continue;
      case 'irb':
        if (irbDone) continue;
        if (irbSegs === undefined) for (const t of segs.filter((x) => x.kind === 'irb')) push(seg(t.marker, t.data));
        else if (irbSegs) for (const t of irbSegs) push(t);
        irbDone = true;
        continue;
      case 'com':
        if (comSegs === undefined) push(seg(s.marker, s.data));
        else if (!comDone) {
          for (const c of comSegs) push(c);
          comDone = true;
        }
        continue;
      case 'mpf': {
        if (plan.dropTrailer) continue;
        mpfPatch = { index: out.length, newPos: size + 8, oldPos: s.offset + 8, payload: s.data };
        push(seg(s.marker, s.data));
        continue;
      }
      default:
        // Insert new blocks before the first non-APP segment (DQT/SOF/…).
        if (!(s.marker >= 0xe0 && s.marker <= 0xef) && s.marker !== 0xfe) {
          placeExifXmp();
          if (!irbDone && irbSegs) for (const t of irbSegs) push(t);
          irbDone = true;
          if (!comDone && comSegs) for (const c of comSegs) push(c);
          comDone = true;
        }
        push(seg(s.marker, s.data));
    }
  }
  placeExifXmp();
  if (!irbDone && irbSegs) for (const t of irbSegs) push(t);
  if (!comDone && comSegs) for (const c of comSegs) push(c);

  const scan = scanParts(j, plan);
  if (mpfPatch) {
    const p = mpfPatch as { index: number; newPos: number; oldPos: number; payload: Uint8Array };
    const newTrailer = size + scan.reduce((n, b) => n + b.length, 0);
    const delta = newTrailer - p.newPos - (j.scanEnd - p.oldPos);
    out[p.index] = seg(0xe2, patchMpf(p.payload, delta));
  }
  const parts: Uint8Array[] = [...out, ...scan];
  if (!plan.dropTrailer && j.trailer.length) parts.push(j.trailer);
  return toBlob(parts, 'image/jpeg');
}

export async function writeJpeg(src: Source, edits: Edits): Promise<Blob> {
  const j = parseJpeg(await src.bytes());
  const late = new Set<number>();
  const plan: Plan = { drop: new Set(), dropJfifThumb: false, dropLate: late, dropTrailer: false };

  // EXIF
  const hasExifEdits = [...edits.keys()].some((k) => k.startsWith('exif:'));
  if (edits.get(groupKey('exif'))?.op === 'remove') plan.exif = null;
  else if (hasExifEdits) {
    const cur = exifOf(j);
    if (cur.error) throw new MetadataError(cur.error);
    const d = cur.data ?? emptyExif(false);
    applyExifEdits(d, edits);
    plan.exif = d;
  }

  // XMP
  if (edits.get(groupKey('xmp'))?.op === 'remove') plan.xmp = null;
  else if ([...edits.keys()].some((k) => k.startsWith('xmp:'))) {
    const cur = xmpOf(j);
    if (cur.error) throw new MetadataError(cur.error);
    const p = cur.data ?? { props: [] };
    applyXmpEdits(p, edits);
    plan.xmp = p;
  }

  // IPTC / Photoshop resources
  const iptcRemoved = edits.get(groupKey('iptc'))?.op === 'remove';
  const hasIptc = [...edits.keys()].some((k) => k.startsWith('iptc:'));
  const irbRemoved = edits.get('jpeg:irb')?.op === 'remove';
  if (iptcRemoved || hasIptc || irbRemoved) {
    let res = irbOf(j) ?? [];
    if (irbRemoved) res = res.filter((x) => x.id === IRB_IPTC);
    if (iptcRemoved || hasIptc) {
      const iptc = iptcOf(res) ?? { datasets: [] };
      if (iptcRemoved) iptc.datasets = [];
      else applyIptcEdits(iptc, edits);
      res = res.filter((x) => x.id !== IRB_IPTC && x.id !== IRB_IPTC_DIGEST);
      if (!isEmptyIptc(iptc)) {
        res.push({ sig: '8BIM', id: IRB_IPTC, name: new Uint8Array(0), data: serializeIptc(iptc) });
      }
    }
    plan.irb = res;
  }

  // Comments
  const comEdits = [...edits].filter(([k]) => k.startsWith('jpeg:com:'));
  if (comEdits.length) {
    const comments = j.segments.filter((s) => s.kind === 'com').map((s) => utf8OrLatin1(s.data).replace(/\0+$/, ''));
    const next = [...comments];
    for (const [k, e] of comEdits) {
      const key = k.slice('jpeg:com:'.length);
      if (key === 'new') {
        if (e.op === 'set') next.push(asText(e.value, 'Comment'));
        continue;
      }
      const idx = +key;
      if (!(idx in next)) continue;
      next[idx] = e.op === 'remove' ? '' : asText(e.value, 'Comment');
    }
    plan.comments = next;
  }

  // Embedded blocks
  const dropIf = (id: string, kind: SegKind) => {
    if (edits.get(id)?.op === 'remove') plan.drop.add(kind);
  };
  dropIf('jpeg:icc', 'icc');
  dropIf('jpeg:xmpext', 'xmpext');
  dropIf('jpeg:ducky', 'ducky');
  dropIf('jpeg:c2pa', 'c2pa');
  dropIf('jpeg:jfxx', 'jfxx');
  if (edits.get(groupKey('jpeg.comments'))?.op === 'remove') plan.comments = [];
  if (edits.get('jpeg:jfifthumb')?.op === 'remove') plan.dropJfifThumb = true;
  for (const [k, e] of edits) {
    if (e.op !== 'remove') continue;
    const m = /^jpeg:(app|late):(\d+)$/.exec(k);
    if (m?.[1] === 'app') plan.drop.add(`app:${+m[2]}`);
    else if (m) late.add(+m[2]);
  }
  if (edits.get('jpeg:trailer')?.op === 'remove') plan.dropTrailer = true;

  return assemble(j, plan);
}

export async function stripJpeg(src: Source, opts: StripOptions): Promise<Blob> {
  const j = parseJpeg(await src.bytes());
  const orientation = exifOrientation(exifOf(j).data);
  const plan: Plan = {
    exif: opts.keepOrientation && orientation && orientation !== 1 ? orientationOnlyExif(orientation) : null,
    xmp: null,
    irb: null,
    comments: [],
    drop: new Set<SegKind>(['xmpext', 'ducky', 'c2pa', 'jfxx', 'app', 'mpf']),
    dropJfifThumb: true,
    dropLate: 'all',
    dropTrailer: true,
  };
  if (!opts.keepColorProfile) plan.drop.add('icc');
  j.segments.forEach((s, i) => {
    if (s.kind === 'app') plan.drop.add(`app:${i}`);
  });
  return assemble(j, plan);
}

export const jpegHandler: FormatHandler = {
  id: 'jpeg',
  name: 'JPEG image',
  category: 'image',
  extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
  mime: 'image/jpeg',
  detect(ctx: DetectContext) {
    const h = ctx.head;
    if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 3;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readJpeg,
  write: writeJpeg,
  strip: stripJpeg,
};
