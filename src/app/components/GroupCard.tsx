import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Edit, Edits, Field, FieldGroup, FieldSpec, FieldValue, GpsValue, ImageValue, Sensitivity } from '../../engine/core/types';
import { groupKey } from '../../engine/core/types';
import { describeImage, displayDate, formatGps } from '../../engine/core/fields';
import { copyEditToAll, removeGroup, restoreGroup, setEdit, setGroupAbout, setInvalid, toast, useStore } from '../store';
import { Editor, ImageView, RawView, emptyValue, isEmptyValue } from './editors';
import { afterRender } from './afterRender';
import { Icon } from './Icon';
import { SENS } from './sensitivity';

export function valueText(kind: string, v: FieldValue, display?: string): string {
  if (display) return display;
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') {
    if ('lat' in v) return formatGps(v as GpsValue);
    if ('data' in v) return describeImage(v as ImageValue);
  }
  if (kind === 'datetime' && typeof v === 'string') return displayDate(v);
  return String(v);
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (a && b && typeof a === 'object' && typeof b === 'object' && 'lat' in a && 'lat' in b) {
    return a.lat === b.lat && a.lon === b.lon && (a.alt ?? null) === (b.alt ?? null);
  }
  return false;
}

/**
 * Move focus to the sensible control of a row after React re-renders it:
 * after a removal the "Keep" button (the row's last action), otherwise the
 * field's own input.
 */
function focusRow(row: HTMLElement | null, after: 'remove' | 'restore') {
  afterRender(() => {
    if (!row?.isConnected) return;
    const target =
      after === 'remove'
        ? row.querySelector<HTMLElement>('.row-actions > button:last-of-type')
        : (row.querySelector<HTMLElement>('.row-value input:not([tabindex="-1"]), .row-value textarea, .row-value select') ??
          row.querySelector<HTMLElement>('.row-value button, .row-actions > button'));
    target?.focus();
  });
}

interface RowProps {
  fileId: string;
  field: Field | FieldSpec;
  edit: Edit | undefined;
  added: boolean;
  groupRemoved: boolean;
  readOnly: boolean;
  rev: number;
}

export const FieldRow = memo(function FieldRow({ fileId, field, edit, added, groupRemoved, readOnly, rev }: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const requiredId = useId();
  const existing = added ? null : (field as Field);
  const removed = groupRemoved || edit?.op === 'remove';
  const value: FieldValue = edit?.op === 'set' ? edit.value : (existing?.value ?? null);
  const editable = !readOnly && (added || !!existing?.editable);
  const removable = added || !!existing?.removable;
  const sens = field.sensitivity;
  const multi = useStore((s) => s.files.length > 1);
  const onValidity = useCallback((valid: boolean) => setInvalid(fileId, field.id, !valid), [fileId, field.id]);

  const onChange = (v: FieldValue) => {
    if (existing && sameValue(v, existing.value)) setEdit(fileId, field.id, null);
    else setEdit(fileId, field.id, { op: 'set', value: v });
  };
  const undoEdit = () => {
    setEdit(fileId, field.id, null);
    focusRow(rowRef.current, 'restore');
  };

  let body;
  if (removed) {
    body = (
      <div className="raw" dir="auto">
        {valueText(field.kind, existing?.value ?? null, existing?.display) || '—'}
      </div>
    );
  } else if (editable) {
    body = (
      <Editor
        key={rev}
        spec={field}
        value={value}
        display={existing?.display}
        onChange={onChange}
        onValidity={onValidity}
        allowEmpty={added}
        autoFocus={added && edit?.op === 'set' && isEmptyValue(edit.value)}
      />
    );
  } else if (field.kind === 'image' && existing?.value && typeof existing.value === 'object' && 'data' in existing.value) {
    body = <ImageView value={existing.value as ImageValue} label={field.label} />;
  } else {
    body = <RawView text={valueText(field.kind, existing?.value ?? null, existing?.display)} />;
  }

  const cls = ['row', removed && 'removed', !removed && edit?.op === 'set' && (added ? 'added' : 'edited')].filter(Boolean).join(' ');

  return (
    <div className={cls} ref={rowRef}>
      <div className="row-label">
        <span className="name">
          {sens && (
            <>
              <span className={`sens-mark sens-${SENS[sens].risk}`} aria-hidden="true" title={`${SENS[sens].label}: ${SENS[sens].hint}`} />
              <span className="sr-only">{SENS[sens].label} data: </span>
            </>
          )}
          {field.label}
          {added && <span className="tag ink">New</span>}
          {!added && !removed && edit?.op === 'set' && <span className="tag">Edited</span>}
          {removed && <span className="tag">Removing</span>}
        </span>
        {field.tag && (
          <span className="key" title={field.tag}>
            {field.tag}
          </span>
        )}
      </div>
      <div className="row-value">{body}</div>
      {!readOnly && (
        <div className="row-actions">
          {multi && edit && !groupRemoved && (
            <button
              className="icon-btn"
              type="button"
              aria-label={`Apply this ${field.label} change to all open files`}
              title="Apply this change to all open files that support this field"
              onClick={() => {
                const n = copyEditToAll(fileId, field.id);
                toast(n ? `Applied to ${n} other file${n > 1 ? 's' : ''}` : 'No other open file supports this field', n ? 'success' : 'info');
              }}
            >
              <Icon name="layers" size="sm" />
            </button>
          )}
          {!added && edit?.op === 'set' && (
            <button className="icon-btn" type="button" aria-label={`Revert ${field.label}`} title="Revert to original value" onClick={undoEdit}>
              <Icon name="undo" size="sm" />
            </button>
          )}
          {edit?.op === 'remove' && !groupRemoved ? (
            <button className="icon-btn" type="button" aria-label={`Keep ${field.label}`} title="Keep this field" onClick={undoEdit}>
              <Icon name="undo" size="sm" />
            </button>
          ) : added ? (
            <button
              className="icon-btn"
              type="button"
              aria-label={`Cancel adding ${field.label}`}
              title="Cancel"
              onClick={() => {
                const toggle = rowRef.current?.closest('section.group')?.querySelector<HTMLElement>('.group-toggle');
                setEdit(fileId, field.id, null);
                afterRender(() => toggle?.focus());
              }}
            >
              <Icon name="x" size="sm" />
            </button>
          ) : (
            !groupRemoved && (
              <>
                <button
                  className="icon-btn danger"
                  type="button"
                  aria-label={`Remove ${field.label}`}
                  title={removable ? 'Remove this field' : 'Required by the format'}
                  aria-disabled={!removable}
                  aria-describedby={removable ? undefined : requiredId}
                  onClick={() => {
                    if (!removable) return;
                    setEdit(fileId, field.id, { op: 'remove' });
                    focusRow(rowRef.current, 'remove');
                  }}
                >
                  <Icon name="trash" size="sm" />
                </button>
                {!removable && (
                  <span className="sr-only" id={requiredId}>
                    Required by the format
                  </span>
                )}
              </>
            )
          )}
        </div>
      )}
      {field.description && !removed && <div className="row-desc">{field.description}</div>}
    </div>
  );
});

function AddFieldMenu({ fileId, group, edits }: { fileId: string; group: FieldGroup; edits: Edits }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const specs = group.addable ?? [];
  const available = specs.filter((s) => !edits.has(s.id) || s.kind === 'image' || s.id.endsWith(':new'));
  if (!available.length) return null;
  return (
    <div
      className="menu-wrap"
      ref={ref}
      onBlur={(e) => {
        // Only when focus really moved elsewhere; outside clicks use the mousedown listener.
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
      <button
        ref={trigger}
        className="btn ghost sm"
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Add field to ${group.label}`}
      >
        Add <span aria-hidden="true">＋</span>
      </button>
      {open && (
        <div className="menu" id={menuId} role="group" aria-label={`Fields you can add to ${group.label}`}>
          <p className="menu-title">Add field</p>
          {available.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setEdit(fileId, s.id, { op: 'set', value: emptyValue(s.kind) });
                setOpen(false);
                // the new row's editor autofocuses; if it cannot (collapsed/filtered group), stay on the trigger
                afterRender(() => {
                  if (document.activeElement === document.body || !document.activeElement) trigger.current?.focus();
                });
              }}
            >
              <span>{s.label}</span>
              {s.tag && <span className="hint">{s.tag}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface GroupFilter {
  text: string;
  sensitivity: Sensitivity | null;
}

export function matches(f: Field | FieldSpec, filter: GroupFilter): boolean {
  if (filter.sensitivity && f.sensitivity !== filter.sensitivity) return false;
  const q = filter.text.trim().toLowerCase();
  if (!q) return true;
  const v = 'value' in f ? valueText(f.kind, f.value, f.display) : '';
  return `${f.label} ${f.tag ?? ''} ${v}`.toLowerCase().includes(q);
}

export function GroupCard({
  fileId,
  group,
  edits,
  filter,
  collapsed,
  readOnly,
  rev,
  onToggle,
}: {
  fileId: string;
  group: FieldGroup;
  edits: Edits;
  filter: GroupFilter;
  collapsed: boolean;
  readOnly: boolean;
  rev: number;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const groupRemoved = edits.has(groupKey(group.id));
  const added = (group.addable ?? []).filter((s) => edits.get(s.id)?.op === 'set' && !group.fields.some((f) => f.id === s.id));
  const filtering = !!filter.text.trim() || !!filter.sensitivity;
  const fields = group.fields.filter((f) => matches(f, filter));
  const addedShown = added.filter((f) => matches(f, filter));
  if (filtering && !fields.length && !addedShown.length) return null;

  const removableCount = group.fields.filter((f) => f.removable).length;
  const allRemoved = groupRemoved || (removableCount > 0 && group.fields.every((f) => !f.removable || edits.get(f.id)?.op === 'remove'));
  const isCollapsed = collapsed && !filtering;
  const canAdd = !readOnly && !groupRemoved && !!group.addable?.length;
  const canRemove = !readOnly && group.fields.length > 0 && (removableCount > 0 || !!group.removable);

  return (
    <section className={`group${isCollapsed ? ' collapsed' : ''}${groupRemoved ? ' removed' : ''}`}>
      <div className="group-head">
        <h4 className="group-title">
          <button className="group-toggle" type="button" onClick={onToggle} aria-expanded={!isCollapsed} aria-controls={bodyId}>
            <Icon name="chevron" size="sm" className="chev" />
            <span className="group-label">{group.label}</span>
            {group.source && <span className="tag">{group.source}</span>}
            <span className="group-count">
              {group.fields.length + added.length}
              <span className="sr-only"> fields</span>
            </span>
          </button>
        </h4>
        <button
          className="icon-btn group-about"
          type="button"
          aria-label={`About ${group.label}`}
          title={`What is ${group.label}?`}
          aria-haspopup="dialog"
          onClick={() => setGroupAbout(group)}
        >
          <Icon name="info" size="sm" />
        </button>
        {(canAdd || canRemove) && (
          <div className="group-actions">
            {canAdd && <AddFieldMenu fileId={fileId} group={group} edits={edits} />}
            {canRemove &&
              (allRemoved ? (
                <button className="btn ghost sm" type="button" aria-label={`Keep ${group.label} fields`} onClick={() => restoreGroup(fileId, group)}>
                  Keep
                </button>
              ) : (
                <button
                  className="btn ghost sm danger"
                  type="button"
                  aria-label={`Remove all ${group.label} fields`}
                  onClick={() => removeGroup(fileId, group)}
                >
                  Remove all
                </button>
              ))}
          </div>
        )}
      </div>
      {!isCollapsed && (
        <div className="rows" id={bodyId}>
          {fields.map((f) => (
            <FieldRow key={f.id} fileId={fileId} field={f} edit={edits.get(f.id)} added={false} groupRemoved={groupRemoved} readOnly={readOnly} rev={rev} />
          ))}
          {addedShown.map((s) => (
            <FieldRow key={s.id} fileId={fileId} field={s} edit={edits.get(s.id)} added groupRemoved={false} readOnly={readOnly} rev={rev} />
          ))}
          {!fields.length && !addedShown.length && <p className="group-empty">Nothing here yet — use Add to create a field.</p>}
        </div>
      )}
    </section>
  );
}
