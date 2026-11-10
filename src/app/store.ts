/** Tiny external store + all user actions. */

import { useSyncExternalStore } from 'react';
import type { Edit, Edits, Field, FieldGroup, Metadata, MetadataErrorCode, Sensitivity, StripOptions } from '../engine/core/types';
import { DEFAULT_STRIP_OPTIONS, groupKey } from '../engine/core/types';
import { EngineError, engine, type FormatSummary } from './engineClient';
import { droppedFiles } from './droppedFiles';
import { zipBlobs } from './zipBlobs';
import sampleUrl from './assets/sample-photo.jpg';

export type FileStatus = 'reading' | 'ready' | 'working' | 'error';

export interface FileEntry {
  id: string;
  name: string;
  original: Blob;
  current: Blob;
  /** previous versions of `current`, newest last */
  history: Array<{ blob: Blob; label: string }>;
  status: FileStatus;
  error?: string;
  /** why the last read failed, when the UI can help (e.g. a password prompt) */
  errorCode?: MetadataErrorCode;
  /** password the user entered for an encrypted file; kept in memory only */
  password?: string;
  meta?: Metadata;
  /** metadata of the original file (for "what changed" summaries) */
  originalMeta?: Metadata;
  edits: Edits;
  previewUrl?: string;
  /** short description of the last committed change */
  note?: string;
  /** field ids whose editor currently holds an invalid draft */
  invalid: string[];
  /** bumped whenever edits are reset, so editors drop local drafts */
  rev: number;
  /** history length at the last download (undefined = never downloaded) */
  downloadedAt?: number;
}

/** Reading or writing: the metadata shown may not match `current` yet, so changes must wait. */
export function isBusy(f: FileEntry): boolean {
  return f.status === 'reading' || f.status === 'working';
}

/** Has the file been changed on this page without downloading the result? */
export function hasUnsavedWork(f: FileEntry): boolean {
  return f.edits.size > 0 || f.history.length !== (f.downloadedAt ?? 0);
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface StripRequest {
  ids: string[];
}

export interface State {
  files: FileEntry[];
  selectedId: string | null;
  formats: FormatSummary[];
  formatsError: boolean;
  toasts: Toast[];
  strip: StripRequest | null;
  about: boolean;
  /** The section whose "About" dialog is open. */
  groupAbout: FieldGroup | null;
  licences: boolean;
  confirmClose: boolean;
  stripOptions: StripOptions;
  filter: string;
  sensitivityFilter: Sensitivity | null;
}

let state: State = {
  files: [],
  selectedId: null,
  formats: [],
  formatsError: false,
  toasts: [],
  strip: null,
  about: false,
  groupAbout: null,
  licences: false,
  confirmClose: false,
  stripOptions: loadStripOptions(),
  filter: '',
  sensitivityFilter: null,
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function updateFile(id: string, patch: Partial<FileEntry> | ((f: FileEntry) => Partial<FileEntry>)): void {
  set((s) => ({
    files: s.files.map((f) => (f.id === id ? { ...f, ...(typeof patch === 'function' ? patch(f) : patch) } : f)),
  }));
}

export function fileById(id: string | null): FileEntry | undefined {
  return id ? state.files.find((f) => f.id === id) : undefined;
}

// ----------------------------------------------------------------- toasts

let toastId = 1;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
const toastLife = (kind: Toast['kind']) => (kind === 'error' ? 10_000 : 5_000);

function armToast(id: number, kind: Toast['kind']): void {
  clearTimeout(toastTimers.get(id));
  toastTimers.set(id, setTimeout(() => dismissToast(id), toastLife(kind)));
}

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = toastId++;
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  armToast(id, kind);
}

const toastHolds = new Map<number, Set<'hover' | 'focus'>>();

/** Pause auto-dismissal while a toast is hovered or holds keyboard focus. */
export function holdToast(id: number, reason: 'hover' | 'focus', hold: boolean): void {
  const t = state.toasts.find((x) => x.id === id);
  if (!t) return;
  const holds = toastHolds.get(id) ?? new Set();
  if (hold) holds.add(reason);
  else holds.delete(reason);
  toastHolds.set(id, holds);
  if (holds.size) clearTimeout(toastTimers.get(id));
  else armToast(id, t.kind);
}

export function dismissToast(id: number): void {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toastHolds.delete(id);
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---------------------------------------------------------------- formats

export async function loadFormats(): Promise<void> {
  try {
    set({ formats: await engine.formats(), formatsError: false });
  } catch (e) {
    set({ formatsError: true });
    toast(`Could not start the metadata engine: ${(e as Error).message}`, 'error');
  }
}

// ------------------------------------------------------------------ files

const PREVIEWABLE = /^(image\/(jpeg|png|gif|webp|avif|bmp|svg\+xml)|audio\/|video\/)/;

function previewFor(blob: Blob, meta?: Metadata): string | undefined {
  const mime = meta?.format.mime ?? blob.type;
  if (!PREVIEWABLE.test(mime)) return undefined;
  const typed = blob.type === mime ? blob : new Blob([blob], { type: mime });
  return URL.createObjectURL(typed);
}

function setPreview(id: string, blob: Blob, meta?: Metadata): void {
  const f = fileById(id);
  if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
  updateFile(id, { previewUrl: previewFor(blob, meta) });
}

let fileSeq = 1;

export async function addFiles(list: FileList | File[]): Promise<void> {
  const files = Array.from(list).filter((f) => f.size > 0 || f.name);
  if (!files.length) return;
  const entries: FileEntry[] = files.map((file) => ({
    id: `f${fileSeq++}`,
    name: file.name || 'untitled',
    original: file,
    current: file,
    history: [],
    status: 'reading',
    edits: new Map(),
    invalid: [],
    rev: 0,
  }));
  set((s) => ({ files: [...s.files, ...entries], selectedId: s.selectedId ?? entries[0].id }));
  await Promise.all(entries.map((e) => readEntry(e.id, true)));
}

/** Open what was dropped, folders included. Call it from the drop event itself (see droppedFiles). */
export async function addDropped(dt: DataTransfer): Promise<void> {
  const { files, skipped, truncated } = await droppedFiles(
    dt,
    state.formats.flatMap((f) => f.extensions),
  );
  const plural = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  if (!files.length) toast('No files BlueExif can open were found', 'error');
  else if (truncated) toast(`Opened the first ${plural(files.length)} — drop fewer at a time to open the rest`);
  else if (skipped) toast(`Skipped ${plural(skipped)} BlueExif can’t open`);
  await addFiles(files);
}

/** The latest read of each file: one that finishes after a newer one started is dropped. */
const reads = new Map<string, number>();
let readSeq = 0;

async function readEntry(id: string, isOriginal = false): Promise<void> {
  const f = fileById(id);
  if (!f) return;
  const seq = ++readSeq;
  reads.set(id, seq);
  const blob = f.current;
  const stale = () => reads.get(id) !== seq || fileById(id)?.current !== blob;
  try {
    const meta = await engine.read(blob, f.name, f.password);
    if (stale()) return;
    updateFile(id, (cur) => ({
      meta,
      originalMeta: isOriginal ? meta : cur.originalMeta,
      status: 'ready',
      error: undefined,
      errorCode: undefined,
    }));
    setPreview(id, blob, meta);
  } catch (e) {
    if (stale()) return;
    updateFile(id, { status: 'error', error: (e as Error).message, errorCode: e instanceof EngineError ? e.code : undefined });
  }
}

/** Open the system file picker (must run inside a user gesture). */
let pickerInput: HTMLInputElement | null = null;

export function pickFiles(): void {
  // Some browsers lose the selection of a detached <input>; keep it in the DOM
  // until the picker reports back.
  pickerInput?.remove();
  const input = (pickerInput = document.createElement('input'));
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  const done = () => {
    input.remove();
    if (pickerInput === input) pickerInput = null;
  };
  input.addEventListener(
    'change',
    () => {
      if (input.files?.length) void addFiles(input.files);
      done();
    },
    { once: true },
  );
  input.addEventListener('cancel', done, { once: true });
  document.body.append(input);
  input.click();
}

/** Bytes of a bundled asset: decoded locally for data: URLs (single-file build, where the CSP forbids fetch). */
async function assetBlob(url: string): Promise<Blob> {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (m) {
    const body = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return new Blob([body], { type: m[1] });
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** Load the bundled sample photo (fictional metadata) to try the app. */
export async function loadSample(): Promise<void> {
  try {
    const blob = await assetBlob(sampleUrl);
    await addFiles([new File([blob], 'sample-photo.jpg', { type: 'image/jpeg' })]);
  } catch (e) {
    toast(`Could not load the sample: ${(e as Error).message}`, 'error');
  }
}

export function setAbout(open: boolean): void {
  set({ about: open });
}

export function setGroupAbout(group: FieldGroup | null): void {
  set({ groupAbout: group });
}

export function setLicences(open: boolean): void {
  set({ licences: open });
}

export function setConfirmClose(open: boolean): void {
  set({ confirmClose: open });
}

/** Retry reading an encrypted file with the password the user typed. */
export async function unlock(id: string, password: string): Promise<boolean> {
  updateFile(id, { password, status: 'reading', error: undefined, errorCode: undefined });
  await readEntry(id, !fileById(id)?.originalMeta);
  return fileById(id)?.status === 'ready';
}

export function select(id: string | null): void {
  if (id === state.selectedId) return;
  set({ selectedId: id, filter: '', sensitivityFilter: null });
}

export function removeFile(id: string): void {
  const f = fileById(id);
  reads.delete(id);
  if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
  set((s) => {
    const idx = s.files.findIndex((x) => x.id === id);
    const files = s.files.filter((x) => x.id !== id);
    if (s.selectedId !== id) return { files };
    const selectedId = files[Math.min(idx, files.length - 1)]?.id ?? null;
    return { files, selectedId, filter: '', sensitivityFilter: null };
  });
}

export function clearAll(): void {
  for (const f of state.files) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
  reads.clear();
  set({ files: [], selectedId: null, filter: '', sensitivityFilter: null });
}

// ------------------------------------------------------------------ edits

export function setEdit(id: string, fieldId: string, edit: Edit | null): void {
  updateFile(id, (f) => {
    const edits = new Map(f.edits);
    if (edit) edits.set(fieldId, edit);
    else edits.delete(fieldId);
    return { edits };
  });
}

export function setEdits(id: string, changes: Array<[string, Edit | null]>): void {
  updateFile(id, (f) => {
    const edits = new Map(f.edits);
    for (const [k, e] of changes) {
      if (e) edits.set(k, e);
      else edits.delete(k);
    }
    return { edits };
  });
}

/** Copy one pending edit to every other open file that has (or can add) the same field. */
export function copyEditToAll(sourceId: string, fieldId: string): number {
  const edit = fileById(sourceId)?.edits.get(fieldId);
  if (!edit) return 0;
  let n = 0;
  for (const f of state.files) {
    if (f.id === sourceId || !f.meta?.canWrite) continue;
    const has = f.meta.groups.some((g) => g.fields.some((x) => x.id === fieldId && (edit.op === 'remove' ? x.removable : x.editable)) || g.addable?.some((x) => x.id === fieldId));
    if (!has) continue;
    setEdit(f.id, fieldId, edit);
    n++;
  }
  return n;
}

export function discardEdits(id: string): void {
  updateFile(id, (f) => ({ edits: new Map(), invalid: [], rev: f.rev + 1 }));
}

/** Editors report drafts they cannot commit (bad dates, numbers, coordinates). */
export function setInvalid(id: string, fieldId: string, invalid: boolean): void {
  const f = fileById(id);
  if (!f || f.invalid.includes(fieldId) === invalid) return;
  updateFile(id, (cur) => ({
    invalid: invalid ? [...cur.invalid, fieldId] : cur.invalid.filter((x) => x !== fieldId),
  }));
}

/** Mark every removable field in a group for removal. */
export function removeGroup(id: string, group: FieldGroup): void {
  if (group.removable) {
    setEdits(id, [[groupKey(group.id), { op: 'remove' }], ...group.fields.map((f) => [f.id, null] as [string, null])]);
    return;
  }
  setEdits(
    id,
    group.fields.filter((f) => f.removable).map((f) => [f.id, { op: 'remove' }] as [string, Edit]),
  );
}

export function restoreGroup(id: string, group: FieldGroup): void {
  setEdits(id, [[groupKey(group.id), null], ...group.fields.map((f) => [f.id, null] as [string, null])]);
}

/** Queue removal of every field in the given privacy categories. */
export function removeSensitive(id: string, categories: Sensitivity[]): number {
  const f = fileById(id);
  if (!f?.meta) return 0;
  const targets: Field[] = f.meta.groups
    .flatMap((g) => g.fields)
    .filter((x) => x.removable && x.sensitivity && categories.includes(x.sensitivity));
  setEdits(
    id,
    targets.map((x) => [x.id, { op: 'remove' }]),
  );
  return targets.length;
}

function describeEdits(edits: Edits): string {
  let set = 0;
  let removed = 0;
  for (const [k, e] of edits) {
    if (k.startsWith('@group:')) removed++;
    else if (e.op === 'remove') removed++;
    else set++;
  }
  const parts = [];
  if (set) parts.push(`${set} field${set > 1 ? 's' : ''} updated`);
  if (removed) parts.push(`${removed} removed`);
  return parts.join(', ') || 'No changes';
}

/**
 * Replace the file's current version with `run`'s output. A successful save
 * keeps editors mounted (bumpRev=false) so keyboard focus stays in place;
 * strip/undo/revert reset them.
 */
async function commit(id: string, label: string, run: (f: FileEntry) => Promise<Blob>, bumpRev = true): Promise<boolean> {
  const f = fileById(id);
  if (!f || f.status !== 'ready') return false;
  updateFile(id, { status: 'working' });
  try {
    const out = await run(f);
    const meta = await engine.read(out, f.name, f.password);
    if (!fileById(id)) return false;
    updateFile(id, (cur) => ({
      current: out,
      meta,
      history: [...cur.history, { blob: cur.current, label }],
      edits: new Map(),
      invalid: [],
      rev: bumpRev ? cur.rev + 1 : cur.rev,
      status: 'ready',
      error: undefined,
      note: label,
    }));
    setPreview(id, out, meta);
    return true;
  } catch (e) {
    updateFile(id, { status: f.meta ? 'ready' : 'error' });
    toast(`${f.name}: ${(e as Error).message}`, 'error');
    return false;
  }
}

/** Drop "added" fields the user never filled in. */
function effectiveEdits(f: FileEntry): Edits {
  const existing = new Set(f.meta?.groups.flatMap((g) => g.fields.map((x) => x.id)) ?? []);
  const out: Edits = new Map();
  for (const [k, e] of f.edits) {
    const empty = e.op === 'set' && (e.value === null || e.value === '' || (Array.isArray(e.value) && !e.value.length));
    if (empty && !existing.has(k)) continue;
    out.set(k, e);
  }
  return out;
}

export async function applyEdits(id: string): Promise<boolean> {
  const f = fileById(id);
  if (!f || !f.edits.size) return true;
  if (f.invalid.length) {
    toast(`Fix the ${f.invalid.length === 1 ? 'invalid value' : `${f.invalid.length} invalid values`} before saving`, 'error');
    return false;
  }
  const edits = effectiveEdits(f);
  if (!edits.size) {
    discardEdits(id);
    return true;
  }
  const label = describeEdits(edits);
  const ok = await commit(id, label, (cur) => engine.write(cur.current, cur.name, edits, cur.password), false);
  if (ok) toast(`Saved — ${label.toLowerCase()}`, 'success');
  return ok;
}

export function openStrip(ids: string[]): void {
  set({ strip: { ids } });
}

export function closeStrip(): void {
  set({ strip: null });
}

export function setStripOptions(opts: StripOptions): void {
  set({ stripOptions: opts });
  try {
    localStorage.setItem('blueexif.strip', JSON.stringify(opts));
  } catch {
    /* storage unavailable */
  }
}

function loadStripOptions(): StripOptions {
  try {
    const raw = localStorage.getItem('blueexif.strip');
    if (raw) return { ...DEFAULT_STRIP_OPTIONS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_STRIP_OPTIONS };
}

export async function stripFiles(ids: string[]): Promise<void> {
  closeStrip();
  const opts = state.stripOptions;
  let ok = 0;
  for (const id of ids) {
    const f = fileById(id);
    if (!f || f.status === 'error' || !f.meta?.canStrip) continue;
    if (await commit(id, 'Metadata stripped', (cur) => engine.strip(cur.current, cur.name, opts, cur.password))) ok++;
  }
  if (ok) toast(ok === 1 ? 'Metadata removed' : `Metadata removed from ${ok} files`, 'success');
}

export function undo(id: string): void {
  const f = fileById(id);
  const prev = f?.history[f.history.length - 1];
  if (!f || !prev || isBusy(f)) return;
  updateFile(id, {
    current: prev.blob,
    history: f.history.slice(0, -1),
    edits: new Map(),
    invalid: [],
    rev: f.rev + 1,
    status: 'reading',
    note: undefined,
  });
  void readEntry(id);
}

export function revert(id: string): void {
  const f = fileById(id);
  if (!f || !f.history.length || isBusy(f)) return;
  updateFile(id, {
    current: f.original,
    history: [],
    edits: new Map(),
    invalid: [],
    rev: f.rev + 1,
    status: 'reading',
    note: undefined,
  });
  void readEntry(id);
}

// --------------------------------------------------------------- download

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function blockedByInvalid(f: FileEntry): boolean {
  if (!f.invalid.length) return false;
  toast(`${f.name}: fix the ${f.invalid.length === 1 ? 'invalid value' : `${f.invalid.length} invalid values`} before downloading`, 'error');
  return true;
}

function markDownloaded(id: string): void {
  updateFile(id, (f) => ({ downloadedAt: f.history.length }));
}

export async function download(id: string): Promise<void> {
  let f = fileById(id);
  if (!f || blockedByInvalid(f)) return;
  if (f.edits.size) {
    if (!(await applyEdits(id))) return;
    f = fileById(id)!;
  }
  triggerDownload(new Blob([f.current], { type: f.meta?.format.mime ?? f.current.type }), f.name);
  markDownloaded(id);
}

/** Download a JSON report of the file's current metadata (binary values summarised). */
export function exportReport(id: string, describe: (f: Field) => string): void {
  const f = fileById(id);
  if (!f?.meta) return;
  const report = {
    file: f.name,
    size: f.current.size,
    format: f.meta.format.name,
    mime: f.meta.format.mime,
    info: Object.fromEntries(f.meta.info.map((i) => [i.label, i.value])),
    groups: f.meta.groups
      .filter((g) => g.fields.length)
      .map((g) => ({
        group: g.label,
        source: g.source,
        fields: g.fields.map((x) => ({
          label: x.label,
          tag: x.tag,
          value: x.kind === 'list' && Array.isArray(x.value) ? x.value : describe(x),
          sensitivity: x.sensitivity,
        })),
      })),
    warnings: f.meta.warnings,
    generatedBy: 'BlueExif',
  };
  triggerDownload(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `${f.name}.metadata.json`);
}

export async function downloadAll(): Promise<void> {
  const ids = state.files.filter((f) => f.status !== 'error').map((f) => f.id);
  if (!ids.length) return;
  // Never ship a file whose pending changes could not be applied.
  for (const id of ids) {
    const f = fileById(id);
    if (!f) continue;
    if (blockedByInvalid(f)) return;
    if (f.edits.size && !(await applyEdits(id))) {
      toast(`${f.name}: not downloaded — fix or discard its unsaved changes first`, 'error');
      return;
    }
  }
  const used = new Set<string>();
  const entries = ids.map((id) => {
    const f = fileById(id)!;
    let name = f.name;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const dot = f.name.lastIndexOf('.');
      name = dot > 0 ? `${f.name.slice(0, dot)} (${n})${f.name.slice(dot)}` : `${f.name} (${n})`;
    }
    used.add(name.toLowerCase());
    return { id, name, blob: f.current };
  });
  if (entries.reduce((n, e) => n + e.blob.size, 0) > 256 << 20) toast('Preparing the .zip…');
  let zipped: Blob;
  try {
    // Fixed timestamps: the archive itself should not leak when it was made.
    zipped = await zipBlobs(entries, new Date(1980, 0, 1));
  } catch (e) {
    toast(`Could not make the .zip: ${(e as Error).message}`, 'error');
    return;
  }
  triggerDownload(zipped, 'blueexif-files.zip');
  // Only versions that went into the archive count as downloaded.
  for (const e of entries) updateFile(e.id, (f) => (f.current === e.blob ? { downloadedAt: f.history.length } : {}));
}

// ------------------------------------------------------------------ filter

export function setFilter(filter: string): void {
  set({ filter });
}

export function setSensitivityFilter(s: Sensitivity | null): void {
  set((st) => ({ sensitivityFilter: st.sensitivityFilter === s ? null : s }));
}
