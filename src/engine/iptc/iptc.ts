/** IPTC-IIM datasets and Photoshop Image Resource Blocks (APP13). */

import { Reader, Writer, encodeUtf8, isValidUtf8, latin1, startsWith, utf8 } from '../core/binary';
import { asList, asText, displayDate, makeField, parseDate, rawField, requireDate } from '../core/fields';
import type { Edits, Field, FieldGroup, FieldKind, FieldSpec, Sensitivity } from '../core/types';
import { MetadataError } from '../core/types';

export interface Dataset {
  rec: number;
  ds: number;
  data: Uint8Array;
}

export interface IptcData {
  datasets: Dataset[];
}

interface DsDef {
  label: string;
  rep?: boolean;
  sens?: Sensitivity;
  kind?: FieldKind;
  max?: number;
  addable?: boolean;
}

const D = (label: string, extra: Partial<DsDef> = {}): DsDef => ({ label, ...extra });

export const IPTC_DATASETS: Record<number, DsDef> = {
  5: D('Title (object name)', { max: 64, sens: 'content', addable: true }),
  7: D('Edit status', { max: 64 }),
  10: D('Urgency', { max: 1 }),
  12: D('Subject reference', { rep: true }),
  15: D('Category', { max: 3 }),
  20: D('Supplemental categories', { rep: true, max: 32 }),
  22: D('Fixture identifier', { max: 32 }),
  25: D('Keywords', { rep: true, max: 64, sens: 'content', addable: true }),
  26: D('Content location code', { rep: true, sens: 'location' }),
  27: D('Content location name', { rep: true, sens: 'location' }),
  30: D('Release date'),
  35: D('Release time'),
  37: D('Expiration date'),
  38: D('Expiration time'),
  40: D('Special instructions', { max: 256, kind: 'multiline', sens: 'content' }),
  42: D('Action advised'),
  55: D('Date created', { sens: 'time', kind: 'datetime', addable: true }),
  62: D('Digital creation date', { sens: 'time', kind: 'datetime' }),
  65: D('Originating program', { max: 32, sens: 'software' }),
  70: D('Program version', { max: 10, sens: 'software' }),
  75: D('Object cycle'),
  80: D('Creator (by-line)', { rep: true, max: 32, sens: 'identity', addable: true }),
  85: D("Creator's job title", { rep: true, max: 32, sens: 'identity' }),
  90: D('City', { max: 32, sens: 'location', addable: true }),
  92: D('Sub-location', { max: 32, sens: 'location' }),
  95: D('Province / state', { max: 32, sens: 'location', addable: true }),
  100: D('Country code', { max: 3, sens: 'location' }),
  101: D('Country', { max: 64, sens: 'location', addable: true }),
  103: D('Job ID (transmission ref.)', { max: 32 }),
  105: D('Headline', { max: 256, sens: 'content', addable: true }),
  110: D('Credit line', { max: 32, sens: 'identity', addable: true }),
  115: D('Source', { max: 32, sens: 'identity' }),
  116: D('Copyright notice', { max: 128, sens: 'identity', addable: true }),
  118: D('Contact', { rep: true, max: 128, sens: 'identity' }),
  120: D('Caption / description', { max: 2000, kind: 'multiline', sens: 'content', addable: true }),
  121: D('Local caption', { kind: 'multiline', sens: 'content' }),
  122: D('Caption writer', { rep: true, max: 32, sens: 'identity' }),
  130: D('Image type'),
  131: D('Image orientation'),
  135: D('Language'),
};

/** Date dataset -> companion time dataset */
const TIME_OF: Record<number, number> = { 55: 60, 62: 63, 30: 35, 37: 38 };
const TIME_DATASETS = new Set(Object.values(TIME_OF));
const BINARY_DATASETS = new Set([0, 125, 200, 201, 202]);
const UTF8_MARK = new Uint8Array([0x1b, 0x25, 0x47]);

export function parseIptc(b: Uint8Array): IptcData {
  const datasets: Dataset[] = [];
  const r = new Reader(b);
  while (r.remaining >= 5) {
    if (r.u8(r.pos) !== 0x1c) {
      r.pos++;
      continue;
    }
    r.skip(1);
    const rec = r.u8();
    const ds = r.u8();
    let len = r.u16();
    if (len & 0x8000) {
      const n = len & 0x7fff;
      if (n > 4 || r.remaining < n) break;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + r.u8();
    }
    if (len > r.remaining) break;
    datasets.push({ rec, ds, data: r.take(len).slice() });
  }
  return { datasets };
}

function isUtf8(d: IptcData): boolean {
  const cs = d.datasets.find((x) => x.rec === 1 && x.ds === 90);
  if (cs) return startsWith(cs.data, UTF8_MARK);
  // No declaration: assume UTF-8 when every text dataset is valid UTF-8.
  return d.datasets.every((x) => x.rec !== 2 || BINARY_DATASETS.has(x.ds) || isValidUtf8(x.data));
}

function decoder(d: IptcData): (b: Uint8Array) => string {
  return isUtf8(d) ? (b) => utf8(b).replace(/\0+$/, '') : (b) => latin1(b).replace(/\0+$/, '');
}

export function serializeIptc(d: IptcData): Uint8Array {
  const w = new Writer(false, 1024);
  for (const x of d.datasets) {
    w.u8(0x1c).u8(x.rec).u8(x.ds);
    if (x.data.length < 0x8000) w.u16(x.data.length);
    else w.u16(0x8004).u32(x.data.length);
    w.bytes(x.data);
  }
  return w.finish();
}

/** Re-encode all text datasets as UTF-8 and declare it in 1:90. */
function normalizeUtf8(d: IptcData): void {
  if (isUtf8(d) && d.datasets.some((x) => x.rec === 1 && x.ds === 90)) return;
  const dec = decoder(d);
  for (const x of d.datasets) {
    if (x.rec === 2 && !BINARY_DATASETS.has(x.ds)) x.data = encodeUtf8(dec(x.data));
  }
  d.datasets = d.datasets.filter((x) => !(x.rec === 1 && x.ds === 90));
  // 1:90 belongs at the start of record 1 (after 1:00 when present).
  let at = 0;
  while (at < d.datasets.length && d.datasets[at].rec === 1 && d.datasets[at].ds < 90) at++;
  d.datasets.splice(at, 0, { rec: 1, ds: 90, data: UTF8_MARK.slice() });
  if (!d.datasets.some((x) => x.rec === 2 && x.ds === 0)) {
    const i = d.datasets.findIndex((x) => x.rec >= 2);
    d.datasets.splice(i < 0 ? d.datasets.length : i, 0, { rec: 2, ds: 0, data: new Uint8Array([0, 4]) });
  }
}

// ------------------------------------------------------------- dates

function iptcDateToIso(date: string, time?: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(date.trim());
  if (!m) return null;
  let iso = `${m[1]}-${m[2]}-${m[3]}`;
  const t = time && /^(\d{2})(\d{2})(\d{2})([+-]\d{4})?$/.exec(time.trim());
  if (t) {
    iso += `T${t[1]}:${t[2]}:${t[3]}`;
    if (t[4]) iso += `${t[4].slice(0, 3)}:${t[4].slice(3)}`;
  }
  return parseDate(iso) ? iso : null;
}

// ------------------------------------------------------------- fields

const fid = (prefix: string, rec: number, ds: number) => `${prefix}:${rec}:${ds}`;

export function iptcGroups(d: IptcData, opts: { prefix?: string; addable?: boolean } = {}): FieldGroup[] {
  const prefix = opts.prefix ?? 'iptc';
  const dec = decoder(d);
  const fields: Field[] = [];
  const seen = new Set<string>();
  for (const x of d.datasets) {
    const key = `${x.rec}:${x.ds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (x.rec === 1 || (x.rec === 2 && x.ds === 0)) continue;
    if (x.rec === 2 && TIME_DATASETS.has(x.ds)) {
      // Shown merged into its date field unless the date is missing.
      const dateDs = Number(Object.keys(TIME_OF).find((k) => TIME_OF[+k] === x.ds));
      if (d.datasets.some((y) => y.rec === 2 && y.ds === dateDs)) continue;
    }
    const def = x.rec === 2 ? IPTC_DATASETS[x.ds] : undefined;
    const id = fid(prefix, x.rec, x.ds);
    const all = d.datasets.filter((y) => y.rec === x.rec && y.ds === x.ds);
    if (!def || BINARY_DATASETS.has(x.ds) || x.rec !== 2) {
      const text = all.map((y) => dec(y.data)).join('; ');
      const printable = /^[\x20-\x7e -￿\n\r\t]*$/.test(text);
      fields.push(
        rawField(id, def?.label ?? `Dataset ${x.rec}:${String(x.ds).padStart(3, '0')}`, printable ? text : `${x.data.length} bytes`, {
          tag: `IPTC ${x.rec}:${String(x.ds).padStart(3, '0')}`,
        }),
      );
      continue;
    }
    const spec: FieldSpec = {
      id,
      label: def.label,
      kind: def.rep ? 'list' : (def.kind ?? 'text'),
      sensitivity: def.sens,
      tag: `IPTC 2:${String(x.ds).padStart(3, '0')}`,
    };
    if (def.kind === 'datetime') {
      const timeDs = TIME_OF[x.ds];
      const t = d.datasets.find((y) => y.rec === 2 && y.ds === timeDs);
      const iso = iptcDateToIso(dec(x.data), t ? dec(t.data) : undefined);
      if (iso) {
        fields.push(makeField(spec, iso, { display: displayDate(iso) }));
        continue;
      }
      fields.push(makeField({ ...spec, kind: 'text' }, dec(x.data), { editable: false }));
      continue;
    }
    if (def.rep)
      fields.push(
        makeField(
          spec,
          all.map((y) => dec(y.data)),
        ),
      );
    else fields.push(makeField(spec, dec(x.data)));
  }
  const addable: FieldSpec[] = [];
  if (opts.addable) {
    for (const [ds, def] of Object.entries(IPTC_DATASETS)) {
      if (!def.addable || seen.has(`2:${ds}`)) continue;
      addable.push({
        id: fid(prefix, 2, +ds),
        label: def.label,
        kind: def.rep ? 'list' : (def.kind ?? 'text'),
        sensitivity: def.sens,
        tag: `IPTC 2:${ds.padStart(3, '0')}`,
      });
    }
  }
  if (!fields.length && !addable.length) return [];
  return [{ id: prefix, label: 'IPTC', source: 'IPTC-IIM', fields, addable: addable.length ? addable : undefined, removable: true }];
}

export function applyIptcEdits(d: IptcData, edits: Edits, prefix = 'iptc'): boolean {
  let changed = false;
  for (const [id, edit] of edits) {
    if (!id.startsWith(`${prefix}:`)) continue;
    const [, recS, dsS] = id.split(':');
    const rec = +recS;
    const ds = +dsS;
    if (!Number.isFinite(rec) || !Number.isFinite(ds)) continue;
    if (!changed) normalizeUtf8(d);
    changed = true;
    const firstIdx = d.datasets.findIndex((x) => x.rec === rec && x.ds === ds);
    const drop = new Set([ds, ...(TIME_OF[ds] ? [TIME_OF[ds]] : [])]);
    d.datasets = d.datasets.filter((x) => !(x.rec === rec && drop.has(x.ds)));
    if (edit.op === 'remove') continue;
    const def = rec === 2 ? IPTC_DATASETS[ds] : undefined;
    if (!def) throw new MetadataError(`IPTC dataset ${rec}:${ds} cannot be edited`);
    const fresh: Dataset[] = [];
    if (def.kind === 'datetime') {
      const p = requireDate(edit.value, def.label);
      const pad = (n: number | undefined, w = 2) => String(n ?? 0).padStart(w, '0');
      fresh.push({ rec, ds, data: encodeUtf8(`${pad(p.year, 4)}${pad(p.month ?? 1)}${pad(p.day ?? 1)}`) });
      if (p.hour !== undefined && TIME_OF[ds]) {
        let tz = '+0000';
        if (p.tz !== undefined) {
          const a = Math.abs(p.tz);
          tz = `${p.tz < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
        }
        fresh.push({ rec, ds: TIME_OF[ds], data: encodeUtf8(`${pad(p.hour)}${pad(p.minute)}${pad(p.second)}${tz}`) });
      }
    } else {
      const values = def.rep ? asList(edit.value) : [asText(edit.value, def.label)];
      for (const v of values) {
        const bytes = encodeUtf8(v);
        if (def.max && bytes.length > def.max * 4) {
          throw new MetadataError(`${def.label}: too long (IPTC allows ${def.max} characters)`);
        }
        fresh.push({ rec, ds, data: bytes });
      }
    }
    let at = firstIdx >= 0 ? Math.min(firstIdx, d.datasets.length) : -1;
    if (at < 0) {
      // keep record 2 roughly sorted by dataset number
      at = d.datasets.findIndex((x) => x.rec > rec || (x.rec === rec && x.ds > ds));
      if (at < 0) at = d.datasets.length;
    }
    d.datasets.splice(at, 0, ...fresh);
  }
  return changed;
}

export function isEmptyIptc(d: IptcData): boolean {
  return !d.datasets.some((x) => x.rec === 2 && x.ds !== 0);
}

// ------------------------------------------- Photoshop image resource blocks

export interface IrbResource {
  sig: string;
  id: number;
  name: Uint8Array;
  data: Uint8Array;
}

export const IRB_IPTC = 0x0404;
export const IRB_IPTC_DIGEST = 0x0425;

export const IRB_NAMES: Record<number, string> = {
  0x03ed: 'Resolution info',
  0x0404: 'IPTC-NAA record',
  0x0406: 'JPEG quality',
  0x0409: 'Thumbnail (Photoshop 4)',
  0x040c: 'Thumbnail',
  0x040f: 'ICC profile',
  0x0411: 'ICC untagged',
  0x0414: 'Document-specific IDs',
  0x041a: 'Slices',
  0x0421: 'Version info',
  0x0422: 'EXIF data 1',
  0x0423: 'EXIF data 3',
  0x0424: 'XMP metadata',
  0x0425: 'IPTC digest',
  0x0426: 'Print scale',
  0x0428: 'Pixel aspect ratio',
  0x043a: 'Print information',
  0x043b: 'Print style',
  0x2710: 'Print flags info',
};

export function parseIrb(b: Uint8Array): IrbResource[] {
  const out: IrbResource[] = [];
  const r = new Reader(b);
  while (r.remaining >= 12) {
    const sig = r.fourcc();
    if (!['8BIM', 'PHUT', 'AgHg', 'DCSR', 'MeSa'].includes(sig)) break;
    const id = r.u16();
    const nameLen = r.u8();
    const name = r.take(nameLen).slice();
    if ((nameLen + 1) % 2) r.skip(1);
    const size = r.u32();
    if (size > r.remaining) break;
    const data = r.take(size).slice();
    if (size % 2 && r.remaining) r.skip(1);
    out.push({ sig, id, name, data });
  }
  return out;
}

export function serializeIrb(res: IrbResource[]): Uint8Array {
  const w = new Writer(false, 1024);
  for (const x of res) {
    w.ascii(x.sig).u16(x.id).u8(x.name.length).bytes(x.name);
    if ((x.name.length + 1) % 2) w.u8(0);
    w.u32(x.data.length).bytes(x.data);
    if (x.data.length % 2) w.u8(0);
  }
  return w.finish();
}
