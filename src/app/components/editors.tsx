import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { FieldKind, FieldSpec, FieldValue, GpsValue, ImageValue } from '../../engine/core/types';
import { formatGps, imageValue, parseDate, parseGpsString, describeImage } from '../../engine/core/fields';
import { Icon } from './Icon';

export interface EditorProps {
  spec: FieldSpec;
  value: FieldValue;
  display?: string;
  onChange: (value: FieldValue) => void;
  /** Called with false while the editor holds a draft it cannot commit. */
  onValidity?: (valid: boolean) => void;
  /** Newly added fields may stay empty (they are simply not written). */
  allowEmpty?: boolean;
  autoFocus?: boolean;
}

const EMPTY_MESSAGE = 'Enter a value — to delete this field, use Remove';

/** Empty value used when a field is first added. */
export function emptyValue(kind: FieldKind): FieldValue {
  switch (kind) {
    case 'list':
      return [];
    case 'gps':
    case 'image':
      return null;
    default:
      return '';
  }
}

export function isEmptyValue(v: FieldValue): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function Editor(props: EditorProps) {
  switch (props.spec.kind) {
    case 'text':
      return <TextEditor {...props} />;
    case 'multiline':
      return <TextEditor {...props} multiline />;
    case 'integer':
    case 'number':
      return <NumberEditor {...props} />;
    case 'datetime':
      return <DateEditor {...props} />;
    case 'enum':
      return <EnumEditor {...props} />;
    case 'list':
      return <ListEditor {...props} />;
    case 'gps':
      return <GpsEditor {...props} />;
    case 'image':
      return <ImageEditor {...props} />;
    default:
      return <RawView text={props.display ?? ''} />;
  }
}

/** Inline validation message, linked to its control via aria-describedby. */
function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p className="field-error" id={id}>
      <Icon name="alert" size="sm" />
      {children}
    </p>
  );
}

/** Report validity changes to the parent (and reset on unmount). */
function useValidity(valid: boolean, onValidity?: (valid: boolean) => void) {
  useEffect(() => {
    onValidity?.(valid);
  }, [valid, onValidity]);
  useEffect(() => () => onValidity?.(true), [onValidity]);
}

// ------------------------------------------------------------------- text

function TextEditor({ spec, value, onChange, autoFocus, multiline }: EditorProps & { multiline?: boolean }) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const long = multiline || text.length > 90 || text.includes('\n');
  if (long) {
    return (
      <textarea
        className="textarea"
        value={text}
        dir="auto"
        rows={Math.min(8, Math.max(2, Math.ceil(text.length / 60)))}
        placeholder={spec.placeholder}
        aria-label={spec.label}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="input"
      value={text}
      dir="auto"
      placeholder={spec.placeholder}
      aria-label={spec.label}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ----------------------------------------------------------------- number

function NumberEditor({ spec, value, onChange, onValidity, allowEmpty, autoFocus }: EditorProps) {
  const errId = useId();
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  useEffect(() => setDraft(value == null ? '' : String(value)), [value]);
  const trimmed = draft.trim();
  const n = Number(trimmed);
  const ok = trimmed !== '' && Number.isFinite(n) && (spec.kind !== 'integer' || Number.isInteger(n));
  const empty = trimmed === '' && !allowEmpty;
  const invalid = (!ok && trimmed !== '') || empty;
  useValidity(!invalid, onValidity);
  return (
    <div>
      <input
        className={`input${invalid ? ' invalid' : ''}`}
        inputMode={spec.kind === 'integer' ? 'numeric' : 'decimal'}
        value={draft}
        aria-label={spec.label}
        aria-invalid={invalid}
        aria-describedby={invalid ? errId : undefined}
        autoFocus={autoFocus}
        placeholder={spec.placeholder ?? '0'}
        onChange={(e) => {
          setDraft(e.target.value);
          const t = e.target.value.trim();
          const x = Number(t);
          if (t !== '' && Number.isFinite(x) && (spec.kind !== 'integer' || Number.isInteger(x))) onChange(x);
        }}
      />
      {invalid && <FieldError id={errId}>{empty ? EMPTY_MESSAGE : spec.kind === 'integer' ? 'Enter a whole number' : 'Enter a number'}</FieldError>}
    </div>
  );
}

// ------------------------------------------------------------------- date

/** ISO → "YYYY-MM-DD HH:MM:SS(+TZ)" for editing */
function isoToInput(iso: string): string {
  return iso.replace('T', ' ');
}

function nowLocalIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const tz = `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
}

function DateEditor({ spec, value, onChange, onValidity, allowEmpty, autoFocus }: EditorProps) {
  const errId = useId();
  const iso = typeof value === 'string' ? value : '';
  const [draft, setDraft] = useState(isoToInput(iso));
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(isoToInput(iso)), [iso]);
  const empty = draft.trim() === '' && !allowEmpty;
  const invalid = (draft.trim() !== '' && !parseDate(draft)) || empty;
  useValidity(!invalid, onValidity);
  const commit = (s: string) => {
    setDraft(s);
    if (s.trim() && parseDate(s)) onChange(s.trim().replace(' ', 'T'));
  };
  const local = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/.exec(draft)?.[0].replace(' ', 'T') ?? '';
  return (
    <div>
      <div className="input-row">
        <input
          className={`input tabular${invalid ? ' invalid' : ''}`}
          value={draft}
          placeholder="YYYY-MM-DD HH:MM:SS"
          aria-label={spec.label}
          aria-invalid={invalid}
          aria-describedby={invalid ? errId : undefined}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={(e) => commit(e.target.value)}
        />
        <span className="date-pick">
          <button className="icon-btn" type="button" aria-label={`Pick ${spec.label.toLowerCase()} from a calendar`} onClick={() => picker.current?.showPicker?.()}>
            <Icon name="calendar" size="sm" />
          </button>
          <input
            ref={picker}
            type="datetime-local"
            step={1}
            tabIndex={-1}
            aria-hidden="true"
            value={local.length === 16 ? `${local}:00` : local}
            onChange={(e) => {
              const tz = /(Z|[+-]\d{2}:\d{2})$/.exec(draft)?.[0] ?? '';
              if (e.target.value) commit(isoToInput(e.target.value.length === 16 ? `${e.target.value}:00` : e.target.value) + tz);
            }}
          />
        </span>
        <button className="btn ghost sm" type="button" onClick={() => commit(isoToInput(nowLocalIso()))}>
          Now
        </button>
      </div>
      {invalid && <FieldError id={errId}>{empty ? EMPTY_MESSAGE : 'Use YYYY-MM-DD HH:MM:SS, optionally with a time zone like +02:00'}</FieldError>}
    </div>
  );
}

// ------------------------------------------------------------------- enum

function EnumEditor({ spec, value, onChange, autoFocus }: EditorProps) {
  const v = value == null ? '' : String(value);
  const known = spec.options?.some((o) => o.value === v);
  return (
    <span className="select-wrap">
      <select className="select" value={v} aria-label={spec.label} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={v}>{v || '—'}</option>}
        {spec.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron" size="sm" />
    </span>
  );
}

// ------------------------------------------------------------------- list

function ListEditor({ spec, value, onChange, autoFocus }: EditorProps) {
  const items = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const parts = raw
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onChange([...items, ...parts]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && items.length) {
      onChange(items.slice(0, -1));
    }
  };
  return (
    <div className="chips" onClick={() => input.current?.focus()}>
      {items.map((it, i) => (
        <span className="chip" key={`${i}:${it}`} dir="auto">
          {it}
          <button
            type="button"
            aria-label={`Remove ${it}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(items.filter((_, k) => k !== i));
              input.current?.focus();
            }}
          >
            <Icon name="x" size="sm" />
          </button>
        </span>
      ))}
      <input
        ref={input}
        value={draft}
        dir="auto"
        aria-label={`Add to ${spec.label}`}
        placeholder={items.length ? '' : 'Type and press Enter'}
        autoFocus={autoFocus}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

// -------------------------------------------------------------------- gps

// Very rough continent outlines (lon, lat) — enough to orient the pin offline.
const LAND: number[][] = [
  [-168, 66, -162, 70, -140, 70, -120, 72, -95, 72, -80, 68, -62, 60, -55, 52, -66, 44, -70, 41, -76, 35, -81, 31, -80, 25, -82, 29, -90, 30, -97, 27, -97, 21, -87, 21, -88, 16, -83, 10, -79, 8, -84, 14, -92, 15, -105, 20, -112, 30, -117, 32, -124, 40, -124, 48, -133, 57, -150, 60, -158, 57, -165, 62],
  [-79, 8, -72, 12, -62, 10, -50, 0, -35, -6, -39, -14, -41, -22, -48, -26, -53, -34, -58, -38, -65, -42, -68, -50, -70, -55, -74, -50, -73, -40, -71, -30, -70, -18, -76, -14, -81, -5, -80, 0],
  [-10, 36, -9, 43, -2, 44, -4, 48, 2, 51, 8, 54, 8, 57, 5, 61, 12, 65, 18, 70, 28, 71, 40, 67, 40, 60, 30, 55, 28, 46, 24, 40, 20, 40, 16, 38, 12, 44, 8, 44, 3, 43, -1, 37],
  [-17, 15, -17, 21, -13, 28, -6, 35, 10, 37, 20, 32, 32, 31, 35, 28, 43, 12, 51, 12, 44, 0, 40, -15, 35, -24, 27, -34, 19, -35, 15, -27, 12, -17, 13, -6, 9, 0, 8, 4, -8, 4, -14, 8],
  [28, 46, 30, 55, 40, 60, 40, 67, 60, 70, 80, 73, 100, 77, 115, 74, 140, 72, 170, 70, 180, 67, 180, 64, 160, 60, 155, 55, 140, 52, 142, 46, 135, 43, 128, 38, 126, 35, 122, 40, 120, 30, 118, 24, 110, 20, 108, 12, 104, 10, 100, 14, 98, 8, 93, 16, 90, 22, 80, 15, 77, 8, 73, 20, 67, 24, 58, 26, 56, 25, 52, 28, 48, 30, 44, 38, 36, 36, 30, 40],
  [35, 28, 43, 12, 52, 16, 58, 22, 56, 25, 52, 28, 48, 30, 38, 32],
  [114, -22, 122, -18, 130, -12, 137, -12, 142, -11, 146, -19, 153, -26, 151, -33, 146, -39, 138, -35, 132, -32, 124, -34, 115, -34, 114, -26],
  [-55, 60, -45, 60, -20, 70, -20, 80, -40, 83, -60, 82, -70, 77, -58, 70],
  [130, 31, 134, 34, 140, 36, 142, 41, 141, 45, 140, 41, 136, 36, 131, 34],
  [-6, 50, 1, 51, 0, 53, -3, 58, -6, 57, -5, 54],
  [44, -25, 47, -25, 50, -16, 49, -12, 44, -17],
  [172, -34, 178, -38, 174, -41, 167, -46, 170, -44],
  [95, 5, 105, -6, 115, -8, 120, -9, 125, -8, 118, 0, 110, 2, 104, 1],
  [-180, -72, 180, -72, 180, -90, -180, -90],
];

const LAND_PATHS = LAND.map((pts) => {
  let d = '';
  for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i] + 180} ${90 - pts[i + 1]}`;
  return `${d}Z`;
});

export function MiniMap({ gps }: { gps: GpsValue | null }) {
  return (
    <svg className="minimap" viewBox="0 0 360 180" role="img" aria-label={gps ? `Map pin at ${formatGps(gps)}` : 'World map'}>
      {[60, 120, 180, 240, 300].map((x) => (
        <line key={`v${x}`} className="grid" x1={x} y1="0" x2={x} y2="180" />
      ))}
      {[30, 60, 90, 120, 150].map((y) => (
        <line key={`h${y}`} className="grid" x1="0" y1={y} x2="360" y2={y} />
      ))}
      {LAND_PATHS.map((d, i) => (
        <path key={i} className="land" d={d} />
      ))}
      {gps && <circle className="pin" cx={gps.lon + 180} cy={90 - gps.lat} r="7" />}
    </svg>
  );
}

function GpsEditor({ value, onChange, onValidity, allowEmpty, autoFocus }: EditorProps) {
  const ids = { lat: useId(), lon: useId(), alt: useId(), osm: useId(), incomplete: useId() };
  const gps = value && typeof value === 'object' && 'lat' in value ? (value as GpsValue) : null;
  const [lat, setLat] = useState(gps ? String(gps.lat) : '');
  const [lon, setLon] = useState(gps ? String(gps.lon) : '');
  const [alt, setAlt] = useState(gps?.alt != null ? String(gps.alt) : '');
  const [paste, setPaste] = useState('');
  useEffect(() => {
    setLat(gps ? String(gps.lat) : '');
    setLon(gps ? String(gps.lon) : '');
    setAlt(gps?.alt != null ? String(gps.alt) : '');
  }, [gps?.lat, gps?.lon, gps?.alt]); // eslint-disable-line react-hooks/exhaustive-deps

  const bad = (s: string, max: number) => s.trim() !== '' && !(Math.abs(Number(s)) <= max);
  const latBad = bad(lat, 90);
  const lonBad = bad(lon, 180);
  const altBad = alt.trim() !== '' && !Number.isFinite(Number(alt));
  const latEmpty = lat.trim() === '';
  const lonEmpty = lon.trim() === '';
  // one coordinate missing, or both cleared on an existing location
  const incomplete = latEmpty !== lonEmpty || (latEmpty && lonEmpty && !allowEmpty);
  const describe = (bad: boolean, own: string, isEmpty: boolean) =>
    [bad ? own : '', incomplete && isEmpty ? ids.incomplete : ''].filter(Boolean).join(' ') || undefined;
  useValidity(!latBad && !lonBad && !altBad && !incomplete, onValidity);

  const commit = (la: string, lo: string, al: string) => {
    const a = Number(la);
    const b = Number(lo);
    if (la.trim() === '' || lo.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) return;
    if (Math.abs(a) > 90 || Math.abs(b) > 180) return;
    const c = al.trim() === '' ? null : Number(al);
    if (c !== null && !Number.isFinite(c)) return;
    onChange({ lat: a, lon: b, alt: c });
  };
  const osm = gps ? `https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lon}#map=15/${gps.lat}/${gps.lon}` : null;

  return (
    <div className="gps">
      <div className="gps-fields">
        <label>
          Latitude
          <input
            className={`input${latBad || (incomplete && latEmpty) ? ' invalid' : ''}`}
            value={lat}
            inputMode="decimal"
            autoFocus={autoFocus}
            placeholder="37.8199"
            aria-invalid={latBad || (incomplete && latEmpty)}
            aria-describedby={describe(latBad, ids.lat, latEmpty)}
            onChange={(e) => {
              setLat(e.target.value);
              commit(e.target.value, lon, alt);
            }}
          />
        </label>
        <label>
          Longitude
          <input
            className={`input${lonBad || (incomplete && lonEmpty) ? ' invalid' : ''}`}
            value={lon}
            inputMode="decimal"
            placeholder="-122.4783"
            aria-invalid={lonBad || (incomplete && lonEmpty)}
            aria-describedby={describe(lonBad, ids.lon, lonEmpty)}
            onChange={(e) => {
              setLon(e.target.value);
              commit(lat, e.target.value, alt);
            }}
          />
        </label>
        <label>
          Altitude (m)
          <input
            className={`input${altBad ? ' invalid' : ''}`}
            value={alt}
            inputMode="decimal"
            placeholder="optional"
            aria-invalid={altBad}
            aria-describedby={altBad ? ids.alt : undefined}
            onChange={(e) => {
              setAlt(e.target.value);
              commit(lat, lon, e.target.value);
            }}
          />
        </label>
      </div>
      {latBad && <FieldError id={ids.lat}>Latitude must be between −90 and 90</FieldError>}
      {lonBad && <FieldError id={ids.lon}>Longitude must be between −180 and 180</FieldError>}
      {altBad && <FieldError id={ids.alt}>Altitude must be a number of metres</FieldError>}
      {incomplete && (
        <FieldError id={ids.incomplete}>
          {latEmpty && lonEmpty ? 'Enter coordinates — to delete the location, use Remove' : 'Enter both latitude and longitude'}
        </FieldError>
      )}
      <input
        className="input"
        value={paste}
        placeholder="…or paste coordinates, e.g. 48.8584, 2.2945"
        aria-label="Paste coordinates"
        onChange={(e) => {
          setPaste(e.target.value);
          const g = parseGpsString(e.target.value);
          if (g) {
            onChange({ ...g, alt: g.alt ?? gps?.alt ?? null });
            setPaste('');
          }
        }}
      />
      <div className="gps-map">
        <MiniMap gps={gps} />
        <div className="coords">
          <p>{gps ? formatGps(gps) : 'No coordinates yet'}</p>
          {osm && (
            <>
              <a href={osm} target="_blank" rel="noopener noreferrer" aria-describedby={ids.osm}>
                View on OpenStreetMap <Icon name="external" size="sm" />
              </a>
              <p className="note" id={ids.osm}>
                Opens openstreetmap.org and sends it these coordinates.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ image

/**
 * Object URL for in-memory bytes. Created and revoked inside one effect so
 * StrictMode's mount/unmount/mount cycle never leaves a revoked URL behind.
 */
export function useObjectUrl(data: Uint8Array | null | undefined, mime: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!data?.length) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(new Blob([data as BlobPart], { type: mime || 'application/octet-stream' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, mime]);
  return url;
}

function ImageEditor({ spec, value, onChange, autoFocus }: EditorProps) {
  const img = value && typeof value === 'object' && 'data' in value ? (value as ImageValue) : null;
  const url = useObjectUrl(img?.data, img?.mime);
  const fileInput = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    onChange(imageValue(data, file.type, { pictureType: img?.pictureType ?? 3, description: img?.description }));
  };
  const ext = img?.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
  return (
    <div className="image-edit">
      {url ? <img className="img" src={url} alt={spec.label} /> : <div className="img" />}
      <div className="img-meta">
        <span>{img ? describeImage(img) : 'No image selected'}</span>
        <div className="img-actions">
          <button className="btn sm" type="button" autoFocus={autoFocus} onClick={() => fileInput.current?.click()}>
            {img ? 'Replace' : 'Choose image'}
          </button>
          {url && (
            <a className="btn sm ghost" href={url} download={`${spec.label.replace(/\W+/g, '-').toLowerCase()}.${ext}`}>
              Save copy
            </a>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

/** Read-only image (for non-editable image fields such as EXIF thumbnails). */
export function ImageView({ value, label }: { value: ImageValue; label: string }) {
  const url = useObjectUrl(value.data, value.mime);
  return (
    <div className="image-edit">
      {url ? <img className="img" src={url} alt={label} /> : <div className="img" />}
      <div className="img-meta">
        <span>{describeImage(value)}</span>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- raw

export function RawView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split('\n').length > 3;
  return (
    <div>
      <div className={`raw${long && !open ? ' clamp' : ''}`} dir="auto">
        {text || '—'}
      </div>
      {long && (
        <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
