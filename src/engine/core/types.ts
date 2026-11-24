/**
 * Core contracts of the BlueExif engine.
 *
 * A FormatHandler turns a file (Source) into a Metadata snapshot: a list of
 * groups, each holding Fields. The UI edits fields by id and hands an Edits map
 * back to the handler's write(), which re-parses the source, applies the edits
 * and serialises a new file. strip() removes everything that is not needed to
 * render/play the file.
 *
 * Field ids are opaque to the UI but must be deterministic: reading the same
 * bytes twice must yield the same ids, and an id taken from a FieldSpec in
 * `addable` must be accepted by write() to create that field.
 */

export type Category = 'image' | 'audio' | 'video' | 'document';

/**
 * Privacy classification used for the "what does this file reveal" summary.
 * - location: GPS coordinates, place names derived from GPS
 * - identity: people / organisations / accounts (author, owner, company, e-mail)
 * - device:   hardware fingerprints (make, model, serial numbers, lens)
 * - time:     capture / creation / modification timestamps
 * - software: producing application, versions, editing history
 * - content:  embedded thumbnails, comments, descriptions that may leak content
 */
export type Sensitivity = 'location' | 'identity' | 'device' | 'time' | 'software' | 'content';

/**
 * How a value is edited and what JS type it carries:
 *  text / multiline / datetime / enum -> string
 *  integer / number                    -> number
 *  list                                -> string[]
 *  gps                                 -> GpsValue
 *  image                               -> ImageValue
 *  raw                                 -> null (never editable; see Field.display)
 *
 * datetime values are ISO-8601-like strings: "YYYY-MM-DDTHH:MM:SS" with an
 * optional fraction and an optional "Z" / "+HH:MM" suffix. Handlers convert to
 * and from their native representation.
 */
export type FieldKind = 'text' | 'multiline' | 'integer' | 'number' | 'datetime' | 'enum' | 'list' | 'gps' | 'image' | 'raw';

export interface GpsValue {
  lat: number;
  lon: number;
  /** metres above sea level */
  alt?: number | null;
}

export interface ImageValue {
  mime: string;
  data: Uint8Array;
  description?: string;
  /** ID3/FLAC picture type, 3 = front cover */
  pictureType?: number;
  width?: number;
  height?: number;
}

export type FieldValue = string | number | string[] | GpsValue | ImageValue | null;

export interface EnumOption {
  value: string;
  label: string;
}

/** Describes a field a handler knows how to write. Used for "add field" menus. */
export interface FieldSpec {
  id: string;
  label: string;
  kind: FieldKind;
  sensitivity?: Sensitivity;
  /** Underlying tag / property name, shown as a hint, e.g. "Artist (0x013B)" or "dc:creator" */
  tag?: string;
  /** Longer help text */
  description?: string;
  options?: EnumOption[];
  placeholder?: string;
}

export interface Field extends FieldSpec {
  value: FieldValue;
  /** Human readable rendering. Required for raw fields; optional otherwise. */
  display?: string;
  editable: boolean;
  removable: boolean;
}

export interface FieldGroup {
  id: string;
  label: string;
  /** The metadata standard / container the group lives in: "EXIF", "XMP", "ID3v2.4"… */
  source?: string;
  fields: Field[];
  /** Fields that can be added to this group (not currently present). */
  addable?: FieldSpec[];
  /** The whole group can be dropped with a single `groupKey(id)` remove edit. */
  removable?: boolean;
}

export interface InfoItem {
  label: string;
  value: string;
}

export interface FormatInfo {
  /** handler id */
  id: string;
  /** e.g. "JPEG image" */
  name: string;
  mime: string;
  category: Category;
}

export interface Metadata {
  format: FormatInfo;
  /** Read-only technical facts: dimensions, duration, codec, page count… */
  info: InfoItem[];
  groups: FieldGroup[];
  warnings: string[];
  canWrite: boolean;
  canStrip: boolean;
}

export type Edit = { op: 'set'; value: FieldValue } | { op: 'remove' };

/** fieldId -> edit. Group-wide removal uses the key produced by groupKey(). */
export type Edits = Map<string, Edit>;

export const groupKey = (groupId: string) => `@group:${groupId}`;

export interface StripOptions {
  /** Keep the image orientation flag so photos are not displayed sideways. */
  keepOrientation: boolean;
  /** Keep embedded ICC colour profiles so colours do not shift. */
  keepColorProfile: boolean;
  /** Keep embedded cover art / album pictures. */
  keepCoverArt: boolean;
}

export const DEFAULT_STRIP_OPTIONS: StripOptions = {
  keepOrientation: true,
  keepColorProfile: true,
  keepCoverArt: false,
};

export interface DetectContext {
  /** First bytes of the file (up to 64 KiB) */
  head: Uint8Array;
  /** Lower-case file name */
  name: string;
  /** Lower-case extension without dot, '' if none */
  ext: string;
  size: number;
}

export interface FormatHandler {
  id: string;
  name: string;
  category: Category;
  extensions: string[];
  mime: string;
  /**
   * Return a confidence score: 0 = not mine, 1 = extension match only,
   * 2 = magic match, 3 = magic + specific structure. Highest score wins.
   */
  detect(ctx: DetectContext): number;
  read(src: Source): Promise<Metadata>;
  write?(src: Source, edits: Edits): Promise<Blob>;
  strip?(src: Source, opts: StripOptions): Promise<Blob>;
}

/** Machine-readable reason attached to some MetadataErrors (drives UI such as the password prompt). */
export type MetadataErrorCode = 'password-required' | 'wrong-password';

/** Thrown for user-facing problems (unsupported variant, invalid value…). */
export class MetadataError extends Error {
  constructor(
    message: string,
    readonly code?: MetadataErrorCode,
  ) {
    super(message);
    this.name = 'MetadataError';
  }
}

export interface SourceOptions {
  /** Password for encrypted files (e.g. password-protected PDFs). */
  password?: string;
}

/**
 * Random-access view over a Blob/File. Handlers may read everything with
 * bytes() (cached) or fetch ranges with read(). Output Blobs can reference
 * untouched regions with slice(), which is zero-copy in browsers — this is how
 * large video/audio payloads are carried over without loading them.
 */
export class Source {
  private cache: Promise<Uint8Array> | null = null;
  readonly password?: string;

  constructor(
    readonly blob: Blob,
    readonly name: string = 'file',
    opts: SourceOptions = {},
  ) {
    this.password = opts.password;
  }

  get size(): number {
    return this.blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0) offset = 0;
    const end = Math.min(this.blob.size, offset + length);
    if (end <= offset) return new Uint8Array(0);
    if (this.cache) {
      const all = await this.cache;
      return all.subarray(offset, end);
    }
    return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
  }

  bytes(): Promise<Uint8Array> {
    if (!this.cache) {
      this.cache = this.blob.arrayBuffer().then((b) => new Uint8Array(b));
    }
    return this.cache;
  }

  slice(start: number, end: number = this.blob.size): Blob {
    return this.blob.slice(start, end);
  }

  static fromBytes(bytes: Uint8Array, name = 'file', opts: SourceOptions = {}): Source {
    return new Source(new Blob([bytes as BlobPart]), name, opts);
  }
}
