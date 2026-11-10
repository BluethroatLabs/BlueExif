import { useEffect } from 'react';
import { getState, hasUnsavedWork, loadFormats, pickFiles, useStore } from './store';
import {
  AboutDialog,
  ConfirmCloseDialog,
  DropOverlay,
  EmptyWorkspace,
  Footer,
  GroupAboutDialog,
  LicencesDialog,
  Productbar,
  StripDialog,
  Toasts,
  Topbar,
} from './components/Chrome';
import { ControlsExport, ControlsTop } from './components/Controls';
import { FilePanel } from './components/FilePanel';
import { Icon } from './components/Icon';

/** DOM order = phone order (files, reveals, fields, export); grid areas lay out wide screens. */
function Workspace() {
  const file = useStore((s) => (s.selectedId ? s.files.find((f) => f.id === s.selectedId) : undefined));
  return (
    <div className="workspace with-files">
      <ControlsTop />
      <div className="editor">{file ? <FilePanel key={file.id} file={file} /> : null}</div>
      <ControlsExport />
    </div>
  );
}

export function App() {
  const hasFiles = useStore((s) => s.files.length > 0);

  useEffect(() => {
    void loadFormats();
    // Work only exists in memory: warn before the tab is closed with changes that were never downloaded.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (getState().files.some(hasUnsavedWork)) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div className="shell">
        <Topbar />
        <Productbar />
        <main id="content" tabIndex={-1}>
          <section className="editor-panel" aria-labelledby="editor-heading">
            <div className="privacy-bar">
              <h2 id="editor-heading">{hasFiles ? 'Edit metadata' : 'Inspect a file'}</h2>
              <div>
                <span>
                  <Icon name="lock" size="sm" /> Local processing · No uploads
                </span>
                <button type="button" onClick={pickFiles}>
                  Add files <span aria-hidden="true">＋</span>
                </button>
              </div>
            </div>
            {hasFiles ? <Workspace /> : <EmptyWorkspace />}
          </section>
        </main>
        <Footer />
      </div>
      <DropOverlay />
      <StripDialog />
      <ConfirmCloseDialog />
      <AboutDialog />
      <GroupAboutDialog />
      <LicencesDialog />
      <Toasts />
    </>
  );
}
