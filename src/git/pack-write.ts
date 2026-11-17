// Reachable-object traversal and non-delta packfile generation
// (DESIGN.md §4, pack-write.ts).

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { GitObject, Repo, Sha1 } from '../model.ts';
import { parseCommit, parseTree, sha1Object } from './objects.ts';

const TYPE_CODE: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Include a tree and everything under it (subtrees + blobs; gitlinks skipped). */
function collectTree(repo: Repo, treeOid: Sha1, out: Map<Sha1, GitObject>): void {
  const stack: Sha1[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as Sha1;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    out.set(oid, obj);
    for (const entry of parseTree(obj.raw)) {
      if (entry.mode === '040000' || entry.mode === '40000') {
        stack.push(entry.oid);
      } else if (entry.mode === '160000') {
        continue; // gitlink
      } else {
        const blob = repo.objects.get(entry.oid);
        if (blob) out.set(entry.oid, blob);
      }
    }
  }
}

/**
 * Walk commits from tips (following parents, up to `depth` generations if
 * given), collecting commits + their trees + blobs. Depth 1 = tip commit +
 * its tree/blobs only. Tag tips are dereferenced to their target. Returns
 * oid -> object (already in the store).
 */
export function collectReachable(repo: Repo, tips: Sha1[], opts?: { depth?: number }): Map<Sha1, GitObject> {
  const out = new Map<Sha1, GitObject>();
  const depth = opts?.depth;
  // Entries are { oid, generation }; a commit is included only when
  // generation < depth (depth undefined = unlimited). A commit reached by
  // several paths keeps its smallest generation.
  const seenGen = new Map<Sha1, number>();
  const stack: Array<{ oid: Sha1; gen: number }> = [];
  for (const tip of tips) stack.push({ oid: tip, gen: 0 });
  while (stack.length > 0) {
    const { oid, gen } = stack.pop() as { oid: Sha1; gen: number };
    const prevGen = seenGen.get(oid);
    if (prevGen !== undefined && prevGen <= gen) continue;
    seenGen.set(oid, gen);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      out.set(oid, obj);
      const blank = obj.raw.indexOf('\n\n');
      const header = obj.raw.subarray(0, blank < 0 ? obj.raw.length : blank).toString('utf8');
      for (const line of header.split('\n')) {
        if (line.startsWith('object ')) stack.push({ oid: line.slice('object '.length).trim(), gen });
      }
      continue;
    }
    if (obj.type === 'tree') {
      collectTree(repo, oid, out);
      continue;
    }
    if (obj.type === 'blob') {
      out.set(oid, obj);
      continue;
    }
    // Commit.
    if (depth !== undefined && gen >= depth) continue;
    out.set(oid, obj);
    let commit;
    try {
      commit = parseCommit(obj.raw);
    } catch {
      continue;
    }
    collectTree(repo, commit.tree, out);
    for (const parent of commit.parents) stack.push({ oid: parent, gen: gen + 1 });
  }
  return out;
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: GitObject['type'], size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Non-delta pack: "PACK" + version 2 + count + per object (varint size/type
 * header + zlib(raw)) + trailer sha1 of all preceding bytes. Deterministic
 * object order: sorted by oid.
 */
export function writePack(objects: Map<Sha1, GitObject> | GitObject[]): Buffer {
  const list: Array<{ oid: Sha1; obj: GitObject }> = [];
  if (objects instanceof Map) {
    for (const [oid, obj] of objects) list.push({ oid, obj });
  } else {
    for (const obj of objects) list.push({ oid: sha1Object(obj.type, obj.raw), obj });
  }
  list.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const { obj } of list) {
    parts.push(writePackObjectHeader(obj.type, obj.raw.length));
    parts.push(deflateSync(obj.raw));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
