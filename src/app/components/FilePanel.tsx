import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldGroup } from '../../engine/core/types';
import { formatBytes } from '../../engine/core/binary';
import { applyEdits, discardEdits, download, isBusy, removeFile, setFilter, setSensitivityFilter, useStore, type FileEntry } from '../store';
import { GroupCard, matches } from './GroupCard';
import { useObjectUrl } from './editors';
import { usePdfPage } from '../pdfPreview';
import { categoryIcon, firstPicture } from './fileInfo';
import { afterRender } from './afterRender';
import { Icon } from './Icon';
import { PasswordPrompt } from './PasswordPrompt';
import { SENS } from './sensitivity';

function Preview({ file }: { file: FileEntry }) {
  const meta = file.meta!;
  const isPdf = meta.format.id === 'pdf';
  const pdf = usePdfPage(isPdf ? file : null, true);
  const pic = isPdf ? null : firstPicture(meta);
  const picUrl = useObjectUrl(pic?.data, pic?.mime);
  const cat = meta.format.category;
  let inner;
  if (pdf.page) inner = <img className="pdf-page" src={pdf.page.url} width={pdf.page.width} height={pdf.page.height} alt={`First page of ${file.name}`} />;
  else if (cat === 'image' && file.previewUrl) inner = <img src={file.previewUrl} alt="" />;
  else if (cat === 'video' && file.previewUrl)
    inner = <video src={file.previewUrl} controls muted preload="metadata" playsInline aria-label={`Preview of ${file.name}`} />;
  else if (picUrl) inner = <img className="cover" src={picUrl} alt="" />;
  else inner = <Icon name={categoryIcon(meta)} />;
  return (
    <div className={isPdf ? 'preview pdf' : 'preview'} ref={pdf.ref}>
      {inner}
    </div>
  );
}

/** Long groups with nothing personal in them (e.g. Camera Raw settings) start collapsed. */
function collapsedByDefault(g: FieldGroup): boolean {
  return g.fields.length > 20 && !g.fields.some((f) => f.sensitivity && f.sensitivity !== 'software');
}

export function FilePanel({ file }: { file: FileEntry }) {
  const filterText = useStore((s) => s.filter);
  const sensFilter = useStore((s) => s.sensitivityFilter);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [printing, setPrinting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCollapsed({}), [file.id]);

  // Print every group, expanded.
  useEffect(() => {
    const on = () => setPrinting(true);
    const off = () => setPrinting(false);
    window.addEventListener('beforeprint', on);
    window.addEventListener('afterprint', off);
    return () => {
      window.removeEventListener('beforeprint', on);
      window.removeEventListener('afterprint', off);
    };
  }, []);

  // Keep scroll-padding equal to the sticky toolbar's real height, which grows
  // when it wraps, so focused fields are never hidden under it (WCAG 2.4.11).
  useEffect(() => {
    const el = toolbarRef.current;
    const root = document.documentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => root.style.setProperty('--toolbar-h', `${Math.ceil(el.getBoundingClientRect().height) + 12}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--toolbar-h');
    };
  }, [file.id, file.status, file.meta, file.edits.size > 0, file.invalid.length > 0]);

  /** Focus a fallback target when the element that had focus was unmounted. */
  const keepFocus = (preferred?: HTMLElement | null) =>
    afterRender(() => {
      const target = preferred?.isConnected ? preferred : searchRef.current?.isConnected ? searchRef.current : titleRef.current;
      target?.focus();
    });

  const save = async () => {
    const ok = await applyEdits(file.id);
    if (ok) keepFocus(searchRef.current);
    else document.querySelector<HTMLElement>('.editor [aria-invalid="true"]')?.focus();
  };

  // Cmd/Ctrl+S saves pending edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (file.edits.size) void applyEdits(file.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file.id, file.edits.size]);

  const groups = useMemo(() => file.meta?.groups ?? [], [file.meta]);

  if (file.status === 'reading' && !file.meta) {
    return (
      <div className="state-box" aria-busy="true">
        <span className="spinner" role="img" aria-label="Reading" />
        <p>Reading “{file.name}”…</p>
      </div>
    );
  }

  if (file.status === 'error' && (file.errorCode === 'password-required' || file.errorCode === 'wrong-password')) {
    return <PasswordPrompt key={file.id} file={file} />;
  }

  if (file.status === 'error' || !file.meta) {
    return (
      <div className="state-box">
        <h3>Can’t read this file</h3>
        <p>
          <b>{file.name}</b> — {file.error ?? 'Unknown error'}
        </p>
        <button className="btn" type="button" onClick={() => removeFile(file.id)}>
          Remove from list
        </button>
      </div>
    );
  }

  const meta = file.meta;
  const readOnly = !meta.canWrite;
  const pending = file.edits.size;
  const invalid = file.invalid.length;
  const working = isBusy(file);
  const audioSrc = meta.format.category === 'audio' ? file.previewUrl : undefined;
  const filter = { text: filterText, sensitivity: sensFilter };
  const filtering = !!filterText.trim() || !!sensFilter;
  const visibleGroups = groups.filter((g) => g.fields.length || (!readOnly && g.addable?.length));
  const hasFields = groups.some((g) => g.fields.length);
  const shown = (g: FieldGroup) =>
    g.fields.some((f) => matches(f, filter)) ||
    (g.addable ?? []).some((a) => file.edits.get(a.id)?.op === 'set' && !g.fields.some((f) => f.id === a.id) && matches(a, filter));
  const noMatches = filtering && (hasFields || pending > 0) && !groups.some(shown);

  return (
    <>
      <div className="file-head">
        <Preview file={file} />
        <div className="file-title">
          <h3 dir="auto" ref={titleRef} tabIndex={-1}>
            {file.name}
          </h3>
          <div className="sub">
            <span>{meta.format.name}</span>
            <span>{formatBytes(file.current.size)}</span>
            {readOnly && <span className="tag">Read-only format</span>}
          </div>
          {meta.info.length > 0 && (
            <div className="facts">
              {meta.info.map((i) => (
                <span className="fact" key={i.label} title={`${i.label}: ${i.value}`}>
                  <b>{i.label}</b>
                  <span>{i.value}</span>
                </span>
              ))}
            </div>
          )}
          {audioSrc && <audio className="preview-audio" src={audioSrc} controls preload="metadata" aria-label={`Play ${file.name}`} />}
        </div>
      </div>

      {(hasFields || pending > 0 || invalid > 0) && (
        <div className="editor-toolbar" ref={toolbarRef}>
          <div className="search">
            <Icon name="search" size="sm" />
            <input
              ref={searchRef}
              type="search"
              placeholder="Filter fields"
              value={filterText}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
              aria-label="Filter fields"
            />
            {filterText && (
              <button
                className="search-clear"
                type="button"
                aria-label="Clear filter"
                onClick={() => {
                  setFilter('');
                  searchRef.current?.focus();
                }}
              >
                <Icon name="x" size="sm" />
              </button>
            )}
          </div>
          {sensFilter && (
            <button
              className="filter-chip"
              type="button"
              onClick={() => setSensitivityFilter(sensFilter)}
              aria-label={`Show all fields, not only ${SENS[sensFilter].label.toLowerCase()}`}
            >
              {SENS[sensFilter].label} <Icon name="x" size="sm" />
            </button>
          )}
          {pending > 0 || invalid > 0 ? (
            <div className="toolbar-actions">
              <span className="pending-count" role="status">
                {invalid ? `${invalid} invalid · ` : ''}
                {pending} unsaved
              </span>
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  if (working) return;
                  discardEdits(file.id);
                  keepFocus(searchRef.current);
                }}
                aria-disabled={working}
              >
                Discard
              </button>
              {pending > 0 && (
                <button className="btn primary" type="button" onClick={() => !working && void save()} aria-disabled={working} title="Save changes (⌘S)">
                  {working && <span className="spinner sm" aria-hidden="true" />} Save
                </button>
              )}
            </div>
          ) : (
            // Below 1024px the Export panel sits after all fields; keep Download one tap away.
            <div className="toolbar-actions toolbar-download">
              <button className="btn" type="button" aria-disabled={working} onClick={() => !working && void download(file.id)}>
                Download <span aria-hidden="true">↓</span>
              </button>
            </div>
          )}
        </div>
      )}

      {meta.warnings.length > 0 && (
        <div className="notice" role="note">
          <p>Heads-up</p>
          <ul>
            {meta.warnings.slice(0, 6).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {!hasFields && !pending && (
        <div className="empty-groups">
          <h3>No metadata</h3>
          <p>
            This file carries no {readOnly ? '' : 'editable '}metadata.{readOnly ? '' : ' You can still add fields below.'}
          </p>
        </div>
      )}

      {noMatches && (
        <div className="empty-groups">
          <h3>No matching fields</h3>
          <p>Nothing in this file matches the current filter.</p>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setFilter('');
              if (sensFilter) setSensitivityFilter(sensFilter);
              searchRef.current?.focus();
            }}
          >
            Clear filter
          </button>
        </div>
      )}

      <div className="groups">
        {visibleGroups.map((g) => (
          <GroupCard
            key={g.id}
            fileId={file.id}
            group={g}
            edits={file.edits}
            filter={filter}
            readOnly={readOnly}
            rev={file.rev}
            collapsed={!printing && (collapsed[g.id] ?? collapsedByDefault(g))}
            onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !(c[g.id] ?? collapsedByDefault(g)) }))}
          />
        ))}
      </div>
    </>
  );
}
