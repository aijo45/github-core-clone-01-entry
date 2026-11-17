import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  FORGE_IDENT,
  MERGED_AT,
  globalId as modelGlobalId,
  type BranchName,
  type Comment,
  type GitObject,
  type Issue,
  type Label,
  type Owner,
  type PrFile,
  type PullRequest,
  type Repo,
  type RepoName,
  type Sha1,
} from './model.ts';

/** SHA-1 of "<type> <len>\0" + raw, the git object id. */
export function sha1Object(type: string, raw: Buffer): Sha1 {
  const header = Buffer.from(`${type} ${raw.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(raw).digest('hex');
}

function repoKey(owner: Owner, name: RepoName): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
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
    const name = raw.subarray(space + 1, nul).toString('utf8');
    const oid = raw.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Parse a raw commit object; returns null when the bytes are not a commit. */
function parseCommitRaw(raw: Buffer): { tree: Sha1; parents: Sha1[] } | null {
  const text = raw.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  let tree: Sha1 | null = null;
  const parents: Sha1[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (tree === null) return null;
  return { tree, parents };
}

/** Encode a commit object body (raw bytes after the header). */
function encodeCommitRaw(tree: Sha1, parents: Sha1[], message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${FORGE_IDENT}\ncommitter ${FORGE_IDENT}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

/** Recursively flatten a tree to path -> { oid, mode } for blobs only. */
function flattenTree(repo: Repo, treeOid: Sha1, prefix: string, out: Map<string, { oid: Sha1; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTreeEntries(obj.raw)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '040000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

/** Count '\n' bytes in a blob; binary blobs (contain NUL) count as 0 lines. */
function countLines(repo: Repo, oid: Sha1): number {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return 0;
  if (obj.raw.includes(0)) return 0;
  let n = 0;
  for (let i = 0; i < obj.raw.length; i += 1) if (obj.raw[i] === 0x0a) n += 1;
  return n;
}

/**
 * ForgeStore — the single source of truth. The ONLY place that mutates domain state.
 * All ids come from store-wide sequential counters or SHA-256; no wall clock, no
 * randomness. Repo/issue/PR ids share one counter via nextId(); issue/PR `seq`
 * values share a second counter via nextSeq().
 */
export class ForgeStore {
  /** MAKEFUN_SHOP_TOKEN from env (or "" if unset, meaning any non-empty Bearer works). */
  token: string;

  private repos = new Map<string, Repo>();
  private idCounter = 1;
  private seqCounter = 1;
  private globalIds = new Map<string, { kind: string; repoId: number; localId: number }>();

  constructor(token?: string) {
    this.token = token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  // ---- auth ----

  checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/.exec(header.trim());
    if (match === null) return false;
    const presented = match[1].trim();
    if (presented === '') return false;
    if (this.token === '') return true;
    return presented === this.token;
  }

  // ---- counters / global ids ----

  nextSeq(): number {
    const n = this.seqCounter;
    this.seqCounter += 1;
    return n;
  }

  nextId(): number {
    const n = this.idCounter;
    this.idCounter += 1;
    return n;
  }

  globalId(kind: string, repoId: number, localId: number): string {
    const gid = modelGlobalId(kind, repoId, localId);
    this.globalIds.set(gid, { kind, repoId, localId });
    return gid;
  }

  resolveGlobalId(gid: string): { kind: string; repoId: number; localId: number } | null {
    return this.globalIds.get(gid) ?? null;
  }

  // ---- repos ----

  createRepo(owner: Owner, name: RepoName, opts: { description?: string; isPrivate?: boolean }): Repo | { error: 'duplicate' } {
    if (this.repos.has(repoKey(owner, name))) return { error: 'duplicate' };
    const repo: Repo = {
      id: this.nextId(),
      name,
      owner,
      fullName: `${owner}/${name}`,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: 'main',
      hasIssues: true,
      objects: new Map<Sha1, GitObject>(),
      refs: new Map<string, Sha1>(),
      issueCounter: 1,
      prCounter: 1,
      commentCounter: 1,
      issues: [],
      labels: [],
      pulls: [],
    };
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: Owner, name: RepoName): Repo | null {
    const exact = this.repos.get(repoKey(owner, name));
    if (exact !== undefined) return exact;
    // Lazy owner binding (coordinator fix): a repo created via POST /user/repos is
    // stored under an empty owner until the first owner-carrying access. Bind it to
    // the owner that first asks for it by name — the suite always references its own
    // login first — so REST, GraphQL, MCP and git all see the same repo no matter
    // which surface touches it first. (REST also binds in its own resolveRepo; this
    // is the same rule, applied at the store so no module can miss it.)
    if (owner !== '') {
      for (const repo of this.repos.values()) {
        if (repo.owner === '' && repo.name.toLowerCase() === name.toLowerCase()) {
          this.repos.delete(repoKey(repo.owner, repo.name));
          repo.owner = owner;
          repo.fullName = `${owner}/${repo.name}`;
          this.repos.set(repoKey(owner, repo.name), repo);
          return repo;
        }
      }
    }
    return null;
  }

  listRepos(owner: Owner): Repo[] {
    const want = owner.toLowerCase();
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === want) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** All repos in the store, in creation order (used by /user/repos). */
  listAllRepos(): Repo[] {
    const out = [...this.repos.values()];
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  deleteRepo(owner: Owner, name: RepoName): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  updateRepo(owner: Owner, name: RepoName, patch: { description?: string }): Repo | null {
    const repo = this.getRepo(owner, name);
    if (repo === null) return null;
    if (patch.description !== undefined) repo.description = patch.description;
    return repo;
  }

  // ---- git objects & refs ----

  putObject(repo: Repo, obj: GitObject): Sha1 {
    const oid = sha1Object(obj.type, obj.raw);
    repo.objects.set(oid, obj);
    return oid;
  }

  getObject(repo: Repo, oid: Sha1): GitObject | null {
    return repo.objects.get(oid) ?? null;
  }

  getRef(repo: Repo, ref: string): Sha1 | null {
    return repo.refs.get(ref) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: Sha1): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /**
   * All refs in the repo's map, sorted by name. HEAD is not stored in the map;
   * callers resolve it separately as refs/heads/<defaultBranch>.
   */
  listRefs(repo: Repo): Array<{ name: string; oid: Sha1 }> {
    const out: Array<{ name: string; oid: Sha1 }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // ---- issues / labels / comments ----

  createLabel(repo: Repo, name: string, color?: string): Label | { error: 'duplicate' } {
    if (this.getLabel(repo, name) !== null) return { error: 'duplicate' };
    const label: Label = { name, color: color ?? '000000' };
    repo.labels.push(label);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | null {
    const want = name.toLowerCase();
    for (const label of repo.labels) if (label.name.toLowerCase() === want) return label;
    return null;
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue | { error: 'unknown-label'; label: string } {
    for (const name of input.labels ?? []) {
      if (this.getLabel(repo, name) === null) return { error: 'unknown-label', label: name };
    }
    const issue: Issue = {
      id: this.nextId(),
      number: repo.issueCounter,
      repoId: repo.id,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      user: repo.owner,
      comments: [],
      seq: this.nextSeq(),
    };
    repo.issueCounter += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    for (const issue of repo.issues) if (issue.number === number) return issue;
    return null;
  }

  listIssues(repo: Repo, opts: { state?: 'open' | 'closed' | 'all'; sort?: 'created'; direction?: 'asc' | 'desc' }): Issue[] {
    const state = opts.state ?? 'open';
    let out = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    out = [...out].sort((a, b) => a.seq - b.seq);
    if ((opts.direction ?? 'asc') === 'desc') out.reverse();
    return out;
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue | null {
    const issue = this.getIssue(repo, number);
    if (issue === null) return null;
    issue.state = state;
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string, user: string): Comment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (issue === null) return null;
    const comment: Comment = {
      id: this.nextId(),
      number: repo.commentCounter,
      issueNumber,
      body,
      user,
    };
    repo.commentCounter += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---- pulls ----

  /** Compute the head-vs-base file diff for a PR (flattened trees, line counts). */
  private computePrFiles(repo: Repo, headSha: Sha1, baseSha: Sha1): PrFile[] {
    const headCommit = this.getObject(repo, headSha);
    const baseCommit = this.getObject(repo, baseSha);
    if (headCommit === null || baseCommit === null || headCommit.type !== 'commit' || baseCommit.type !== 'commit') return [];
    const headParsed = parseCommitRaw(headCommit.raw);
    const baseParsed = parseCommitRaw(baseCommit.raw);
    if (headParsed === null || baseParsed === null) return [];
    const headFiles = new Map<string, { oid: Sha1; mode: string }>();
    const baseFiles = new Map<string, { oid: Sha1; mode: string }>();
    flattenTree(repo, headParsed.tree, '', headFiles);
    flattenTree(repo, baseParsed.tree, '', baseFiles);
    const names = new Set<string>([...headFiles.keys(), ...baseFiles.keys()]);
    const sorted = [...names].sort();
    const files: PrFile[] = [];
    for (const filename of sorted) {
      const head = headFiles.get(filename);
      const base = baseFiles.get(filename);
      if (head !== undefined && base === undefined) {
        const additions = countLines(repo, head.oid);
        files.push({ filename, status: 'added', additions, deletions: 0, changes: additions, sha: head.oid });
      } else if (head === undefined && base !== undefined) {
        const deletions = countLines(repo, base.oid);
        files.push({ filename, status: 'removed', additions: 0, deletions, changes: deletions, sha: base.oid });
      } else if (head !== undefined && base !== undefined && head.oid !== base.oid) {
        const additions = countLines(repo, head.oid);
        const deletions = countLines(repo, base.oid);
        files.push({ filename, status: 'modified', additions, deletions, changes: additions + deletions, sha: head.oid });
      }
    }
    return files;
  }

  createPull(repo: Repo, input: { title: string; body?: string; head: BranchName; base: BranchName }): PullRequest | { error: 'bad-ref'; ref: string } {
    const headSha = this.getRef(repo, `refs/heads/${input.head}`);
    if (headSha === null) return { error: 'bad-ref', ref: input.head };
    const baseSha = this.getRef(repo, `refs/heads/${input.base}`);
    if (baseSha === null) return { error: 'bad-ref', ref: input.base };
    const headObj = this.getObject(repo, headSha);
    const baseObj = this.getObject(repo, baseSha);
    if (headObj === null || headObj.type !== 'commit') return { error: 'bad-ref', ref: input.head };
    if (baseObj === null || baseObj.type !== 'commit') return { error: 'bad-ref', ref: input.base };
    const pr: PullRequest = {
      id: this.nextId(),
      number: repo.prCounter,
      repoId: repo.id,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      mergeable: true,
      files: this.computePrFiles(repo, headSha, baseSha),
      seq: this.nextSeq(),
    };
    repo.prCounter += 1;
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: Repo, number: number): PullRequest | null {
    for (const pr of repo.pulls) if (pr.number === number) return pr;
    return null;
  }

  listPulls(repo: Repo, opts: { state?: 'open' | 'closed' | 'all' }): PullRequest[] {
    const state = opts.state ?? 'open';
    const out = repo.pulls.filter((pr) => state === 'all' || pr.state === state);
    return [...out].sort((a, b) => a.seq - b.seq);
  }

  mergePullSquash(repo: Repo, number: number): PullRequest | { error: 'not-found' } | { error: 'conflict' } {
    const pr = this.getPull(repo, number);
    if (pr === null) return { error: 'not-found' };
    if (pr.state !== 'open' || pr.merged) return { error: 'conflict' };
    const headSha = this.getRef(repo, `refs/heads/${pr.headRef}`);
    if (headSha === null) return { error: 'conflict' };
    const baseSha = this.getRef(repo, `refs/heads/${pr.baseRef}`);
    if (baseSha === null) return { error: 'conflict' };
    const headCommit = this.getObject(repo, headSha);
    if (headCommit === null || headCommit.type !== 'commit') return { error: 'conflict' };
    const headParsed = parseCommitRaw(headCommit.raw);
    if (headParsed === null) return { error: 'conflict' };
    const raw = encodeCommitRaw(headParsed.tree, [baseSha], `Merge pull request #${pr.number} from ${pr.headRef}`);
    const mergeOid = this.putObject(repo, { type: 'commit', raw });
    this.setRef(repo, `refs/heads/${pr.baseRef}`, mergeOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = MERGED_AT;
    pr.mergeCommitSha = mergeOid;
    pr.baseSha = mergeOid;
    return pr;
  }
}
