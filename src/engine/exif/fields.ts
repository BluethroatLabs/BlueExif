/** Converts parsed EXIF into UI fields and applies field edits back. */

import { encodeUtf16, isAscii, latin1, utf16 } from '../core/binary';
import {
  asGps,
  asInteger,
  asText,
  displayDate,
  fmtNum,
  formatGps,
  formatTz,
  imageValue,
  makeField,
  rawField,
  requireDate,
  toExifDate,
  toIso,
  parseDate,
} from '../core/fields';
import type { Edits, Field, FieldGroup, FieldKind, FieldSpec, GpsValue } from '../core/types';
import { MetadataError } from '../core/types';
import {
  ADDABLE,
  EXIF_GROUP_LABELS,
  TAGS_BY_IFD,
  flashDescription,
  type ExifGroup,
  type IfdName,
  type TagDef,
} from './tags';
import {
  ASCII,
  BYTE,
  LONG,
  RATIONAL,
  SHORT,
  SRATIONAL,
  UNDEFINED,
  emptyExif,
  entryInts,
  entryNumbers,
  entryRationals,
  entryText,
  getEntry,
  makeAscii,
  makeBytes,
  makeLongs,
  makeRationals,
  makeShorts,
  removeEntry,
  setEntry,
  toRational,
  type Entry,
  type ExifData,
  type Ifd,
  PTR_EXIF,
  PTR_GPS,
  PTR_INTEROP,
  THUMB_LENGTH,
  THUMB_OFFSET,
} from './tiff';

const POINTERS = new Set([PTR_EXIF, PTR_GPS, PTR_INTEROP, THUMB_OFFSET, THUMB_LENGTH]);
const GPS_COMPOSITE = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
const IFD_ORDER: IfdName[] = ['ifd0', 'exif', 'gps', 'interop'];
const GROUP_ORDER: ExifGroup[] = ['description', 'dates', 'location', 'camera', 'exposure', 'image', 'thumbnail', 'other'];

/** EXIF datetime tag -> matching OffsetTime* tag in the Exif IFD */
const OFFSET_TAG: Record<number, number> = { 0x0132: 0x9010, 0x9003: 0x9011, 0x9004: 0x9012 };

const hex = (n: number) => n.toString(16).padStart(4, '0');

export const fieldId = (prefix: string, ifd: IfdName, tag: number) => `${prefix}:${ifd}:${hex(tag)}`;

function getIfd(d: ExifData, name: IfdName): Ifd | null {
  return d[name];
}

function ensureIfd(d: ExifData, name: IfdName): Ifd {
  if (name === 'ifd0') return d.ifd0;
  if (!d[name]) d[name] = { entries: [] };
  return d[name]!;
}

// ------------------------------------------------------------ formatting

function decodeCharsetText(data: Uint8Array, le: boolean): string {
  if (data.length < 8) return latin1(data).replace(/\0+$/, '').trim();
  const head = latin1(data.subarray(0, 8));
  const body = data.subarray(8);
  if (head.startsWith('UNICODE')) {
    let text = body;
    let little = le;
    if (text[0] === 0xff && text[1] === 0xfe) {
      little = true;
      text = text.subarray(2);
    } else if (text[0] === 0xfe && text[1] === 0xff) {
      little = false;
      text = text.subarray(2);
    }
    return utf16(text, little).replace(/\0+$/, '').trim();
  }
  if (head.startsWith('ASCII') || head === '\0\0\0\0\0\0\0\0') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/\0+$/, '').trim();
    } catch {
      return latin1(body).replace(/\0+$/, '').trim();
    }
  }
  return latin1(body).replace(/\0+$/, '').trim();
}

function encodeUserComment(s: string, le: boolean): Uint8Array {
  if (isAscii(s)) {
    const out = new Uint8Array(8 + s.length);
    out.set([0x41, 0x53, 0x43, 0x49, 0x49, 0, 0, 0]);
    for (let i = 0; i < s.length; i++) out[8 + i] = s.charCodeAt(i);
    return out;
  }
  const body = encodeUtf16(s, le);
  const out = new Uint8Array(8 + body.length);
  out.set([0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0]);
  out.set(body, 8);
  return out;
}

function decodeXp(data: Uint8Array): string {
  return utf16(data, true).replace(/\0+$/, '');
}

function encodeXp(s: string): Uint8Array {
  const b = encodeUtf16(s, true);
  const out = new Uint8Array(b.length + 2);
  out.set(b);
  return out;
}

function fmtRational(n: number, d: number): string {
  if (d === 0) return n === 0 ? '0' : 'undefined';
  const v = n / d;
  if (Number.isInteger(v)) return String(v);
  return fmtNum(v, 4);
}

function dms(e: Entry | undefined, ref: Entry | undefined, le: boolean): number | null {
  if (!e || e.type !== RATIONAL) return null;
  const [d = 0, m = 0, s = 0] = entryNumbers(e, le);
  if (![d, m, s].every(Number.isFinite)) return null;
  let v = Math.round((d + m / 60 + s / 3600) * 1e7) / 1e7; // ~1 cm; hides float noise
  const r = ref ? entryText(ref).toUpperCase() : '';
  if (r === 'S' || r === 'W') v = -v;
  return v;
}

export function readGps(d: ExifData): GpsValue | null {
  const g = d.gps;
  if (!g) return null;
  const lat = dms(getEntry(g, 0x02), getEntry(g, 0x01), d.le);
  const lon = dms(getEntry(g, 0x04), getEntry(g, 0x03), d.le);
  if (lat === null || lon === null) return null;
  const altE = getEntry(g, 0x06);
  let alt: number | null = null;
  if (altE) {
    alt = entryNumbers(altE, d.le)[0] ?? null;
    const ref = getEntry(g, 0x05);
    if (alt !== null && ref && entryInts(ref, d.le)[0] === 1) alt = -alt;
    if (alt !== null && !Number.isFinite(alt)) alt = null;
    if (alt !== null) alt = Math.round(alt * 1000) / 1000;
  }
  return { lat, lon, alt };
}

function formatEntry(e: Entry, def: TagDef | undefined, le: boolean, ifd: IfdName): string {
  const name = def?.name ?? '';
  if (e.type === ASCII) return entryText(e);
  if (name.endsWith('Version') && (e.type === UNDEFINED || e.type === BYTE)) {
    if (name === 'GPSVersionID') return Array.from(e.data).join('.');
    const s = latin1(e.data).replace(/\0/g, '');
    if (/^\d{4}$/.test(s)) return `${+s.slice(0, 2)}.${s.slice(2)}`;
    return s;
  }
  if (name === 'ComponentsConfiguration') {
    return Array.from(e.data)
      .map((c) => ['-', 'Y', 'Cb', 'Cr', 'R', 'G', 'B'][c] ?? '?')
      .join(' ');
  }
  if (name === 'UserComment' || name === 'GPSProcessingMethod' || name === 'GPSAreaInformation') {
    return decodeCharsetText(e.data, le);
  }
  if (def?.edit === 'xp') return decodeXp(e.data);
  if (name === 'GPSLatitude' || name === 'GPSLongitude' || name === 'GPSDestLatitude' || name === 'GPSDestLongitude') {
    const [d = 0, m = 0, s = 0] = entryNumbers(e, le);
    return `${Math.floor(d)}° ${Math.floor(m)}' ${fmtNum(s + (m % 1) * 60 + (d % 1) * 3600, 2)}"`;
  }
  if (name === 'GPSTimeStamp') {
    const [h = 0, m = 0, s = 0] = entryNumbers(e, le);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${fmtNum(s, 2).padStart(2, '0')}`;
  }
  if (name === 'MakerNote') return makerNoteSummary(e.data);
  if (e.type === UNDEFINED || (e.type === BYTE && e.count > 4)) {
    if (e.count <= 4 && def?.values) {
      const v = e.data[0];
      return def.values[v] ?? String(v);
    }
    const printable = e.data.length > 0 && e.data.every((c) => c === 0 || (c >= 0x20 && c < 0x7f) || c === 10);
    if (printable && e.data.length < 512) return latin1(e.data).replace(/\0+$/, '');
    return `${e.data.length.toLocaleString()} bytes of binary data`;
  }
  if (e.type === RATIONAL || e.type === SRATIONAL) {
    const rs = entryRationals(e, le);
    if (rs.length === 1) {
      const [n, dd] = rs[0];
      const v = dd ? n / dd : 0;
      if (name === 'ExposureTime') {
        if (v > 0 && v < 1) return `1/${fmtNum(1 / v, 1)} s`;
        return `${fmtNum(v, 3)} s`;
      }
      if (name === 'FNumber') return `f/${fmtNum(v, 1)}`;
      if (name === 'ExposureBiasValue') return `${v > 0 ? '+' : ''}${fmtNum(v, 2)} EV`;
      if (name === 'ApertureValue' || name === 'MaxApertureValue') return `f/${fmtNum(Math.pow(2, v / 2), 1)}`;
      if (name === 'ShutterSpeedValue') {
        const t = Math.pow(2, -v);
        return t < 1 ? `1/${Math.round(1 / t)} s` : `${fmtNum(t, 2)} s`;
      }
      return `${fmtRational(n, dd)}${def?.unit ? ` ${def.unit}` : ''}`;
    }
    if (name === 'LensSpecification' && rs.length === 4) {
      const [a, b, c, dd] = rs.map(([n, x]) => (x ? n / x : 0));
      const fl = a === b ? `${fmtNum(a, 1)} mm` : `${fmtNum(a, 1)}–${fmtNum(b, 1)} mm`;
      const fn = c && dd ? (c === dd ? ` f/${fmtNum(c, 1)}` : ` f/${fmtNum(c, 1)}–${fmtNum(dd, 1)}`) : '';
      return fl + fn;
    }
    return rs.map(([n, dd]) => fmtRational(n, dd)).join(', ');
  }
  const nums = entryNumbers(e, le);
  if (nums.length === 1) {
    const v = nums[0];
    if (name === 'Flash') return flashDescription(v);
    if (def?.values && def.values[v] !== undefined) return def.values[v];
    if (ifd === 'gps' && name.endsWith('Ref')) return String.fromCharCode(v);
    return `${v}${def?.unit ? ` ${def.unit}` : ''}`;
  }
  if (nums.length > 16) return `${nums.slice(0, 16).join(', ')}, … (${nums.length} values)`;
  return nums.join(', ');
}

export function makerNoteSummary(data: Uint8Array): string {
  const head = latin1(data.subarray(0, 16));
  const vendors: Array<[RegExp, string]> = [
    [/^Apple iOS/, 'Apple'],
    [/^Nikon/, 'Nikon'],
    [/^OLYMP|^OM SYSTEM/, 'Olympus / OM System'],
    [/^FUJIFILM/, 'Fujifilm'],
    [/^Panasonic/, 'Panasonic'],
    [/^SONY|^SEMC/, 'Sony'],
    [/^PENTAX|^AOC/, 'Pentax'],
    [/^LEICA/, 'Leica'],
    [/^SAMSUNG|^SEC /, 'Samsung'],
    [/^HUAWEI/, 'Huawei'],
    [/^RICOH|^Ricoh/, 'Ricoh'],
    [/^SIGMA/, 'Sigma'],
    [/^GOPRO/i, 'GoPro'],
    [/^DJI/, 'DJI'],
  ];
  const vendor = vendors.find(([re]) => re.test(head))?.[1];
  const size = data.length < 1024 ? `${data.length} bytes` : `${Math.round(data.length / 1024)} KB`;
  return `${vendor ? `${vendor} proprietary data` : 'Proprietary camera data'}, ${size}`;
}

// --------------------------------------------------------------- reading

function kindOf(def: TagDef): FieldKind {
  switch (def.edit) {
    case 'text':
    case 'xp':
      return 'text';
    case 'multiline':
    case 'usercomment':
      return 'multiline';
    case 'datetime':
      return 'datetime';
    case 'integer':
      return 'integer';
    case 'rational':
    case 'srational':
      return 'text';
    case 'enum':
      return 'enum';
    default:
      return 'raw';
  }
}

function specFor(prefix: string, ifd: IfdName, tag: number, def: TagDef): FieldSpec {
  const kind = kindOf(def);
  return {
    id: fieldId(prefix, ifd, tag),
    label: def.label,
    kind,
    sensitivity: def.sens,
    tag: `${def.name} (0x${hex(tag)})`,
    options:
      kind === 'enum' && def.values
        ? Object.entries(def.values).map(([value, label]) => ({ value, label }))
        : undefined,
    placeholder: def.edit === 'rational' ? 'e.g. 1/125 or 2.8' : def.edit === 'integer' ? '0' : undefined,
  };
}

/** Is the stored type compatible with how we would edit it? */
function editableType(e: Entry, def: TagDef): boolean {
  switch (def.edit) {
    case 'text':
    case 'multiline':
    case 'datetime':
      return e.type === ASCII;
    case 'xp':
      return e.type === BYTE;
    case 'usercomment':
      return e.type === UNDEFINED;
    case 'integer':
      return (e.type === SHORT || e.type === LONG) && e.count === 1;
    case 'enum':
      return e.type === SHORT && e.count === 1;
    case 'rational':
      return e.type === RATIONAL && e.count === 1;
    case 'srational':
      return e.type === SRATIONAL && e.count === 1;
    default:
      return false;
  }
}

function entryField(prefix: string, ifd: IfdName, e: Entry, le: boolean): Field {
  const def = TAGS_BY_IFD[ifd][e.tag];
  const id = fieldId(prefix, ifd, e.tag);
  if (!def) {
    return rawField(id, `Unknown tag 0x${hex(e.tag)}`, formatEntry(e, undefined, le, ifd), {
      tag: `0x${hex(e.tag)}`,
      sensitivity: ifd === 'gps' ? 'location' : undefined,
    });
  }
  const display = formatEntry(e, def, le, ifd);
  if (!def.edit || !editableType(e, def)) {
    return rawField(id, def.label, display, { tag: `${def.name} (0x${hex(e.tag)})`, sensitivity: def.sens });
  }
  const spec = specFor(prefix, ifd, e.tag, def);
  switch (def.edit) {
    case 'datetime': {
      const s = entryText(e);
      const p = parseDate(s);
      if (!p || p.year === 0) return rawField(id, def.label, s || '(empty)', { tag: spec.tag, sensitivity: def.sens });
      return makeField(spec, toIso(p), { display: displayDate(toIso(p)) });
    }
    case 'integer':
      return makeField(spec, entryInts(e, le)[0]);
    case 'enum': {
      const v = entryInts(e, le)[0];
      return makeField(spec, String(v), { display: def.values?.[v] ?? String(v) });
    }
    case 'rational':
    case 'srational': {
      const [[n, dd]] = entryRationals(e, le);
      const val = def.name === 'ExposureTime' && dd > n && n > 0 ? `1/${fmtNum(dd / n, 2)}` : fmtRational(n, dd);
      return makeField(spec, val, { display });
    }
    default:
      return makeField(spec, display);
  }
}

export interface ExifGroupOptions {
  prefix?: string;
  source?: string;
  /** Offer "add field" templates (requires the container to support writing) */
  addable?: boolean;
}

export function exifGroups(d: ExifData, opts: ExifGroupOptions = {}): FieldGroup[] {
  const prefix = opts.prefix ?? 'exif';
  const source = opts.source ?? 'EXIF';
  const buckets = new Map<ExifGroup, Field[]>();
  const add = (g: ExifGroup, f: Field) => {
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(f);
  };

  const gps = readGps(d);
  if (gps) {
    add(
      'location',
      makeField(
        {
          id: `${prefix}:gps:location`,
          label: 'GPS location',
          kind: 'gps',
          sensitivity: 'location',
          tag: 'GPSLatitude / GPSLongitude / GPSAltitude',
        },
        gps,
        { display: formatGps(gps) },
      ),
    );
  }

  for (const name of IFD_ORDER) {
    const ifd = getIfd(d, name);
    if (!ifd) continue;
    for (const e of ifd.entries) {
      if (POINTERS.has(e.tag) && name !== 'gps' && name !== 'interop') continue;
      if (name === 'gps' && gps && GPS_COMPOSITE.has(e.tag)) continue;
      if (name === 'gps' && e.tag === 0x00) continue; // version id: noise
      const def = TAGS_BY_IFD[name][e.tag];
      const group: ExifGroup = name === 'interop' ? 'other' : name === 'gps' ? 'location' : (def?.group ?? 'other');
      add(group, entryField(prefix, name, e, d.le));
    }
  }

  if (d.thumbnail) {
    const img = imageValue(d.thumbnail, 'image/jpeg');
    add(
      'thumbnail',
      makeField(
        {
          id: `${prefix}:ifd1:thumbnail`,
          label: 'Embedded thumbnail',
          kind: 'image',
          sensitivity: 'content',
          tag: 'IFD1 JPEGInterchangeFormat',
          description: 'A small preview generated when the photo was taken. It may still show the original, uncropped image.',
        },
        img,
        { editable: false, display: `${img.width ?? '?'}×${img.height ?? '?'} JPEG preview` },
      ),
    );
  }

  const present = new Set<string>();
  for (const fields of buckets.values()) for (const f of fields) present.add(f.id);

  const addableByGroup = new Map<ExifGroup, FieldSpec[]>();
  if (opts.addable) {
    for (const [ifd, tag] of ADDABLE) {
      const def = TAGS_BY_IFD[ifd][tag];
      const id = fieldId(prefix, ifd, tag);
      if (present.has(id)) continue;
      if (!addableByGroup.has(def.group)) addableByGroup.set(def.group, []);
      addableByGroup.get(def.group)!.push(specFor(prefix, ifd, tag, def));
    }
    if (!gps) {
      addableByGroup.set('location', [
        { id: `${prefix}:gps:location`, label: 'GPS location', kind: 'gps', sensitivity: 'location' },
      ]);
    }
  }

  const groups: FieldGroup[] = [];
  for (const g of GROUP_ORDER) {
    const fields = buckets.get(g) ?? [];
    const addable = addableByGroup.get(g);
    if (!fields.length && !addable?.length) continue;
    groups.push({
      id: `${prefix}.${g}`,
      label: EXIF_GROUP_LABELS[g],
      source,
      fields,
      addable,
    });
  }
  return groups;
}

// --------------------------------------------------------------- editing

function parseRationalInput(v: string, label: string, signed: boolean): [number, number] {
  const s = v.trim().replace(/\s*(s|mm|ev)$/i, '').replace(/^f\//i, '');
  const frac = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const n = +frac[1];
    const d = +frac[2];
    if (!d) throw new MetadataError(`${label}: denominator cannot be zero`);
    if (!signed && n < 0) throw new MetadataError(`${label}: must not be negative`);
    return [n, d];
  }
  const x = Number(s);
  if (!Number.isFinite(x)) throw new MetadataError(`${label}: "${v}" is not a number or fraction`);
  if (!signed && x < 0) throw new MetadataError(`${label}: must not be negative`);
  return toRational(x, 100000, signed);
}

function writeGps(d: ExifData, g: GpsValue): void {
  const gps = ensureIfd(d, 'gps');
  const le = d.le;
  const toDms = (v: number): Array<[number, number]> => {
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const minF = (a - deg) * 60;
    const min = Math.floor(minF);
    const sec = Math.round((minF - min) * 60 * 10000);
    return [
      [deg, 1],
      [min, 1],
      [sec, 10000],
    ];
  };
  if (!getEntry(gps, 0x00)) setEntry(gps, makeBytes(0x00, [2, 3, 0, 0]));
  setEntry(gps, makeAscii(0x01, g.lat < 0 ? 'S' : 'N'));
  setEntry(gps, makeRationals(0x02, toDms(g.lat), le));
  setEntry(gps, makeAscii(0x03, g.lon < 0 ? 'W' : 'E'));
  setEntry(gps, makeRationals(0x04, toDms(g.lon), le));
  if (g.alt != null && Number.isFinite(g.alt)) {
    setEntry(gps, makeBytes(0x05, [g.alt < 0 ? 1 : 0]));
    setEntry(gps, makeRationals(0x06, [[Math.round(Math.abs(g.alt) * 100), 100]], le));
  } else {
    removeEntry(gps, 0x05);
    removeEntry(gps, 0x06);
  }
}

function encodeValue(d: ExifData, ifd: IfdName, tag: number, def: TagDef, value: unknown): Entry {
  const le = d.le;
  const v = value as Parameters<typeof asText>[0];
  const existing = getEntry(getIfd(d, ifd), tag);
  switch (def.edit) {
    case 'text':
    case 'multiline':
      return makeAscii(tag, asText(v, def.label));
    case 'datetime': {
      const p = requireDate(v, def.label);
      return makeAscii(tag, toExifDate(p));
    }
    case 'xp':
      return makeBytes(tag, encodeXp(asText(v, def.label)));
    case 'usercomment':
      return makeBytes(tag, encodeUserComment(asText(v, def.label), le), UNDEFINED);
    case 'integer': {
      const n = asInteger(v, def.label);
      if (n < 0) throw new MetadataError(`${def.label}: must not be negative`);
      if (existing?.type === LONG || n > 0xffff) return makeLongs(tag, [n], le);
      return makeShorts(tag, [n], le);
    }
    case 'enum': {
      const n = asInteger(typeof v === 'string' ? Number(v) : v, def.label);
      if (def.values && !(n in def.values)) throw new MetadataError(`${def.label}: invalid value ${n}`);
      return makeShorts(tag, [n], le);
    }
    case 'rational':
      return makeRationals(tag, [parseRationalInput(asText(v, def.label), def.label, false)], le);
    case 'srational':
      return makeRationals(tag, [parseRationalInput(asText(v, def.label), def.label, true)], le, true);
    default:
      throw new MetadataError(`${def.label} cannot be edited`);
  }
}

/**
 * Apply edits addressed to this EXIF block (ids starting with `${prefix}:`).
 * Returns true if anything changed. Unknown ids are ignored.
 */
export function applyExifEdits(d: ExifData, edits: Edits, prefix = 'exif'): boolean {
  let changed = false;
  for (const [id, edit] of edits) {
    if (!id.startsWith(`${prefix}:`)) continue;
    const [, ifdName, key] = id.split(':') as [string, IfdName, string];
    if (ifdName === 'gps' && key === 'location') {
      for (const t of GPS_COMPOSITE) removeEntry(d.gps, t);
      if (edit.op === 'set') writeGps(d, asGps(edit.value));
      changed = true;
      continue;
    }
    if (ifdName === 'ifd1' && key === 'thumbnail') {
      if (edit.op === 'remove') {
        d.thumbnail = null;
        d.ifd1 = null;
        changed = true;
      }
      continue;
    }
    if (!(ifdName in TAGS_BY_IFD)) continue;
    const tag = parseInt(key, 16);
    if (!Number.isFinite(tag)) continue;
    if (edit.op === 'remove') {
      changed = removeEntry(getIfd(d, ifdName), tag) || changed;
      continue;
    }
    const def = TAGS_BY_IFD[ifdName][tag];
    if (!def?.edit) throw new MetadataError(`EXIF tag 0x${hex(tag)} cannot be edited`);
    const entry = encodeValue(d, ifdName, tag, def, edit.value);
    setEntry(ensureIfd(d, ifdName), entry);
    // Keep the matching OffsetTime* in sync when a time zone was given.
    if (def.edit === 'datetime' && OFFSET_TAG[tag]) {
      const p = requireDate(edit.value, def.label);
      if (p.tz !== undefined) {
        const tz = p.tz === 0 ? '+00:00' : formatTz(p.tz);
        setEntry(ensureIfd(d, 'exif'), makeAscii(OFFSET_TAG[tag], tz));
      }
    }
    changed = true;
  }
  // A GPS IFD holding only the version id is noise.
  if (d.gps && d.gps.entries.every((e) => e.tag === 0x00)) d.gps = null;
  return changed;
}

export function exifOrientation(d: ExifData | null): number | null {
  const e = d ? getEntry(d.ifd0, 0x0112) : undefined;
  if (!e) return null;
  return entryInts(e, d!.le)[0] ?? null;
}

/** EXIF block containing only the orientation tag. */
export function orientationOnlyExif(orientation: number, le = false): ExifData {
  const d = emptyExif(le);
  d.ifd0.entries.push(makeShorts(0x0112, [orientation], le));
  return d;
}

export { emptyExif };
