/**
 * The files of a drop, including what is inside dropped folders. A dropped
 * folder arrives as a File that cannot be read; its contents are only reachable
 * through the (webkit-prefixed, but universally supported) File and Directory
 * Entries API.
 */

export interface Dropped {
  files: File[];
  /** files found in folders but left out: not a supported type, or unreadable */
  skipped: number;
  /** the walk stopped at the file limit */
  truncated: boolean;
}

/** Most files one drop opens, so dropping a home folder by mistake stays harmless. */
export const MAX_DROPPED_FILES = 1000;

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((ok, fail) => entry.file(ok, fail));

/** Every entry of a folder (readEntries returns them in batches), sorted by name. */
function children(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const done = () => resolve(all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return done();
        all.push(...batch);
        next();
      }, done);
    next();
  });
}

/**
 * Files dropped directly are all kept (opening one the app cannot read says
 * why). Folders are walked depth-first, leaving out hidden entries and files
 * whose extension is not one of `extensions` (an empty list keeps them all).
 *
 * Call it from the drop event itself: the browser empties the DataTransfer
 * once the handler returns, so the entries are taken before the first await.
 */
export function droppedFiles(dt: DataTransfer, extensions: readonly string[], limit = MAX_DROPPED_FILES): Promise<Dropped> {
  const items = Array.from(dt.items ?? []).filter((item) => item.kind === 'file');
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some((e) => !e)) {
    return Promise.resolve({ files: Array.from(dt.files), skipped: 0, truncated: false });
  }
  return walk(entries as FileSystemEntry[], new Set(extensions), limit);
}

async function walk(top: FileSystemEntry[], extensions: Set<string>, limit: number): Promise<Dropped> {
  const out: Dropped = { files: [], skipped: 0, truncated: false };
  // Entries looked at, so a deep tree of (or a link loop through) empty folders ends too.
  let budget = limit * 10;
  const visit = async (entry: FileSystemEntry, inFolder: boolean): Promise<void> => {
    if (out.truncated) return;
    if (--budget < 0) {
      out.truncated = true;
      return;
    }
    if (inFolder && entry.name.startsWith('.')) return;
    if (entry.isDirectory) {
      for (const child of await children(entry as FileSystemDirectoryEntry)) await visit(child, true);
      return;
    }
    if (inFolder && extensions.size && !extensions.has(extension(entry.name))) {
      out.skipped++;
      return;
    }
    if (out.files.length >= limit) {
      out.truncated = true;
      return;
    }
    try {
      out.files.push(await fileOf(entry as FileSystemFileEntry));
    } catch {
      out.skipped++;
    }
  };
  for (const entry of top) await visit(entry, false);
  return out;
}
