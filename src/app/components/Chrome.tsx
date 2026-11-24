/** Page frame in the Bluethroat Labs layout: topbar, product bar, footer, dialogs, toasts. */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import wordmarkUrl from '../assets/bluethroat-wordmark.svg';
import oflText from '../assets/fonts/OFL.txt?raw';
import {
  addDropped,
  addFiles,
  clearAll,
  closeStrip,
  dismissToast,
  fileById,
  hasUnsavedWork,
  holdToast,
  loadSample,
  pickFiles,
  setAbout,
  setConfirmClose,
  setGroupAbout,
  setLicences,
  setOffline,
  setStripOptions,
  stripFiles,
  useStore,
  type Toast,
} from '../store';
import { afterRender } from './afterRender';
import { aboutGroup } from './groupAbout';
import { Icon, Mark } from './Icon';
import { SENS, SENS_ORDER } from './sensitivity';

const LABS_URL = 'https://bluethroatlabs.com/';
// The hosted site is the single-file build and serves the same page as
// ./blueexif.html for download (infra/deploy.sh). The downloaded copy (file://)
// says so instead of offering itself again; the multi-file build ships no such
// file, so it offers nothing.
const SINGLE_FILE = import.meta.env.MODE === 'single';
const IS_OFFLINE_COPY = SINGLE_FILE && location.protocol === 'file:';
const OFFLINE_EDITION = SINGLE_FILE && !IS_OFFLINE_COPY;
const OFFLINE_FILE = 'blueexif.html';

// ------------------------------------------------------------------ theme

type Theme = 'light' | 'dark';

const lightQuery = () => window.matchMedia?.('(prefers-color-scheme: light)');

function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return lightQuery()?.matches ? 'light' : 'dark';
}

/** Follows the OS appearance until the user picks one; the choice is remembered. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const mq = lightQuery();
    const onChange = () => setTheme(currentTheme());
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#fafafa' : '#0a0a0a');
  }, [theme]);
  const toggle = () => {
    const next: Theme = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('blueexif.theme', next);
    } catch {
      /* storage unavailable */
    }
    setTheme(next);
  };
  return [theme, toggle];
}

// -------------------------------------------------------------- top & foot

export function Topbar() {
  const [theme, toggle] = useTheme();
  const label = theme === 'light' ? 'Switch to dark appearance' : 'Switch to light appearance';
  return (
    <header className="topbar">
      <a className="brand" href={LABS_URL} target="_blank" rel="noopener noreferrer" aria-label="Bluethroat Labs website (opens in a new tab)">
        <img className="wordmark" src={wordmarkUrl} width={198} height={32} alt="" />
      </a>
      <div className="top-actions">
        <button type="button" onClick={() => setAbout(true)}>
          How it works
        </button>
        {SINGLE_FILE && (
          <button type="button" onClick={() => setOffline(true)} aria-haspopup="dialog">
            {IS_OFFLINE_COPY ? 'Offline edition ✓' : 'Offline edition'}
          </button>
        )}
        <button className="theme-toggle" type="button" onClick={toggle} aria-label={label} title={label}>
          <Icon name={theme === 'light' ? 'moon' : 'sun'} />
        </button>
      </div>
    </header>
  );
}

export function Productbar() {
  return (
    <div className="productbar">
      <div className="productbar-inner">
        <div className="productbar-lockup">
          <span className="productbar-mark full" aria-hidden="true">
            <Mark size={88} />
          </span>
          <span className="productbar-mark small" aria-hidden="true">
            <Mark size={56} small />
          </span>
          <h1 className="productbar-name">BlueExif</h1>
        </div>
        <div className="productbar-copy">
          <p>
            BlueExif is a local metadata editor. See, edit and remove the hidden data in photos, music, videos and documents — GPS location, camera serials,
            author names, edit history — before you share them.
          </p>
        </div>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="page-footer">
      <div className="footer-brand">
        <span>A local-first tool by</span>
        <a href={LABS_URL} target="_blank" rel="noopener noreferrer" aria-label="Bluethroat Labs (opens in a new tab)">
          <img className="wordmark" src={wordmarkUrl} width={124} height={20} alt="" />
        </a>
      </div>
      <nav className="footer-links" aria-label="About BlueExif and related tools">
        <button type="button" onClick={() => setAbout(true)}>
          How it works
        </button>
        <button type="button" onClick={() => setLicences(true)}>
          Font licences
        </button>
        {OFFLINE_EDITION && (
          <a href={`./${OFFLINE_FILE}`} download={OFFLINE_FILE}>
            Offline edition ↓
          </a>
        )}
        {IS_OFFLINE_COPY && <span className="footer-note">You are using the offline edition</span>}
        <a href="https://bluemask.bluethroatlabs.com/" target="_blank" rel="noopener noreferrer">
          BlueMask
        </a>
        <a href="https://blueskills.bluethroatlabs.com/" target="_blank" rel="noopener noreferrer">
          BlueSkills
        </a>
      </nav>
    </footer>
  );
}

// ------------------------------------------------------------- empty state

const STEPS: Array<[string, string]> = [
  ['Drop', 'files or folders here, or paste an image. Nothing is uploaded.'],
  ['Review', 'what each file reveals — location, people, devices, dates.'],
  ['Edit or strip', 'fields, then download the clean copy.'],
];

const CATEGORY_LABEL: Record<string, string> = { image: 'Images', audio: 'Audio', video: 'Video', document: 'Documents' };

export function EmptyWorkspace() {
  const formats = useStore((s) => s.formats);
  const formatsError = useStore((s) => s.formatsError);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const isFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const byCat = (cat: string) => [...new Set(formats.filter((f) => f.category === cat).flatMap((f) => f.extensions))];
  const extCount = new Set(formats.flatMap((f) => f.extensions)).size;
  const loading = !formats.length && !formatsError;
  return (
    <div className="workspace empty">
      <div className="editor">
        <div className="stage">
          <div
            className={`dropzone${over ? ' dragover' : ''}`}
            onDragEnter={(e) => {
              if (isFiles(e) && ++depth.current === 1) setOver(true);
            }}
            onDragLeave={(e) => {
              if (isFiles(e) && --depth.current <= 0) {
                depth.current = 0;
                setOver(false);
              }
            }}
            onDrop={() => {
              depth.current = 0;
              setOver(false);
            }}
          >
            <span className="drop-mark" aria-hidden="true">
              ＋
            </span>
            <h2>Drop files here</h2>
            <button className="btn primary" type="button" onClick={pickFiles} data-empty-focus>
              Choose files
            </button>
            <p className="note">Images, audio, video and documents · Paste with ⌘V / Ctrl+V</p>
            <button className="btn text sm" type="button" onClick={() => void loadSample()}>
              Try a sample photo
            </button>
          </div>
        </div>
      </div>
      <aside className="controls" aria-label="About BlueExif">
        <section className="control-section" aria-labelledby="finds-heading">
          <div className="section-label">
            <h3 id="finds-heading">What it finds</h3>
          </div>
          <ul className="find-list">
            {SENS_ORDER.map((s) => (
              <li key={s}>
                <Icon name={SENS[s].icon} size="sm" />
                <b>{SENS[s].label}</b>
                <span>{SENS[s].hint}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="control-section" aria-labelledby="formats-heading">
          <div className="section-label">
            <h3 id="formats-heading">Formats</h3>
            {extCount > 0 && <span>{extCount} file types</span>}
          </div>
          {formatsError ? (
            <p className="control-hint">Couldn’t load the format list. Reload the page to try again.</p>
          ) : (
            <ul className="format-list" aria-busy={loading}>
              {Object.keys(CATEGORY_LABEL)
                .filter((cat) => loading || byCat(cat).length)
                .map((cat) => (
                  <li key={cat}>
                    <b>{CATEGORY_LABEL[cat]}</b>
                    <div className="exts">
                      {loading ? (
                        <span className="tag">…</span>
                      ) : (
                        byCat(cat).map((e) => (
                          <span className="tag" key={e}>
                            {e.toUpperCase()}
                          </span>
                        ))
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </section>
        <section className="control-section" aria-labelledby="how-heading">
          <div className="section-label">
            <h3 id="how-heading">How it works</h3>
          </div>
          <ol className="workflow-list">
            {STEPS.map(([b, t]) => (
              <li key={b}>
                <b>{b}</b> {t}
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------ drop & paste

export function DropOverlay() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setActive(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setActive(false);
      if (e.dataTransfer) void addDropped(e.dataTransfer);
    };
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void addFiles(
        files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${i + 1}.${f.type.split('/')[1] || 'bin'}`, { type: f.type }))),
      );
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, []);
  if (!active) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div>
        <strong>Drop to inspect</strong>
        <span>Files are read locally — nothing is uploaded</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

/**
 * Native <dialog> wrapper: modal focus trap, Esc, backdrop click (only when
 * the press also started on the backdrop) and focus on [data-autofocus].
 */
function Dialog({
  open,
  onClose,
  title,
  labelId,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  labelId: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={labelId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      {open && (
        <>
          <div className="dialog-head">
            <h2 id={labelId}>{title}</h2>
            <button className="icon-btn" type="button" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {actions && <div className="dialog-actions">{actions}</div>}
        </>
      )}
    </dialog>
  );
}

export function StripDialog() {
  const req = useStore((s) => s.strip);
  const opts = useStore((s) => s.stripOptions);
  const files = useStore((s) => s.files);
  const targets = (req?.ids ?? []).map((id) => fileById(id)).filter(Boolean);
  const cats = new Set(files.filter((f) => req?.ids.includes(f.id)).map((f) => f.meta?.format.category));
  const single = targets.length === 1 ? targets[0]!.name : null;
  const pendingEdits = targets.some((f) => f!.edits.size);
  return (
    <Dialog
      open={!!req}
      onClose={closeStrip}
      labelId="strip-title"
      title={single ? 'Remove all metadata' : `Remove metadata from ${targets.length} files`}
      actions={
        <>
          <button className="btn primary" type="button" data-autofocus onClick={() => req && void stripFiles(req.ids)}>
            Remove metadata
          </button>
          <button className="btn secondary" type="button" onClick={closeStrip}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        {single && (
          <>
            <strong>{single}</strong> —{' '}
          </>
        )}
        EXIF, GPS, XMP, IPTC, tags, comments, thumbnails and edit history are removed. Image, audio and video data are copied as-is, never re-encoded. You can
        undo afterwards.
      </p>
      {(cats.has('image') || !cats.size) && (
        <label className="option">
          <input type="checkbox" checked={opts.keepOrientation} onChange={(e) => setStripOptions({ ...opts, keepOrientation: e.target.checked })} />
          <div>
            <b>Keep orientation</b>
            <span>Prevents rotated photos from appearing sideways. Reveals nothing personal.</span>
          </div>
        </label>
      )}
      {(cats.has('image') || cats.has('video') || !cats.size) && (
        <label className="option">
          <input type="checkbox" checked={opts.keepColorProfile} onChange={(e) => setStripOptions({ ...opts, keepColorProfile: e.target.checked })} />
          <div>
            <b>Keep color profile</b>
            <span>Keeps colors accurate. Profiles can hint at the camera or editing software.</span>
          </div>
        </label>
      )}
      {(cats.has('audio') || cats.has('video')) && (
        <label className="option">
          <input type="checkbox" checked={opts.keepCoverArt} onChange={(e) => setStripOptions({ ...opts, keepCoverArt: e.target.checked })} />
          <div>
            <b>Keep cover art</b>
            <span>Keeps embedded album or video artwork.</span>
          </div>
        </label>
      )}
      {pendingEdits && <p className="dialog-warning">Unsaved edits will be discarded.</p>}
    </Dialog>
  );
}

export function ConfirmCloseDialog() {
  const open = useStore((s) => s.confirmClose);
  const count = useStore((s) => s.files.length);
  const changed = useStore((s) => s.files.filter(hasUnsavedWork).length);
  return (
    <Dialog
      open={open}
      onClose={() => setConfirmClose(false)}
      labelId="close-title"
      title="Close all files?"
      actions={
        <>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              setConfirmClose(false);
              clearAll();
              // the trigger is gone with the file list: land on the empty state
              afterRender(() => document.querySelector<HTMLElement>('[data-empty-focus]')?.focus());
            }}
          >
            Close all
          </button>
          <button className="btn secondary" type="button" data-autofocus onClick={() => setConfirmClose(false)}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        {count} file{count === 1 ? '' : 's'} will be removed from this page.
        {changed ? ` ${changed} ha${changed === 1 ? 's' : 've'} changes that were not downloaded.` : ''} Your original files on disk are not affected.
      </p>
    </Dialog>
  );
}

export function AboutDialog() {
  const open = useStore((s) => s.about);
  return (
    <Dialog
      open={open}
      onClose={() => setAbout(false)}
      labelId="about-title"
      title="How BlueExif works"
      actions={
        <button className="btn primary" type="button" data-autofocus onClick={() => setAbout(false)}>
          Got it
        </button>
      }
    >
      <p>
        <strong>Everything stays on this device.</strong> Files are read and rewritten by a metadata engine running in your browser. The page’s security policy
        blocks connections to other servers, and the app keeps working offline once loaded.
      </p>
      <p>
        <strong>Nothing is re-encoded.</strong> BlueExif rebuilds the file’s containers — EXIF, XMP, IPTC, ID3, Vorbis comments, QuickTime atoms, PDF and Office
        properties — and copies pixels, audio and video byte-for-byte.
      </p>
      <p>
        <strong>Old data really goes away.</strong> Writers rebuild files instead of appending, so earlier revisions (such as incremental PDF updates) do not
        linger. Review the result after saving: BlueExif re-reads the new file and shows exactly what remains.
      </p>
    </Dialog>
  );
}

/** The browser's own guess; it cannot see a captive portal or a firewall. */
function useOnline(active: boolean): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    if (!active) return;
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [active]);
  return online;
}

export function OfflineDialog() {
  const open = useStore((s) => s.offline);
  const hasFiles = useStore((s) => s.files.length > 0);
  const online = useOnline(open);
  const close = () => setOffline(false);
  const connection = (
    <p className="connection-hint" role="status">
      <span className={`connection-dot${online ? ' on' : ''}`} aria-hidden="true" />
      {online
        ? 'Your browser reports a network connection. This is only a hint — check your device’s own controls.'
        : 'Your browser reports no network connection. This is only a hint — check your device’s own controls.'}
    </p>
  );

  if (IS_OFFLINE_COPY) {
    return (
      <Dialog
        open={open}
        onClose={close}
        labelId="offline-title"
        title="You’re using the offline edition"
        actions={
          <button className="btn primary" type="button" data-autofocus onClick={close}>
            Got it
          </button>
        }
      >
        <p>
          This copy of BlueExif runs entirely from the HTML file on your device: the app, the metadata engine and the PDF viewer are all inside it, and its
          security policy forbids every network connection.
        </p>
        <p>Disconnect before opening private files if you want to be certain nothing can leave this device.</p>
        {connection}
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      labelId="offline-title"
      title="Use BlueExif offline"
      actions={
        <>
          <button className="btn" type="button" onClick={close}>
            Continue on this page
          </button>
          <a className="btn primary" href={`./${OFFLINE_FILE}`} download={OFFLINE_FILE} data-autofocus onClick={close}>
            <Icon name="download" size="sm" />
            Download offline edition
          </a>
        </>
      }
    >
      <p>
        <strong>How do you know BlueExif isn’t uploading your files?</strong> Check for yourself: use it with your device disconnected. With no network
        connection, the page has nowhere to send your files.
      </p>
      <ol className="step-list">
        <li>
          <strong>Download the offline edition.</strong> Everything — the app, the metadata engine and the PDF viewer — is in one HTML file.
        </li>
        <li>
          <strong>Disconnect before opening your files.</strong> Turn off Wi-Fi and mobile data; unplug Ethernet.
        </li>
        <li>
          <strong>Open the HTML file in your browser.</strong> Drop in your files, clean them and save the results. Close it before reconnecting.
        </li>
      </ol>
      {connection}
      {hasFiles && <p className="dialog-warning">Files already open on this page stay here; reopen them in the offline edition.</p>}
      <p className="control-hint">Working offline shows that no server is needed. It does not vouch for the code or for your device.</p>
    </Dialog>
  );
}

export function GroupAboutDialog() {
  const group = useStore((s) => s.groupAbout);
  // keep the last group while the dialog closes so its content does not flash empty
  const last = useRef(group);
  if (group) last.current = group;
  const g = group ?? last.current;
  const about = g ? aboutGroup(g) : null;
  const close = () => setGroupAbout(null);
  return (
    <Dialog
      open={!!group}
      onClose={close}
      labelId="group-about-title"
      title={g ? `About ${g.label}` : 'About this section'}
      actions={
        <button className="btn primary" type="button" data-autofocus onClick={close}>
          Got it
        </button>
      }
    >
      {about && g && (
        <>
          <h3 className="about-kicker">What’s in this section</h3>
          <p>{about.what}</p>
          {about.tip && (
            <p className="about-tip">
              <Icon name="info" size="sm" />
              <span>{about.tip}</span>
            </p>
          )}
          {about.standard && about.standard.name !== g.label && (
            <>
              <h3 className="about-kicker">What is {about.standard.name}?</h3>
              <p>{about.standard.text}</p>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

export function LicencesDialog() {
  const open = useStore((s) => s.licences);
  return (
    <Dialog
      open={open}
      onClose={() => setLicences(false)}
      labelId="licences-title"
      title="Font licences"
      actions={
        <button className="btn primary" type="button" data-autofocus onClick={() => setLicences(false)}>
          Close
        </button>
      }
    >
      <pre className="licence-text">{oflText}</pre>
    </Dialog>
  );
}

// ------------------------------------------------------------------ toasts

function ToastItem({ t }: { t: Toast }) {
  // Where keyboard focus came from, so dismissing does not drop it to <body>.
  const returnTo = useRef<HTMLElement | null>(null);
  return (
    <div
      className={`toast ${t.kind}`}
      onMouseEnter={() => holdToast(t.id, 'hover', true)}
      onMouseLeave={() => holdToast(t.id, 'hover', false)}
      onFocus={(e) => {
        if (!returnTo.current && e.relatedTarget instanceof HTMLElement) returnTo.current = e.relatedTarget;
        holdToast(t.id, 'focus', true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) holdToast(t.id, 'focus', false);
      }}
    >
      {t.kind !== 'info' && <Icon name={t.kind === 'error' ? 'alert' : 'check'} size="sm" />}
      <p>
        {t.kind === 'error' && <span className="sr-only">Error: </span>}
        {t.text}
      </p>
      <button
        className="icon-btn"
        type="button"
        aria-label="Dismiss notification"
        onClick={() => {
          const back = returnTo.current?.isConnected ? returnTo.current : document.getElementById('content');
          dismissToast(t.id);
          back?.focus();
        }}
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      <div role="alert" aria-atomic="false" aria-relevant="additions">
        {toasts
          .filter((t) => t.kind === 'error')
          .map((t) => (
            <ToastItem key={t.id} t={t} />
          ))}
      </div>
      <div role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions">
        {toasts
          .filter((t) => t.kind !== 'error')
          .map((t) => (
            <ToastItem key={t.id} t={t} />
          ))}
      </div>
    </div>
  );
}
