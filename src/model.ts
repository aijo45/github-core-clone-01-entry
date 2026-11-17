import { createHash } from 'node:crypto';

export type Owner = string; // login, e.g. "octocat"
export type RepoName = string;
export type Sha1 = string; // 40 lowercase hex
export type BranchName = string;

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  raw: Buffer; // the exact bytes after the "<type> <size>\0" header
}

export interface CommitData {
  tree: Sha1;
  parents: Sha1[];
  author: string; // raw "Name <email> ts tz" line as received
  committer: string; // raw line as received
  message: string; // raw message bytes as string (utf8, may contain arbitrary bytes; keep raw)
}

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "040000"
  name: string;
  oid: Sha1;
}

export interface Repo {
  id: number; // sequential per store, starts at 1
  name: RepoName;
  owner: Owner;
  fullName: string; // "owner/name"
  description: string;
  isPrivate: boolean;
  defaultBranch: BranchName; // "main"
  hasIssues: boolean; // true
  // git state
  objects: Map<Sha1, GitObject>;
  refs: Map<string, Sha1>; // "refs/heads/main" -> sha, "refs/tags/v1" -> sha
  // counters (per repo)
  issueCounter: number; // next issue number (starts at 1)
  prCounter: number; // next PR number (starts at 1)
  commentCounter: number; // next comment number (starts at 1)
  issues: Issue[];
  labels: Label[];
  pulls: PullRequest[];
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number; // global sequential id (store-wide counter)
  number: number; // per-repo, starts at 1
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[]; // label names
  user: string; // owner login
  comments: Comment[];
  seq: number; // creation sequence (store-wide counter) for stable sort
}

export interface Comment {
  id: number;
  number: number; // per-repo comment sequence (not used by REST shape)
  issueNumber: number;
  body: string;
  user: string;
}

export interface PullRequest {
  id: number;
  number: number; // per-repo, starts at 1
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null; // deterministic: "1970-01-01T00:00:00Z" when merged (NOT wall clock)
  mergeCommitSha: string | null;
  headRef: BranchName;
  baseRef: BranchName;
  headSha: Sha1;
  baseSha: Sha1;
  mergeable: boolean;
  files: PrFile[]; // computed at create time from head vs base tree diff
  seq: number;
}

export interface PrFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: Sha1; // blob sha of the new version (or old for removed)
}

/** Deterministic merged timestamp used for every squash merge (never wall clock). */
export const MERGED_AT = '1970-01-01T00:00:00Z';

/** Deterministic author/committer line used for forge-built commits. */
export const FORGE_IDENT = 'forge <forge@local> 0 +0000';

/**
 * Deterministic global id: SHA-256 of "kind:repoId:localId", hex, prefixed by a
 * short kind tag and truncated to 24 hex chars. Opaque and stable across replays.
 * Prefixes: repository -> R_, issue -> I_, pull_request -> PR_, user -> U_,
 * anything else -> first letter of the kind, upper-cased, + "_".
 */
export function globalId(kind: string, repoId: number, localId: number): string {
  const hex = createHash('sha256').update(`${kind}:${repoId}:${localId}`).digest('hex');
  let prefix: string;
  if (kind === 'repository') prefix = 'R_';
  else if (kind === 'issue') prefix = 'I_';
  else if (kind === 'pull_request' || kind === 'pullrequest' || kind === 'pull') prefix = 'PR_';
  else if (kind === 'user') prefix = 'U_';
  else prefix = `${kind.charAt(0).toUpperCase()}_`;
  return prefix + hex.slice(0, 24);
}

/** Deterministic per-process request id: "req-" + n. */
export function requestId(n: number): string {
  return `req-${n}`;
}
