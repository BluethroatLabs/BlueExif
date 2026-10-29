/**
 * Controls around the editor: Files and Reveals (before the fields in DOM
 * order) and Export (after them). CSS grid areas place them in the right
 * column on wide screens, so visual, reading and focus order always agree.
 */

import { memo, useEffect, useId, useRef, useState } from 'react';
import type { Sensitivity } from '../../engine/core/types';
import { formatBytes } from '../../engine/core/binary';
import {
  download,
  downloadAll,
  exportReport,
  isBusy,
  openStrip,
  pickFiles,
  removeSensitive,
  revert,
  select,
  setConfirmClose,
  setSensitivityFilter,
  toast,
  undo,
  useStore,
  type FileEntry,
} from '../store';
import { useObjectUrl } from './editors';
import { usePdfPage } from '../pdfPreview';
import { categoryIcon, firstPicture, sensitivityCounts } from './fileInfo';
import { valueText } from './GroupCard';
import { afterRender } from './afterRender';
import { Icon } from './Icon';
import { DEFAULT_PERSONAL, RISK_TAG, SENS, SENS_ORDER } from './sensitivity';

// ------------------------------------------------------------------- files

function Thumb({ file }: { file: FileEntry }) {
  const isImage = file.meta?.format.category === 'image';
  const isPdf = file.meta?.format.id === 'pdf';
  // Decorative (alt=""): the file name is right next to it in the same button.
  const pdf = usePdfPage(isPdf ? file : null);
  const pic = isImage || isPdf ? null : firstPicture(file.meta);
  const picUrl = useObjectUrl(pic?.data, pic?.mime);
  if (file.status === 'reading' && !file.meta) {
    return (
      <span className="thumb">
        <span className="spinner sm" role="img" aria-label="Reading" />
      </span>
    );
  }
  if (isPdf) {
    return (
      <span className="thumb pdf" ref={pdf.ref}>
        {pdf.page ? <img className="pdf-page" src={pdf.page.url} width={pdf.page.width} height={pdf.page.height} alt="" /> : <Icon name={categoryIcon(file.meta)} />}
      </span>
    );
  }
  const src = isImage ? file.previewUrl : picUrl;
  return <span className="thumb">{src ? <img src={src} alt="" loading="lazy" /> : <Icon name={categoryIcon(file.meta)} />}</span>;
}

function Status({ file }: { file: FileEntry }) {
  if (file.status === 'error' && (file.errorCode === 'password-required' || file.errorCode === 'wrong-password')) {
    return <span className="tag suspicious">Locked</span>;
  }
  if (file.status === 'error') {
    const unsupported = /unsupported file type/i.test(file.error ?? '');
    return (
      <span className="tag suspicious" title={file.error}>
        {unsupported ? 'Unsupported' : 'Can’t read'}
      </span>
    );
  }
  if (file.status === 'working') return <span className="spinner sm" role="img" aria-label="Working" />;
  if (!file.meta) return null;
  if (file.edits.size) return <span className="tag ink">Unsaved</span>;
  const c = sensitivityCounts(file);
  if (c.get('location')) return <span className="tag malicious">Location</span>;
  const personal = (c.get('identity') ?? 0) + (c.get('device') ?? 0);
  if (personal) return <span className="tag suspicious">{personal} personal</span>;
  if (file.history.length) return <span className="tag clean">Clean</span>;
  return null;
}

const FileItem = memo(function FileItem({ file, selected }: { file: FileEntry; selected: boolean }) {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : (file.meta?.format.name ?? '');
  return (
    <li>
      <button className="file-item" type="button" onClick={() => select(file.id)} aria-current={selected}>
        <Thumb file={file} />
        <span className="file-meta">
          <span className="file-name" title={file.name} dir="auto">
            {file.name}
          </span>
          <span className="file-sub">
            <span>
              {ext} · {formatBytes(file.current.size)}
            </span>
            <Status file={file} />
          </span>
        </span>
      </button>
    </li>
  );
});

function FilesSection() {
  const files = useStore((s) => s.files);
  const selectedId = useStore((s) => s.selectedId);
  return (
    <section className="control-section" aria-labelledby="files-heading">
      <div className="section-label">
        <h3 id="files-heading">Files</h3>
        <span>{files.length}</span>
      </div>
      <ul className="file-list">
        {files.map((f) => (
          <FileItem key={f.id} file={f} selected={f.id === selectedId} />
        ))}
      </ul>
      <div className="control-row">
        <button className="btn sm" type="button" onClick={pickFiles}>
          Add files <span aria-hidden="true">＋</span>
        </button>
        <button className="btn sm" type="button" onClick={() => setConfirmClose(true)}>
          Close all
        </button>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- reveals

function PersonalMenu({ file }: { file: FileEntry }) {
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<Sensitivity[]>(DEFAULT_PERSONAL);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const counts = sensitivityCounts(file);
  return (
    <div
      className="menu-wrap"
      ref={ref}
      onBlur={(e) => {
        if (open && e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button ref={trigger} className="btn block" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={panelId}>
        Remove personal data…
      </button>
      {open && (
        <div className="menu menu-panel" id={panelId} role="group" aria-label="Choose what to remove">
          <p className="menu-title">Remove fields about</p>
          {SENS_ORDER.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={cats.includes(s)}
                onChange={(e) => setCats(e.target.checked ? [...cats, s] : cats.filter((c) => c !== s))}
              />
              <span>{SENS[s].label}</span>
              <span className="hint">{counts.get(s) ?? 0}</span>
            </label>
          ))}
          <div className="menu-foot">
            <button
              className="btn primary"
              type="button"
              disabled={!cats.some((c) => counts.get(c))}
              onClick={() => {
                const n = removeSensitive(file.id, cats);
                setOpen(false);
                // if every category was marked, this menu disappears: fall back to the section heading
                afterRender(() => (trigger.current?.isConnected ? trigger.current : document.getElementById('reveals-heading'))?.focus());
                toast(`${n} field${n === 1 ? '' : 's'} marked for removal — review, then Save`);
              }}
            >
              Mark for removal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RevealSection({ file }: { file: FileEntry }) {
  const active = useStore((s) => s.sensitivityFilter);
  const counts = sensitivityCounts(file);
  const present = SENS_ORDER.filter((s) => counts.get(s));
  const total = present.reduce((n, s) => n + (counts.get(s) ?? 0), 0);
  return (
    <section className="control-section" aria-labelledby="reveals-heading">
      <div className="section-label">
        <h3 id="reveals-heading" tabIndex={-1}>
          Reveals
        </h3>
        <span>{total ? `${total} field${total === 1 ? '' : 's'}` : ''}</span>
      </div>
      {!present.length ? (
        <div className="clean-note">
          <Icon name="shield" size="sm" />
          <div>
            <b>Nothing personal found</b>
            <span>No location, people, device or date data remains{file.edits.size ? ' after these changes' : ''}.</span>
          </div>
        </div>
      ) : (
        <>
          <ul className="reveal-list">
            {present.map((s) => (
              <li key={s}>
                <button
                  className="reveal-item"
                  type="button"
                  aria-pressed={active === s}
                  title={active === s ? 'Show all fields' : `Show only ${SENS[s].label.toLowerCase()} fields`}
                  onClick={() => setSensitivityFilter(s)}
                >
                  <span>
                    <Icon name={SENS[s].icon} size="sm" />
                    <span>
                      <strong>{SENS[s].label}</strong>
                      <small>{SENS[s].hint}</small>
                    </span>
                  </span>
                  <span className={RISK_TAG[SENS[s].risk]}>{counts.get(s)}</span>
                </button>
              </li>
            ))}
          </ul>
          {file.meta?.canWrite && <PersonalMenu file={file} />}
        </>
      )}
    </section>
  );
}

export function ControlsTop() {
  const file = useStore((s) => (s.selectedId ? s.files.find((f) => f.id === s.selectedId) : undefined));
  return (
    <aside className="controls controls-top" aria-label="Files and privacy summary">
      <FilesSection />
      {file?.meta ? <RevealSection file={file} /> : null}
    </aside>
  );
}

// ------------------------------------------------------------------ export

/** Undo/Original can remove the history block they live in: keep focus in Export. */
function afterHistory(run: () => void) {
  const was = document.activeElement as HTMLElement | null;
  run();
  afterRender(() => {
    if (!was?.isConnected) document.getElementById('export-heading')?.focus();
  });
}

function sizeChange(file: FileEntry): string | null {
  if (!file.history.length || file.original.size === file.current.size) return null;
  return `${formatBytes(file.original.size)} → ${formatBytes(file.current.size)}`;
}

export function ControlsExport() {
  const file = useStore((s) => (s.selectedId ? s.files.find((f) => f.id === s.selectedId) : undefined));
  const files = useStore((s) => s.files);
  const busy = files.some((f) => f.status === 'working' || f.status === 'reading');
  const strippable = files.filter((f) => f.meta?.canStrip).map((f) => f.id);
  const working = !!file && isBusy(file);
  const ready = !!file?.meta;
  const change = file ? sizeChange(file) : null;
  // aria-disabled (not disabled) keeps these focusable, so focus can return to them after dialogs.
  return (
    <section className="control-section controls-export export-section" aria-labelledby="export-heading">
      <div className="section-label">
        <h3 id="export-heading" tabIndex={-1}>
          Export
        </h3>
      </div>
      {ready && file!.meta!.canStrip && (
        <button className="btn" type="button" aria-disabled={working} onClick={() => !working && openStrip([file!.id])}>
          Strip all metadata…
        </button>
      )}
      <button className="btn primary" type="button" aria-disabled={!ready || working} onClick={() => ready && !working && void download(file!.id)}>
        {file?.edits.size ? 'Save & download' : 'Download'} <span aria-hidden="true">↓</span>
      </button>
      {files.length > 1 && (
        <>
          <button
            className="btn"
            type="button"
            aria-disabled={!strippable.length || busy}
            onClick={() => strippable.length && !busy && openStrip(strippable)}
          >
            Strip {strippable.length === files.length ? 'all ' : ''}
            {strippable.length} file{strippable.length === 1 ? '' : 's'}…
          </button>
          <button className="btn" type="button" aria-disabled={busy} onClick={() => !busy && void downloadAll()}>
            Download all (.zip)
          </button>
        </>
      )}
      {ready && (
        <button
          className="btn text sm"
          type="button"
          onClick={() => exportReport(file!.id, (f) => valueText(f.kind, f.value, f.display))}
        >
          Metadata report (JSON)
        </button>
      )}
      {file && (file.note || file.history.length > 0) && (
        <div className="history">
          {file.note && (
            <p className="done">
              <Icon name="check" size="sm" /> {file.note}
            </p>
          )}
          {change && <p className="note">{change}</p>}
          <div className="control-row">
            <button className="btn sm" type="button" onClick={() => afterHistory(() => undo(file.id))} disabled={!file.history.length || working}>
              Undo
            </button>
            <button className="btn sm" type="button" onClick={() => afterHistory(() => revert(file.id))} disabled={!file.history.length || working}>
              Original
            </button>
          </div>
        </div>
      )}
      <p className="control-hint">Downloads keep the original file name. Nothing leaves this device.</p>
    </section>
  );
}
