/**
 * A DataTransfer for drop tests, built from a tree: a string is a file's
 * contents (UNREADABLE makes reading it fail), an object is a folder. Folders
 * list their entries two at a time, as browsers do in larger batches.
 */

export const UNREADABLE = Symbol('unreadable');
export type Tree = { [name: string]: string | typeof UNREADABLE | Tree };

export interface FakeDrop {
  dt: DataTransfer;
  /** The drop event is over: the browser no longer hands out entries. */
  end(): void;
}

export function folderEntry(name: string, tree: Tree): FileSystemDirectoryEntry {
  const dir = {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      const all = Object.entries(tree).map(([n, node]) => toEntry(n, node));
      let at = 0;
      return {
        readEntries: (ok: (batch: FileSystemEntry[]) => void) => {
          const batch = all.slice(at, at + 2);
          at += batch.length;
          setTimeout(() => ok(batch));
        },
      };
    },
  };
  return dir as unknown as FileSystemDirectoryEntry;
}

function toEntry(name: string, node: Tree[string]): FileSystemEntry {
  if (typeof node === 'object') return folderEntry(name, node);
  const file = {
    name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void, fail: (e: Error) => void) =>
      setTimeout(() => (node === UNREADABLE ? fail(new Error('NotFoundError')) : ok(new File([node], name)))),
  };
  return file as unknown as FileSystemEntry;
}

/** A drop of the top-level entries of `tree`. Without `entries`, the browser lacks webkitGetAsEntry. */
export function fakeDrop(tree: Tree, { entries = true } = {}): FakeDrop {
  let live = true;
  const top = Object.entries(tree).map(([n, node]) => toEntry(n, node));
  const items = top.map((e) => ({
    kind: 'file',
    ...(entries ? { webkitGetAsEntry: () => (live ? e : null) } : {}),
  }));
  // Like a real drop: a folder appears in `files` as an unreadable, empty File.
  const files = Object.entries(tree).map(([n, node]) => new File(typeof node === 'string' ? [node] : [], n));
  const dt = { items: [{ kind: 'string' }, ...items], files, types: ['Files'] };
  return {
    dt: dt as unknown as DataTransfer,
    end: () => {
      live = false;
    },
  };
}
