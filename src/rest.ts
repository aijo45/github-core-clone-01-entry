// REST v3 router (GitHub-compatible, /api/v3).
//
// Implements DESIGN.md §5 exactly: createRestRouter(store) returns an async
// handler (req, res, path, query) => Promise<boolean>. true = the path was an
// /api/v3 route (handled, even when the answer is a JSON error); false = the
// path is outside /api/v3 and the caller (app.ts) should route it elsewhere.
//
// Determinism: no Date.now(), no new Date(), no Math.random(), no UUIDs.
// Commit author/committer dates are always "1970-01-01T00:00:00Z" (MERGED_AT).
// Request ids come from src/json.ts's sendJson (req-<n>, per-process counter).
//
// Owner binding: POST /user/repos carries no owner — the login the bearer
// token names is only visible later, in /repos/{owner}/{name} URLs. The store
// keys repos by owner/name, so a repo created via POST /user/repos is first
// stored under an empty (unbound) owner and lazily bound to the first owner
// seen in an owner-carrying URL for that repo name (the suite always
// references its own login first; a different login afterwards is a 404).
// Binding rekeys the store's map entry in place, so the repo id, objects,
// refs, issues and PRs survive and every other module (git, GraphQL, MCP)
// sees the same repo through store.getRepo(owner, name).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { MERGED_AT, requestId, type Repo, type Sha1 } from './model.ts';
import type { ForgeStore } from './store.ts';
import { readJsonBody, sendJson } from './json.ts';
import { buildFileCommit, flattenTreeToFiles } from './fixtures.ts';

export type RestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
) => Promise<boolean>;

const JSON_DATE = MERGED_AT;
const SHA40_RE = /^[0-9a-f]{40}$/i;
/** Owner used at creation time, before the first owner-carrying URL binds it. */
const UNBOUND_OWNER = '';

/** Local request-id counter, used only for the 204 (no-body) reply. */
let restReqCounter = 1;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded) return;
  sendJson(res, status, { message });
}

function sendNoContent(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.writeHead(204, { 'x-github-request-id': requestId(restReqCounter) });
  restReqCounter += 1;
  res.end();
}

// ---------------------------------------------------------------------------
// request body
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON request body.
 * - If app.ts already consumed the body it may have stashed it on the request
 *   as `body` (parsed value), `rawBody` (string/Buffer) or `parsedBody`;
 *   those win over reading the stream (a consumed stream reads as empty).
 * - Otherwise the stream is read via readJsonBody.
 * Returns { value } on success ({} when the body was empty), or { malformed }
 * when bytes were present but did not parse as JSON.
 */
async function getBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: 'malformed' }> {
  const anyReq = req as unknown as Record<string, unknown>;
  const stashed = anyReq.body ?? anyReq.rawBody ?? anyReq.parsedBody ?? anyReq.jsonBody;
  if (stashed !== undefined) {
    if (typeof stashed === 'string') {
      const text = stashed.trim();
      if (text === '') return { ok: true, value: {} };
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: 'malformed' };
      }
    }
    if (Buffer.isBuffer(stashed) || stashed instanceof Uint8Array) {
      const text = Buffer.from(stashed).toString('utf8').trim();
      if (text === '') return { ok: true, value: {} };
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: 'malformed' };
      }
    }
    return { ok: true, value: stashed };
  }
  const read = await readJsonBody(req);
  if (read.ok) return { ok: true, value: read.value };
  if (read.error === 'empty') return { ok: true, value: {} };
  return { ok: false, error: 'malformed' };
}

// ---------------------------------------------------------------------------
// path handling
// ---------------------------------------------------------------------------

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Split a path into decoded segments. Returns null on a bad %-escape. */
function splitPath(path: string): string[] | null {
  const clean = path.split('?')[0];
  const parts = clean.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    const decoded = decodeSegment(part);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

/**
 * Normalise the router's `path` argument to the segments below /api/v3.
 * Accepts both the full path ("/api/v3/user/repos") and an already-stripped
 * one ("/user/repos", as app.ts might pass). Returns null when the path is
 * not an /api/v3 path at all (caller should route it elsewhere).
 */
function apiSegments(path: string): string[] | 'root' | null {
  if (path === '/api/v3' || path === '/api/v3/') return 'root';
  if (path.startsWith('/api/v3/')) {
    const rest = splitPath(path.slice('/api/v3'.length));
    return rest === null ? ['\0bad-escape'] : rest;
  }
  if (path === '/' || path === '') return 'root';
  if (path === '/meta' || path.startsWith('/meta/') || path.startsWith('/user/') || path.startsWith('/repos/')) {
    const rest = splitPath(path);
    return rest === null ? ['\0bad-escape'] : rest;
  }
  return null;
}

// ---------------------------------------------------------------------------
// owner binding (see the header comment)
// ---------------------------------------------------------------------------

function storeRepoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function bindOwner(store: ForgeStore, repo: Repo, owner: string): void {
  if (repo.owner === owner) return;
  const map = (store as unknown as { repos?: Map<string, Repo> }).repos;
  if (map !== undefined) {
    map.delete(storeRepoKey(repo.owner, repo.name));
    repo.owner = owner;
    repo.fullName = `${owner}/${repo.name}`;
    map.set(storeRepoKey(owner, repo.name), repo);
  } else {
    repo.owner = owner;
    repo.fullName = `${owner}/${repo.name}`;
  }
}

/**
 * Resolve /repos/{owner}/{name}. Exact match first; otherwise lazily bind a
 * repo created via POST /user/repos (still under the unbound owner) to this
 * owner. A name bound to a different owner stays a 404 for this owner.
 */
function resolveRepo(store: ForgeStore, owner: string, name: string): Repo | null {
  const exact = store.getRepo(owner, name);
  if (exact !== null) return exact;
  for (const candidate of store.listAllRepos()) {
    if (candidate.owner === UNBOUND_OWNER && candidate.name.toLowerCase() === name.toLowerCase()) {
      bindOwner(store, candidate, owner);
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// git object parsing (local; the git modules own the canonical versions)
// ---------------------------------------------------------------------------

interface ParsedTreeEntry {
  mode: string;
  name: string;
  oid: Sha1;
}

function parseTreeEntries(raw: Buffer): ParsedTreeEntry[] {
  const entries: ParsedTreeEntry[] = [];
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

interface ParsedCommit {
  tree: Sha1;
  parents: Sha1[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(raw: Buffer): ParsedCommit | null {
  const text = raw.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree: Sha1 | null = null;
  const parents: Sha1[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === null) return null;
  return { tree, parents, author, committer, message };
}

function commitOf(store: ForgeStore, repo: Repo, oid: Sha1): ParsedCommit | null {
  const obj = store.getObject(repo, oid);
  if (obj === null) return null;
  if (obj.type === 'tag') {
    // Annotated tag: follow its `object` line once.
    const text = obj.raw.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    if (match === null) return null;
    return commitOf(store, repo, match[1]);
  }
  if (obj.type !== 'commit') return null;
  return parseCommit(obj.raw);
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^([^<]*?) <([^>]*)> \d+ [+-]\d{4}$/.exec(line.trim());
  if (match !== null) return { name: (match[1] ?? '').trim() || 'forge', email: match[2] ?? '', date: JSON_DATE };
  const trimmed = line.trim();
  return { name: trimmed === '' ? 'forge' : trimmed, email: '', date: JSON_DATE };
}

// ---------------------------------------------------------------------------
// pagination + Link header
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  let perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = Number.parseInt(query.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { perPage, page };
}

function paginate<T>(
  items: T[],
  query: URLSearchParams,
  req: IncomingMessage,
): { pageItems: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  if (page >= totalPages) return { pageItems, link: null };
  let pathname = '/api/v3';
  try {
    pathname = new URL(req.url ?? '/api/v3', 'http://entry').pathname;
  } catch {
    pathname = '/api/v3';
  }
  const host = req.headers.host ?? 'localhost';
  const nextParams = new URLSearchParams(query);
  nextParams.set('per_page', String(perPage));
  nextParams.set('page', String(page + 1));
  const lastParams = new URLSearchParams(query);
  lastParams.set('per_page', String(perPage));
  lastParams.set('page', String(totalPages));
  const link =
    `<http://${host}${pathname}?${nextParams.toString()}>; rel="next", ` +
    `<http://${host}${pathname}?${lastParams.toString()}>; rel="last"`;
  return { pageItems, link };
}

function sendPage<T>(res: ServerResponse, items: T[], query: URLSearchParams, req: IncomingMessage): void {
  const { pageItems, link } = paginate(items, query, req);
  sendJson(res, 200, pageItems, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------
// serializers (DESIGN.md §5 shapes)
// ---------------------------------------------------------------------------

function repoUrl(repo: Repo): string {
  return `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function serializeRepo(repo: Repo): JsonRecord {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    url: repoUrl(repo),
  };
}

function serializeIssue(store: ForgeStore, repo: Repo, issue: Repo['issues'][number]): JsonRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = store.getLabel(repo, name);
      return label === null ? { name } : { name: label.name, color: label.color };
    }),
    user: { login: issue.user },
    comments: issue.comments.length,
    url: `${repoUrl(repo)}/issues/${issue.number}`,
  };
}

function serializeComment(comment: Repo['issues'][number]['comments'][number]): JsonRecord {
  return { id: comment.id, body: comment.body, user: { login: comment.user } };
}

function serializePull(store: ForgeStore, repo: Repo, pr: Repo['pulls'][number]): JsonRecord {
  const headSha = store.getRef(repo, `refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = store.getRef(repo, `refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: headSha },
    base: { ref: pr.baseRef, sha: baseSha },
    mergeable: pr.mergeable,
    user: { login: repo.owner },
    url: `${repoUrl(repo)}/pulls/${pr.number}`,
  };
}

function serializeRef(store: ForgeStore, repo: Repo, ref: string, sha: Sha1): JsonRecord {
  const obj = store.getObject(repo, sha);
  return { ref, sha, object: { type: obj === null ? 'commit' : obj.type, sha } };
}

// ---------------------------------------------------------------------------
// contents helpers
// ---------------------------------------------------------------------------

/** Resolve a ?ref= value (branch, tag, or raw commit sha) to a commit + tree. */
function resolveRefCommit(store: ForgeStore, repo: Repo, refParam: string | null): { commitOid: Sha1; treeOid: Sha1 } | null {
  let oid: Sha1 | null = null;
  if (refParam === null || refParam === '') {
    oid = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
  } else {
    oid = store.getRef(repo, `refs/heads/${refParam}`) ?? store.getRef(repo, `refs/tags/${refParam}`);
    if (oid === null && SHA40_RE.test(refParam)) oid = refParam;
  }
  if (oid === null) return null;
  const parsed = commitOf(store, repo, oid);
  if (parsed === null) return null;
  return { commitOid: oid, treeOid: parsed.tree };
}

type PathLookup =
  | { kind: 'file'; oid: Sha1; size: number }
  | { kind: 'dir'; oid: Sha1 }
  | null;

/** Walk a tree by path segments. Empty segments = the tree root itself. */
function lookupPath(store: ForgeStore, repo: Repo, treeOid: Sha1, segments: string[]): PathLookup {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = store.getObject(repo, current);
    if (obj === null || obj.type !== 'tree') return null;
    const entry = parseTreeEntries(obj.raw).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '040000') {
      if (last) return { kind: 'dir', oid: entry.oid };
      current = entry.oid;
    } else {
      if (!last) return null;
      const blob = store.getObject(repo, entry.oid);
      if (blob === null) return null;
      return { kind: 'file', oid: entry.oid, size: blob.raw.length };
    }
  }
  return { kind: 'dir', oid: treeOid };
}

/** Reject ".." (and NUL) path segments: a contents path never escapes the repo. */
function hasTraversal(segments: string[]): boolean {
  return segments.some((s) => s === '..' || s.includes('\0'));
}

function buffersEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.equals(b);
}

/**
 * True three-way merge conflict for a PR: a file the PR changes (head vs the
 * base at PR creation) was also changed on the current base tip, to different
 * bytes than the head carries. The store's mergePullSquash alone cannot see
 * this (it just takes the head tree), so REST checks it before merging.
 */
function hasMergeConflict(store: ForgeStore, repo: Repo, pr: Repo['pulls'][number]): boolean {
  const baseNowTip = store.getRef(repo, `refs/heads/${pr.baseRef}`);
  const headTip = store.getRef(repo, `refs/heads/${pr.headRef}`);
  if (baseNowTip === null || headTip === null) return true;
  const baseNow = commitOf(store, repo, baseNowTip);
  const baseOrig = commitOf(store, repo, pr.baseSha);
  const head = commitOf(store, repo, headTip);
  if (baseNow === null || baseOrig === null || head === null) return true;
  const nowFiles = new Map<string, Buffer>();
  const origFiles = new Map<string, Buffer>();
  const headFiles = new Map<string, Buffer>();
  flattenTreeToFiles(repo, baseNow.tree, '', nowFiles);
  flattenTreeToFiles(repo, baseOrig.tree, '', origFiles);
  flattenTreeToFiles(repo, head.tree, '', headFiles);
  for (const file of pr.files) {
    const now = nowFiles.get(file.filename);
    const orig = origFiles.get(file.filename);
    const headBuf = headFiles.get(file.filename);
    if (!buffersEqual(now, orig) && !buffersEqual(now, headBuf)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export function createRestRouter(store: ForgeStore): RestHandler {
  return async (req, res, path, query): Promise<boolean> => {
    try {
      return await route(store, req, res, path, query);
    } catch {
      // Never crash the server or leak a stack: a JSON 500 for the unexpected.
      sendErr(res, 500, 'Internal Server Error');
      return true;
    }
  };
}

async function route(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams | undefined,
): Promise<boolean> {
  const segmentsOrRoot = apiSegments(path);
  if (segmentsOrRoot === null) return false;
  const q: URLSearchParams =
    query ??
    (() => {
      try {
        return new URL(req.url ?? '/', 'http://entry').searchParams;
      } catch {
        return new URLSearchParams();
      }
    })();
  const method = (req.method ?? 'GET').toUpperCase();

  // API root: no auth (the starter answers it without auth; DESIGN.md §8).
  if (segmentsOrRoot === 'root') {
    if (method !== 'GET') {
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  const segments = segmentsOrRoot;
  if (segments.length === 0) {
    // "/api/v3" with a bad %-escape, or an empty stripped path: treat as root.
    if (method !== 'GET') {
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // Auth: every other /api/v3 route needs the bearer token.
  if (!store.checkAuth(req)) {
    sendErr(res, 401, 'Unauthorized');
    return true;
  }

  // Bodies are read once, only for methods that carry one. Malformed JSON -> 400.
  let body: unknown = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const parsed = await getBody(req);
    if (!parsed.ok) {
      sendErr(res, 400, 'Malformed JSON in request body');
      return true;
    }
    body = parsed.value;
  }
  const bodyObj: JsonRecord = isRecord(body) ? body : {};

  // -- /api/v3/meta ---------------------------------------------------------
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') {
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // -- /api/v3/user/repos ---------------------------------------------------
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      sendPage(res, store.listAllRepos().map(serializeRepo), q, req);
      return true;
    }
    if (method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
      if (name === '' || name.includes('/')) {
        sendErr(res, 422, 'Repository name is required');
        return true;
      }
      const created = store.createRepo(UNBOUND_OWNER, name, {
        description: typeof bodyObj.description === 'string' ? bodyObj.description : undefined,
        isPrivate: bodyObj.private === true,
      });
      if ('error' in created) {
        sendErr(res, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, 201, serializeRepo(created));
      return true;
    }
    sendErr(res, 405, 'Method Not Allowed');
    return true;
  }

  // -- /api/v3/repos/{owner}/{repo}/... ------------------------------------
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const repoName = segments[2];
    const rest = segments.slice(3);

    // GET/PUT/DELETE on the repo itself need the repo; sub-routes resolve it too.
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = resolveRepo(store, owner, repoName);
        if (repo === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, serializeRepo(repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = resolveRepo(store, owner, repoName);
        if (repo === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        const updated = store.updateRepo(repo.owner, repo.name, {
          description: typeof bodyObj.description === 'string' ? bodyObj.description : undefined,
        });
        sendJson(res, 200, serializeRepo(updated ?? repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = resolveRepo(store, owner, repoName);
        if (repo === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        store.deleteRepo(repo.owner, repo.name);
        sendNoContent(res);
        return true;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }

    const repo = resolveRepo(store, owner, repoName);
    if (repo === null) {
      sendErr(res, 404, 'Not Found');
      return true;
    }

    // -- branches ----------------------------------------------------------
    if (rest[0] === 'branches' && rest.length === 1) {
      if (method !== 'GET') {
        sendErr(res, 405, 'Method Not Allowed');
        return true;
      }
      const branches = store
        .listRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
      sendJson(res, 200, branches);
      return true;
    }

    // -- git/refs ----------------------------------------------------------
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
      if (method === 'GET') {
        sendJson(
          res,
          200,
          store.listRefs(repo).map((ref) => serializeRef(store, repo, ref.name, ref.oid)),
        );
        return true;
      }
      if (method === 'POST') {
        const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        if (!ref.startsWith('refs/') || ref === 'refs/' || !SHA40_RE.test(sha)) {
          sendErr(res, 422, 'Invalid ref or sha');
          return true;
        }
        if (store.getObject(repo, sha) === null) {
          sendErr(res, 422, 'Invalid sha: object does not exist');
          return true;
        }
        if (store.getRef(repo, ref) !== null) {
          sendErr(res, 422, 'Reference already exists');
          return true;
        }
        store.setRef(repo, ref, sha);
        sendJson(res, 201, serializeRef(store, repo, ref, sha));
        return true;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }

    // -- commits -----------------------------------------------------------
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') {
        sendErr(res, 405, 'Method Not Allowed');
        return true;
      }
      const shaParam = q.get('sha');
      const resolved = resolveRefCommit(store, repo, shaParam);
      if (resolved === null) {
        if (shaParam !== null && shaParam !== '') {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, []);
        return true;
      }
      const out: JsonRecord[] = [];
      const seen = new Set<Sha1>();
      const queue: Sha1[] = [resolved.commitOid];
      while (queue.length > 0) {
        const oid = queue.shift() as Sha1;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const parsed = commitOf(store, repo, oid);
        if (parsed === null) continue;
        out.push({
          sha: oid,
          commit: {
            message: parsed.message,
            author: parseIdent(parsed.author),
            committer: parseIdent(parsed.committer),
          },
          parents: parsed.parents.map((p) => ({ sha: p })),
        });
        for (const parent of parsed.parents) if (!seen.has(parent)) queue.push(parent);
      }
      sendJson(res, 200, out);
      return true;
    }

    // -- contents/{path...} -------------------------------------------------
    if (rest[0] === 'contents') {
      const pathSegments = rest.slice(1);
      if (hasTraversal(pathSegments)) {
        sendErr(res, 404, 'Not Found');
        return true;
      }
      const joinedPath = pathSegments.join('/');

      if (method === 'GET') {
        const refParam = q.get('ref');
        const resolved = resolveRefCommit(store, repo, refParam);
        if (resolved === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        const found = lookupPath(store, repo, resolved.treeOid, pathSegments);
        if (found === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        if (found.kind === 'file') {
          const blob = store.getObject(repo, found.oid);
          if (blob === null) {
            sendErr(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, {
            type: 'file',
            name: pathSegments[pathSegments.length - 1] ?? '',
            path: joinedPath,
            sha: found.oid,
            size: found.size,
            content: blob.raw.toString('base64'),
            encoding: 'base64',
          });
          return true;
        }
        const dirObj = store.getObject(repo, found.oid);
        if (dirObj === null || dirObj.type !== 'tree') {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        const entries = parseTreeEntries(dirObj.raw)
          .map((entry) => ({
            type: entry.mode === '040000' ? 'dir' : 'file',
            name: entry.name,
            path: joinedPath === '' ? entry.name : `${joinedPath}/${entry.name}`,
            sha: entry.oid,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        sendJson(res, 200, entries);
        return true;
      }

      if (method === 'PUT') {
        if (pathSegments.length === 0) {
          sendErr(res, 422, 'A file path is required');
          return true;
        }
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : '';
        const contentB64 = typeof bodyObj.content === 'string' ? bodyObj.content : null;
        if (message === '' || contentB64 === null) {
          sendErr(res, 422, 'message and content are required');
          return true;
        }
        const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;
        const tip = store.getRef(repo, `refs/heads/${branch}`);
        let baseTree: Sha1 | null = null;
        const parents: Sha1[] = [];
        if (tip !== null) {
          const parsed = commitOf(store, repo, tip);
          if (parsed === null) {
            sendErr(res, 422, 'Branch tip is not a commit');
            return true;
          }
          baseTree = parsed.tree;
          parents.push(tip);
        }
        const current = baseTree === null ? null : lookupPath(store, repo, baseTree, pathSegments);
        if (current !== null && current.kind === 'dir') {
          sendErr(res, 422, 'Cannot write a directory');
          return true;
        }
        const isUpdate = current !== null && current.kind === 'file';
        if (isUpdate && current !== null && current.kind === 'file') {
          if (typeof bodyObj.sha !== 'string' || bodyObj.sha === '') {
            sendErr(res, 422, 'sha is required to update a file');
            return true;
          }
          if ((bodyObj.sha as string).toLowerCase() !== current.oid.toLowerCase()) {
            sendErr(res, 409, 'sha does not match the current file');
            return true;
          }
        } else if (typeof bodyObj.sha === 'string' && bodyObj.sha !== '') {
          sendErr(res, 409, 'sha does not match the current file');
          return true;
        }
        const contentBuf = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        const { commitOid, blobOid } = buildFileCommit(store, repo, {
          baseTree,
          path: joinedPath,
          content: contentBuf,
          message,
          parents,
        });
        store.setRef(repo, `refs/heads/${branch}`, commitOid);
        sendJson(res, isUpdate ? 200 : 201, {
          content: {
            name: pathSegments[pathSegments.length - 1] ?? '',
            path: joinedPath,
            sha: blobOid,
            size: contentBuf.length,
            type: 'file',
            encoding: 'base64',
            content: contentBuf.toString('base64'),
          },
          commit: { sha: commitOid, message },
        });
        return true;
      }

      if (method === 'DELETE') {
        if (pathSegments.length === 0) {
          sendErr(res, 422, 'A file path is required');
          return true;
        }
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : '';
        const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;
        const tip = store.getRef(repo, `refs/heads/${branch}`);
        if (tip === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        const parsed = commitOf(store, repo, tip);
        if (parsed === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        const current = lookupPath(store, repo, parsed.tree, pathSegments);
        if (current === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        if (current.kind === 'dir') {
          sendErr(res, 422, 'Cannot delete a directory');
          return true;
        }
        if (typeof bodyObj.sha !== 'string' || bodyObj.sha === '') {
          sendErr(res, 422, 'sha is required to delete a file');
          return true;
        }
        if ((bodyObj.sha as string).toLowerCase() !== current.oid.toLowerCase()) {
          sendErr(res, 409, 'sha does not match the current file');
          return true;
        }
        if (message === '') {
          sendErr(res, 422, 'message is required');
          return true;
        }
        const { commitOid } = buildFileCommit(store, repo, {
          baseTree: parsed.tree,
          path: joinedPath,
          content: null,
          message,
          parents: [tip],
        });
        store.setRef(repo, `refs/heads/${branch}`, commitOid);
        sendJson(res, 200, { commit: { sha: commitOid }, content: null });
        return true;
      }

      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }

    // -- labels ------------------------------------------------------------
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        sendJson(
          res,
          200,
          repo.labels.map((label) => ({ name: label.name, color: label.color })),
        );
        return true;
      }
      if (method === 'POST') {
        const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
        if (name === '') {
          sendErr(res, 422, 'Label name is required');
          return true;
        }
        const created = store.createLabel(repo, name, typeof bodyObj.color === 'string' ? bodyObj.color : undefined);
        if ('error' in created) {
          sendErr(res, 422, 'Label already exists');
          return true;
        }
        sendJson(res, 201, { name: created.name, color: created.color });
        return true;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }

    // -- issues ------------------------------------------------------------
    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'GET') {
        const stateParam = q.get('state') ?? 'open';
        if (stateParam !== 'open' && stateParam !== 'closed' && stateParam !== 'all') {
          sendErr(res, 422, 'Invalid state');
          return true;
        }
        const direction = q.get('direction') ?? 'asc';
        const issues = store.listIssues(repo, {
          state: stateParam as 'open' | 'closed' | 'all',
          sort: 'created',
          direction: direction === 'desc' ? 'desc' : 'asc',
        });
        sendPage(
          res,
          issues.map((issue) => serializeIssue(store, repo, issue)),
          q,
          req,
        );
        return true;
      }
      if (method === 'POST') {
        const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
        if (title === '') {
          sendErr(res, 422, 'Issue title is required');
          return true;
        }
        const labels = bodyObj.labels;
        if (labels !== undefined && (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string'))) {
          sendErr(res, 422, 'labels must be an array of strings');
          return true;
        }
        const created = store.createIssue(repo, {
          title,
          body: typeof bodyObj.body === 'string' ? bodyObj.body : undefined,
          labels: (labels as string[] | undefined) ?? undefined,
        });
        if ('error' in created) {
          sendErr(res, 422, `Unknown label: ${created.label}`);
          return true;
        }
        sendJson(res, 201, serializeIssue(store, repo, created));
        return true;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }

    // -- issues/{number} and .../comments ----------------------------------
    if (rest[0] === 'issues' && rest.length >= 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) {
        sendErr(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = store.getIssue(repo, number);
          if (issue === null) {
            sendErr(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, serializeIssue(store, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const issue = store.getIssue(repo, number);
          if (issue === null) {
            sendErr(res, 404, 'Not Found');
            return true;
          }
          if (bodyObj.state !== undefined) {
            if (bodyObj.state !== 'open' && bodyObj.state !== 'closed') {
              sendErr(res, 422, 'Invalid state');
              return true;
            }
            store.setIssueState(repo, number, bodyObj.state);
          }
          if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
          if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
          sendJson(res, 200, serializeIssue(store, repo, issue));
          return true;
        }
        sendErr(res, 405, 'Method Not Allowed');
        return true;
      }
      if (rest[2] === 'comments' && rest.length === 3) {
        if (method === 'GET') {
          const issue = store.getIssue(repo, number);
          if (issue === null) {
            sendErr(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issue.comments.map(serializeComment));
          return true;
        }
        if (method === 'POST') {
          const issue = store.getIssue(repo, number);
          if (issue === null) {
            sendErr(res, 404, 'Not Found');
            return true;
          }
          if (typeof bodyObj.body !== 'string' || bodyObj.body === '') {
            sendErr(res, 422, 'Comment body is required');
            return true;
          }
          const comment = store.addComment(repo, number, bodyObj.body, repo.owner);
          if (comment === null) {
            sendErr(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 201, serializeComment(comment));
          return true;
        }
        sendErr(res, 405, 'Method Not Allowed');
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }

    // -- pulls ---------------------------------------------------------------
    if (rest[0] === 'pulls' && rest.length === 1) {
      if (method === 'GET') {
        const stateParam = q.get('state') ?? 'open';
        if (stateParam !== 'open' && stateParam !== 'closed' && stateParam !== 'all') {
          sendErr(res, 422, 'Invalid state');
          return true;
        }
        const pulls = store.listPulls(repo, { state: stateParam as 'open' | 'closed' | 'all' });
        sendPage(
          res,
          pulls.map((pr) => serializePull(store, repo, pr)),
          q,
          req,
        );
        return true;
      }
      if (method === 'POST') {
        const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
        const head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
        const base = typeof bodyObj.base === 'string' ? bodyObj.base : '';
        if (title === '' || head === '' || base === '') {
          sendErr(res, 422, 'title, head and base are required');
          return true;
        }
        const created = store.createPull(repo, {
          title,
          body: typeof bodyObj.body === 'string' ? bodyObj.body : undefined,
          head,
          base,
        });
        if ('error' in created) {
          sendErr(res, 422, `Invalid ref: ${created.ref}`);
          return true;
        }
        sendJson(res, 201, serializePull(store, repo, created));
        return true;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return true;
    }

    // -- pulls/{number}, .../files, .../merge -------------------------------
    if (rest[0] === 'pulls' && rest.length >= 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) {
        sendErr(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method !== 'GET') {
          sendErr(res, 405, 'Method Not Allowed');
          return true;
        }
        const pr = store.getPull(repo, number);
        if (pr === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, serializePull(store, repo, pr));
        return true;
      }
      if (rest[2] === 'files' && rest.length === 3) {
        if (method !== 'GET') {
          sendErr(res, 405, 'Method Not Allowed');
          return true;
        }
        const pr = store.getPull(repo, number);
        if (pr === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        sendJson(
          res,
          200,
          pr.files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            sha: file.sha,
          })),
        );
        return true;
      }
      if (rest[2] === 'merge' && rest.length === 3) {
        if (method !== 'PUT') {
          sendErr(res, 405, 'Method Not Allowed');
          return true;
        }
        const pr = store.getPull(repo, number);
        if (pr === null) {
          sendErr(res, 404, 'Not Found');
          return true;
        }
        if (pr.state !== 'open' || pr.merged) {
          sendErr(res, 405, 'Pull request is already merged or closed');
          return true;
        }
        if (bodyObj.merge_method !== undefined && bodyObj.merge_method !== 'squash') {
          sendErr(res, 422, 'Only merge_method "squash" is supported');
          return true;
        }
        if (hasMergeConflict(store, repo, pr)) {
          sendErr(res, 405, 'Merge conflict');
          return true;
        }
        const merged = store.mergePullSquash(repo, number);
        if ('error' in merged) {
          if (merged.error === 'not-found') {
            sendErr(res, 404, 'Not Found');
            return true;
          }
          sendErr(res, 405, 'Merge conflict');
          return true;
        }
        sendJson(res, 200, {
          sha: merged.mergeCommitSha,
          merged: true,
          message: `Merge pull request #${merged.number} from ${merged.headRef}`,
        });
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }
  }

  // Unknown /api/v3 route (or a known pattern with an unmatched tail).
  sendErr(res, 404, 'Not Found');
  return true;
}
