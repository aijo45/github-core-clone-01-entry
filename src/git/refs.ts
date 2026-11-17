// Ref ancestry and fast-forward checks (DESIGN.md §4, refs.ts).

import type { Repo, Sha1 } from '../model.ts';
import { parseCommit } from './objects.ts';

export const ZERO_OID: string = '0'.repeat(40);

/**
 * Walk parents from the descendant; true when the ancestor is reached
 * (or ancestor === descendant). Missing objects end the walk (false).
 * A visited set guards against a corrupt/cyclic graph.
 */
export function isAncestor(repo: Repo, ancestor: Sha1, descendant: Sha1): boolean {
  if (ancestor === descendant) return true;
  const visited = new Set<Sha1>();
  const stack: Sha1[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as Sha1;
    if (oid === ancestor) return true;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      // Annotated tag: follow to its target object.
      const blank = obj.raw.indexOf('\n\n');
      const header = obj.raw.subarray(0, blank < 0 ? obj.raw.length : blank).toString('utf8');
      for (const line of header.split('\n')) {
        if (line.startsWith('object ')) stack.push(line.slice('object '.length).trim());
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    let commit;
    try {
      commit = parseCommit(obj.raw);
    } catch {
      continue;
    }
    for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

/**
 * old === zero (create) -> true; old === new -> true; otherwise old must
 * be an ancestor of new.
 */
export function isFastForward(repo: Repo, oldOid: Sha1, newOid: Sha1): boolean {
  if (oldOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  return isAncestor(repo, oldOid, newOid);
}
