/** Helpers for building fields and converting common value types. */

import type { Edit, Edits, Field, FieldKind, FieldSpec, FieldValue, GpsValue, ImageValue, Sensitivity } from './types';
import { MetadataError } from './types';
import { Reader, startsWith } from './binary';

export interface FieldOpts {
  display?: string;
  editable?: boolean;
  removable?: boolean;
}

export function makeField(spec: FieldSpec, value: FieldValue, opts: FieldOpts = {}): Field {
  return {
    ...spec,
    value,
    display: opts.display,
    editable: opts.editable ?? spec.kind !== 'raw',
    removable: opts.removable ?? true,
  };
}

export function rawField(
  id: string,
  label: string,
  display: string,
  extra: { sensitivity?: Sensitivity; tag?: string; description?: string; removable?: boolean } = {},
): Field {
  return {
    id,
    label,
    kind: 'raw',
    value: null,
    display,
    editable: false,
    removable: extra.removable ?? true,
    sensitivity: extra.sensitivity,
    tag: extra.tag,
    description: extra.description,
  };
}

export function spec(
  id: string,
  label: string,
  kind: FieldKind,
  extra: Omit<FieldSpec, 'id' | 'label' | 'kind'> = {},
): FieldSpec {
  return { id, label, kind, ...extra };
}

// -------------------------------------------------------------------- edits

export function getEdit(edits: Edits, id: string): Edit | undefined {
  return edits.get(id);
}

/** Coerce a set value to string, throwing a friendly error otherwise. */
export function asText(v: FieldValue, label = 'value'): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.join('; ');
  throw new MetadataError(`${label}: expected text`);
}

export function asList(v: FieldValue): string[] {
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string')
    return v
      .split(/[;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof v === 'number') return [String(v)];
  throw new MetadataError('Expected a list of values');
}

export function asNumber(v: FieldValue, label = 'value'): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) throw new MetadataError(`${label}: "${String(v)}" is not a number`);
  return n;
}

export function asInteger(v: FieldValue, label = 'value'): number {
  const n = asNumber(v, label);
  if (!Number.isInteger(n)) throw new MetadataError(`${label}: expected a whole number`);
  return n;
}

export function asGps(v: FieldValue): GpsValue {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'lat' in v && 'lon' in v) {
    const g = v as GpsValue;
    if (!Number.isFinite(g.lat) || Math.abs(g.lat) > 90) throw new MetadataError('Latitude must be between -90 and 90');
    if (!Number.isFinite(g.lon) || Math.abs(g.lon) > 180)
      throw new MetadataError('Longitude must be between -180 and 180');
    return g;
  }
  if (typeof v === 'string') {
    const g = parseGpsString(v);
    if (g) return g;
  }
  throw new MetadataError('Expected GPS coordinates');
}

export function asImage(v: FieldValue): ImageValue {
  if (v && typeof v === 'object' && 'data' in v && (v as ImageValue).data instanceof Uint8Array) return v as ImageValue;
  throw new MetadataError('Expected an image');
}

// ---------------------------------------------------------------- datetime

export interface DateParts {
  year: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  /** fractional seconds as written, without the dot, e.g. "123" */
  fraction?: string;
  /** offset in minutes east of UTC; undefined = unspecified (local) */
  tz?: number;
}

const ISO_RE =
  /^\s*(\d{4})(?:[-:](\d{2})(?:[-:](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i;

/** Parse ISO-8601 and EXIF-ish date strings ("2024:05:01 10:00:00"). */
export function parseDate(s: string): DateParts | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const p: DateParts = { year: +m[1] };
  if (m[2]) p.month = +m[2];
  if (m[3]) p.day = +m[3];
  if (m[4]) {
    p.hour = +m[4];
    p.minute = +m[5];
  }
  if (m[6]) p.second = +m[6];
  if (m[7]) p.fraction = m[7];
  if (m[8]) {
    if (m[8].toUpperCase() === 'Z') p.tz = 0;
    else {
      const sign = m[8][0] === '-' ? -1 : 1;
      const digits = m[8].slice(1).replace(':', '');
      p.tz = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4));
    }
  }
  if (p.month !== undefined && (p.month < 1 || p.month > 12)) return null;
  if (p.day !== undefined && (p.day < 1 || p.day > 31)) return null;
  if (p.hour !== undefined && (p.hour > 24 || p.minute! > 59)) return null;
  if (p.second !== undefined && p.second > 60) return null;
  return p;
}

export function requireDate(v: FieldValue, label = 'Date'): DateParts {
  const s = asText(v, label);
  const p = parseDate(s);
  if (!p) throw new MetadataError(`${label}: "${s}" is not a valid date (use YYYY-MM-DD HH:MM:SS)`);
  return p;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatTz(tz: number, colon = true): string {
  if (tz === 0) return 'Z';
  const sign = tz < 0 ? '-' : '+';
  const a = Math.abs(tz);
  return `${sign}${pad(Math.floor(a / 60))}${colon ? ':' : ''}${pad(a % 60)}`;
}

/** ISO-8601 representation of the parts (as precise as the parts are). */
export function toIso(p: DateParts): string {
  let s = pad(p.year, 4);
  if (p.month === undefined) return s;
  s += `-${pad(p.month)}`;
  if (p.day === undefined) return s;
  s += `-${pad(p.day)}`;
  if (p.hour === undefined) return s;
  s += `T${pad(p.hour)}:${pad(p.minute ?? 0)}`;
  if (p.second !== undefined) s += `:${pad(p.second)}`;
  if (p.fraction) s += `.${p.fraction}`;
  if (p.tz !== undefined) s += formatTz(p.tz);
  return s;
}

/** "YYYY:MM:DD HH:MM:SS" (EXIF). Missing parts become zero. */
export function toExifDate(p: DateParts): string {
  return `${pad(p.year, 4)}:${pad(p.month ?? 1)}:${pad(p.day ?? 1)} ${pad(p.hour ?? 0)}:${pad(p.minute ?? 0)}:${pad(p.second ?? 0)}`;
}

export function partsToDate(p: DateParts): Date {
  const ms = Date.UTC(p.year, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  return new Date(ms - (p.tz ?? 0) * 60_000);
}

export function dateToParts(d: Date, utc = true): DateParts {
  if (utc) {
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      tz: 0,
    };
  }
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  };
}

/** Human display of an ISO-ish date string: "2024-05-01 10:00:00 +02:00". */
export function displayDate(iso: string): string {
  const p = parseDate(iso);
  if (!p) return iso;
  let s = pad(p.year, 4);
  if (p.month !== undefined) s += `-${pad(p.month)}`;
  if (p.day !== undefined) s += `-${pad(p.day)}`;
  if (p.hour !== undefined) s += ` ${pad(p.hour)}:${pad(p.minute ?? 0)}${p.second !== undefined ? `:${pad(p.second)}` : ''}`;
  if (p.tz !== undefined) s += p.tz === 0 ? ' UTC' : ` ${formatTz(p.tz)}`;
  return s;
}

// --------------------------------------------------------------------- GPS

/** Accepts "37.77, -122.41", "37.77 N 122.41 W", "37°46'29.6"N 122°25'09.8"W". */
export function parseGpsString(s: string): GpsValue | null {
  const t = s.trim();
  const dec = /^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)(?:\s*[,; ]\s*(-?\d+(?:\.\d+)?))?$/.exec(t);
  if (dec) {
    const g: GpsValue = { lat: +dec[1], lon: +dec[2] };
    if (dec[3] !== undefined) g.alt = +dec[3];
    return Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180 ? g : null;
  }
  const part = String.raw`(\d+(?:\.\d+)?)\s*[°d]?\s*(?:(\d+(?:\.\d+)?)\s*['′m]?\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|''|s)?\s*)?([NSEW])`;
  const dms = new RegExp(`^${part}[\\s,;]*${part}$`, 'i').exec(t);
  if (dms) {
    const conv = (d: string, m?: string, sec?: string, ref?: string) => {
      const v = +d + (m ? +m / 60 : 0) + (sec ? +sec / 3600 : 0);
      return /[SW]/i.test(ref ?? '') ? -v : v;
    };
    const a = conv(dms[1], dms[2], dms[3], dms[4]);
    const b = conv(dms[5], dms[6], dms[7], dms[8]);
    const latFirst = /[NS]/i.test(dms[4]);
    const g = latFirst ? { lat: a, lon: b } : { lat: b, lon: a };
    return Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180 ? g : null;
  }
  return null;
}

export function formatGps(g: GpsValue): string {
  const lat = `${Math.abs(g.lat).toFixed(6)}° ${g.lat < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(g.lon).toFixed(6)}° ${g.lon < 0 ? 'W' : 'E'}`;
  const alt = g.alt != null && Number.isFinite(g.alt) ? `, ${Math.round(g.alt * 10) / 10} m` : '';
  return `${lat}, ${lon}${alt}`;
}

/** ISO 6709 string as used by QuickTime/MP4: "+37.7749-122.4194+010.000/" */
export function parseIso6709(s: string): GpsValue | null {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?(?:CRS[^/]*)?\/?$/.exec(s.trim());
  if (!m) return null;
  // Plain decimal degrees only (the overwhelmingly common form).
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const g: GpsValue = { lat, lon };
  if (m[3]) g.alt = parseFloat(m[3]);
  return g;
}

export function toIso6709(g: GpsValue): string {
  const sign = (n: number, intDigits: number) => {
    const s = Math.abs(n).toFixed(4);
    const [i, f] = s.split('.');
    return `${n < 0 ? '-' : '+'}${i.padStart(intDigits, '0')}.${f}`;
  };
  let s = sign(g.lat, 2) + sign(g.lon, 3);
  if (g.alt != null && Number.isFinite(g.alt)) s += `${g.alt < 0 ? '-' : '+'}${Math.abs(g.alt).toFixed(3)}`;
  return `${s}/`;
}

// ------------------------------------------------------------------ images

export function sniffImageMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (startsWith(b, '\x89PNG')) return 'image/png';
  if (startsWith(b, 'GIF8')) return 'image/gif';
  if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) return 'image/webp';
  if (startsWith(b, 'BM')) return 'image/bmp';
  if (startsWith(b, 'ftyp', 4)) {
    if (startsWith(b, 'avif', 8)) return 'image/avif';
    return 'image/heic';
  }
  return 'application/octet-stream';
}

/** Cheap dimension sniffing for embedded pictures (JPEG, PNG, GIF, WebP). */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  try {
    if (startsWith(b, '\x89PNG') && b.length >= 24) {
      const r = new Reader(b);
      return { width: r.u32(16), height: r.u32(20) };
    }
    if (startsWith(b, 'GIF8') && b.length >= 10) {
      const r = new Reader(b, true);
      return { width: r.u16(6), height: r.u16(8) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      const r = new Reader(b);
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) {
          p++;
          continue;
        }
        const m = b[p + 1];
        if (m === 0xff) {
          p++;
          continue;
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          p += 2;
          continue;
        }
        const len = r.u16(p + 2);
        if ((m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) || m === 0xde) {
          return { height: r.u16(p + 5), width: r.u16(p + 7) };
        }
        if (m === 0xda) return null;
        p += 2 + len;
      }
    }
    if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) {
      const r = new Reader(b, true);
      const kind = r.fourcc(12);
      if (kind === 'VP8X') return { width: (r.u24(24) & 0xffffff) + 1, height: (r.u24(27) & 0xffffff) + 1 };
      if (kind === 'VP8L') {
        const bits = r.u32(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8 ') return { width: r.u16(26) & 0x3fff, height: r.u16(28) & 0x3fff };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function describeImage(v: ImageValue): string {
  const kind = v.mime.replace('image/', '').toUpperCase();
  const dims = v.width && v.height ? `${v.width}×${v.height} ` : '';
  const kb = v.data.length < 1024 ? `${v.data.length} B` : `${Math.round(v.data.length / 1024)} KB`;
  return `${dims}${kind}, ${kb}`;
}

export function imageValue(data: Uint8Array, mime?: string, extra: Partial<ImageValue> = {}): ImageValue {
  const m = mime && mime !== 'image/jpg' && mime.includes('/') ? mime : sniffImageMime(data);
  const dims = imageSize(data);
  return { mime: m, data, ...dims, ...extra };
}

export const PICTURE_TYPES: string[] = [
  'Other',
  'File icon',
  'Other file icon',
  'Front cover',
  'Back cover',
  'Leaflet page',
  'Media',
  'Lead artist',
  'Artist',
  'Conductor',
  'Band',
  'Composer',
  'Lyricist',
  'Recording location',
  'During recording',
  'During performance',
  'Screen capture',
  'Bright coloured fish',
  'Illustration',
  'Band logo',
  'Publisher logo',
];

/** Round to a sensible number of digits for display. */
export function fmtNum(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 10 ** digits) / 10 ** digits);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
