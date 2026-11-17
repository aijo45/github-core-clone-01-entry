// Git object model: SHA-1 ids, commit/tree encode/decode, tree flattening and
// bottom-up tree construction (DESIGN.md §4, objects.ts). SHA-1 via node:crypto.
// All byte layouts follow git exactly so ids recompute identically on the client.

import { createHash } from 'node:crypto';
import type { CommitData, GitObject, Repo, Sha1, TreeEntry } from '../model.ts';

const HEX40 = /^[0-9a-f]{40}$/;

/** sha1("<type> <len>\0" + raw). */
export function sha1Object(type: string, raw: Buffer): Sha1 {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${raw.length}\0`, 'utf8'));
  hash.update(raw);
  return hash.digest('hex');
}

/** True for a lowercase 40-hex object id. */
export function isSha1(value: string): boolean {
  return HEX40.test(value);
}

/**
 * Commit bytes: `tree`, zero or more `parent`, `author`, `committer` lines,
 * a blank line, then the message exactly as given (no newline added).
 */
export function encodeCommit(c: {
  tree: Sha1;
  parents: Sha1[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const parent of c.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${c.author}`, `committer ${c.committer}`, '');
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(c.message, 'utf8')]);
}

/** Parse a commit object. Unknown headers (gpgsig, encoding, ...) are skipped. */
export function parseCommit(raw: Buffer): CommitData {
  const blank = raw.indexOf('\n\n');
  const headerEnd = blank < 0 ? raw.length : blank;
  const message = blank < 0 ? '' : raw.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: Sha1[] = [];
  let author = '';
  let committer = '';
  // Header lines; a line starting with a space continues the previous header.
  const lines = raw.subarray(0, headerEnd).toString('utf8').split('\n');
  let currentKey = '';
  let currentValue = '';
  const flush = (): void => {
    if (currentKey === 'tree') tree = currentValue;
    else if (currentKey === 'parent') parents.push(currentValue);
    else if (currentKey === 'author') author = currentValue;
    else if (currentKey === 'committer') committer = currentValue;
  };
  for (const line of lines) {
    if (line.startsWith(' ') && currentKey) {
      currentValue += `\n${line}`;
      continue;
    }
    flush();
    const space = line.indexOf(' ');
    currentKey = space < 0 ? line : line.slice(0, space);
    currentValue = space < 0 ? '' : line.slice(space + 1);
  }
  flush();
  return { tree, parents, author, committer, message };
}

/** Git tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '040000' || a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '040000' || b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Tree bytes: entries sorted git-style, each "mode SP name NUL 20-byte oid". */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(raw: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const space = raw.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = raw.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > raw.length) throw new Error('tree entry has a truncated object id');
    const mode = raw.subarray(offset, space).toString('ascii');
    const name = raw.subarray(space + 1, nul).toString('utf8');
    const oid = raw.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function getObjectOrThrow(repo: Repo, oid: Sha1): GitObject {
  const obj = repo.objects.get(oid);
  if (!obj) throw new Error(`object ${oid} is missing from the store`);
  return obj;
}

/**
 * Flatten a tree recursively: path -> { oid, mode } for every blob.
 * Subtrees are walked; gitlinks (mode 160000) are skipped.
 */
export function flattenTree(repo: Repo, treeOid: Sha1): Map<string, { oid: Sha1; mode: string }> {
  const out = new Map<string, { oid: Sha1; mode: string }>();
  const walk = (oid: Sha1, prefix: string): void => {
    const tree = getObjectOrThrow(repo, oid);
    if (tree.type !== 'tree') throw new Error(`object ${oid} is a ${tree.type}, not a tree`);
    for (const entry of parseTree(tree.raw)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '040000' || entry.mode === '40000') {
        walk(entry.oid, path);
      } else if (entry.mode === '160000') {
        continue; // gitlink: names a commit this repo does not hold
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  };
  walk(treeOid, '');
  return out;
}

interface BuildNode {
  files: Map<string, Buffer>;
  dirs: Map<string, BuildNode>;
}

/**
 * Build blob objects + nested trees bottom-up from path -> bytes.
 * Entries are sorted by name (git tree order). Returns the root tree oid
 * and every object created (blobs and trees, root tree included); the
 * caller stores them via store.putObject.
 */
export function buildTreeFromFiles(files: Map<string, Buffer>): { rootOid: Sha1; objects: GitObject[] } {
  const objects: GitObject[] = [];
  const root: BuildNode = { files: new Map(), dirs: new Map() };
  for (const [path, data] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      let child = node.dirs.get(name);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], data);
  }
  const build = (node: BuildNode): Sha1 => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of [...node.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const raw = Buffer.from(data);
      const oid = sha1Object('blob', raw);
      objects.push({ type: 'blob', raw });
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const oid = build(child);
      entries.push({ mode: '040000', name, oid });
    }
    const raw = encodeTree(entries);
    const oid = sha1Object('tree', raw);
    objects.push({ type: 'tree', raw });
    return oid;
  };
  const rootOid = build(root);
  return { rootOid, objects };
}
