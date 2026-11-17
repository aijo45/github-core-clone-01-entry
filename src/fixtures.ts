import { FORGE_IDENT, type GitObject, type Repo, type Sha1 } from './model.ts';
import { sha1Object, type ForgeStore } from './store.ts';

/**
 * fixtures.ts — git object builders used by contents PUT and PR squash merge.
 * Every builder stores its objects in the store via store.putObject and returns
 * the resulting oid(s). All output is deterministic (no wall clock, no randomness).
 *
 * Signatures (DESIGN.md gives no signatures for this module, so these are the
 * contract the other modules should import):
 *   buildCommit(store, repo, { tree, parents, message, author?, committer? }): Sha1
 *   buildTreeFromFiles(store, repo, files: Map<string, Buffer>): { rootOid, objects }
 *   buildFileCommit(store, repo, { baseTree, path, content, message, parents }): { commitOid, treeOid, blobOid }
 */

export interface BuildCommitOptions {
  tree: Sha1;
  parents: Sha1[];
  message: string;
  author?: string;
  committer?: string;
}

/** Build one commit object (author/committer default to the forge ident) and store it. */
export function buildCommit(store: ForgeStore, repo: Repo, opts: BuildCommitOptions): Sha1 {
  const author = opts.author ?? FORGE_IDENT;
  const committer = opts.committer ?? FORGE_IDENT;
  let out = `tree ${opts.tree}\n`;
  for (const p of opts.parents) out += `parent ${p}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${opts.message}`;
  return store.putObject(repo, { type: 'commit', raw: Buffer.from(out, 'utf8') });
}

/** Parse a raw tree object into entries; tree modes are normalised to "040000". */
function parseTreeEntries(raw: Buffer): Array<{ mode: string; name: string; oid: Sha1 }> {
  const entries: Array<{ mode: string; name: string; oid: Sha1 }> = [];
  let i = 0;
  while (i < raw.length) {
    const space = raw.indexOf(0x20, i);
    if (space === -1) break;
    const nul = raw.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > raw.length) break;
    let mode = raw.subarray(i, space).toString('ascii');
    if (mode === '40000') mode = '040000';
    entries.push({ mode, name: raw.subarray(space + 1, nul).toString('utf8'), oid: raw.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return entries;
}

/** Flatten a stored tree to path -> blob bytes (recursive). */
export function flattenTreeToFiles(repo: Repo, treeOid: Sha1, prefix: string, out: Map<string, Buffer>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTreeEntries(obj.raw)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '040000') {
      flattenTreeToFiles(repo, entry.oid, path, out);
    } else {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined) out.set(path, blob.raw);
    }
  }
}

interface DirNode {
  files: Map<string, Buffer>;
  dirs: Map<string, DirNode>;
}

function newDir(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

/** Git tree sort: directory names compare as if they had a trailing '/'. */
function treeSortKey(name: string, isDir: boolean): string {
  return isDir ? `${name}/` : name;
}

/**
 * Build blobs + nested trees bottom-up from a path -> content map and store them.
 * Tree entries are sorted by name. Returns the root tree oid and every object
 * created (deduplicated by oid, in creation order: blobs/trees bottom-up).
 */
export function buildTreeFromFiles(store: ForgeStore, repo: Repo, files: Map<string, Buffer>): { rootOid: Sha1; objects: GitObject[] } {
  const root = newDir();
  for (const [path, content] of files) {
    const parts = path.split('/').filter((p) => p !== '');
    if (parts.length === 0) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = newDir();
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], content);
  }

  const created: GitObject[] = [];
  const seen = new Set<Sha1>();

  function record(obj: GitObject, oid: Sha1): void {
    if (!seen.has(oid)) {
      seen.add(oid);
      created.push(obj);
    }
  }

  function buildDir(node: DirNode): Sha1 {
    type Entry = { name: string; isDir: boolean; oid: Sha1 };
    const entries: Entry[] = [];
    for (const [name, content] of node.files) {
      const blob: GitObject = { type: 'blob', raw: content };
      const oid = store.putObject(repo, blob);
      record(blob, oid);
      entries.push({ name, isDir: false, oid });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ name, isDir: true, oid: buildDir(child) });
    }
    entries.sort((a, b) => {
      const ka = treeSortKey(a.name, a.isDir);
      const kb = treeSortKey(b.name, b.isDir);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      const mode = entry.isDir ? '40000' : '100644';
      chunks.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
      chunks.push(Buffer.from(entry.oid, 'hex'));
    }
    const tree: GitObject = { type: 'tree', raw: Buffer.concat(chunks) };
    const oid = store.putObject(repo, tree);
    record(tree, oid);
    return oid;
  }

  const rootOid = buildDir(root);
  return { rootOid, objects: created };
}

export interface BuildFileCommitOptions {
  /** Tree to start from, or null for an empty tree. */
  baseTree: Sha1 | null;
  /** Repository-relative file path, e.g. "src/foo.txt". */
  path: string;
  /** New file content, or null to delete the file. */
  content: Buffer | null;
  message: string;
  parents: Sha1[];
}

/**
 * Create blob + tree + commit for a single file path update against a base tree.
 * `content: null` deletes the path instead of writing it (blobOid is then null).
 * Returns the new commit oid, the new root tree oid, and the new blob oid.
 */
export function buildFileCommit(
  store: ForgeStore,
  repo: Repo,
  opts: BuildFileCommitOptions,
): { commitOid: Sha1; treeOid: Sha1; blobOid: Sha1 | null } {
  const files = new Map<string, Buffer>();
  if (opts.baseTree !== null) flattenTreeToFiles(repo, opts.baseTree, '', files);
  let blobOid: Sha1 | null = null;
  if (opts.content === null) {
    files.delete(opts.path);
  } else {
    files.set(opts.path, opts.content);
    blobOid = sha1Object('blob', opts.content);
  }
  const { rootOid } = buildTreeFromFiles(store, repo, files);
  const commitOid = buildCommit(store, repo, { tree: rootOid, parents: opts.parents, message: opts.message });
  return { commitOid, treeOid: rootOid, blobOid };
}
