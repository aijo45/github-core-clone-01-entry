# DESIGN.md — github-core-clone-01 entry design contract

This file is the shared contract for all implementation subagents. Every module imports from
these interfaces. Do NOT invent a different shape: if a field or method is missing, add it here
(first) and in the implementing module, so all modules stay in sync.

## 0. Global rules (apply to every module)

- Node 22, TypeScript, stdlib only. No `node:` module outside the standard library. No git binary,
  no network calls from the forge itself (only main.ts talks to $MAKEFUN_ENV_URL).
- **Deterministic.** Never use `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`,
  or any wall-clock / random value in a response, an id, or stored state. All ids come from
  counters in the store or from SHA-1/SHA-256 of deterministic inputs. Replay must be
  byte-identical. (Local profiling with `performance.now()` is fine in throwaway scripts only,
  never in the entry source.)
- All JSON responses under `/api/v3` carry `Content-Type: application/json` and a non-empty
  `X-GitHub-Request-Id` header. The request id is deterministic: `req-<n>` where `<n>` is a
  per-process counter starting at 1, incremented per request (any deterministic scheme is fine).
- Auth: every `/api/v3`, `/api/graphql`, `/mcp`, and git endpoint requires
  `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`. The token value is read from the environment
  variable `MAKEFUN_SHOP_TOKEN` at server start (if unset, accept any non-empty Bearer token so
  local smoke tests work; the suite always sends the real token). Missing or wrong token ->
  `401 {"message": "..."}`. `/healthz` needs no auth.
- Errors are JSON `{"message": "..."}` with the right status: 400 malformed JSON, 401 auth,
  404 not found (unknown route or missing/foreign-owner resource), 405 method not allowed
  (e.g. PR merge conflict), 409 stale sha / conflict, 422 validation (duplicate repo, unknown
  label, bad input). Never HTML. Never leak a stack trace.
- `X-OAuth-Scopes: repo, read:org` on `GET /api/v3` (and `/api/v3/`).
- Pagination: `per_page` (default 30) and `page` (default 1) query params; `Link` header in
  GitHub format (`<url>; rel="next"`, `<url>; rel="last"`) when there is a next page.
- File layout (all under the entry repo root):
  - `main.ts` — DO NOT MODIFY. Lifecycle only.
  - `app.ts` — HTTP server + routing. Wires store + git + rest + graphql + mcp.
  - `src/model.ts` — types + deterministic id helpers.
  - `src/store.ts` — `ForgeStore` (the single source of truth).
  - `src/json.ts` — strict JSON body parser + `sendJson`/`sendError` helpers + request-id.
  - `src/fixtures.ts` — git object builders used by contents PUT and PR squash merge.
  - `src/rest.ts` — REST v3 handlers (takes a `ForgeStore`, returns a router).
  - `src/graphql.ts` — GraphQL subset executor + introspection + resolvers.
  - `src/mcp.ts` — MCP JSON-RPC 2.0 transport + handshake + tool registry.
  - `src/git/pkt.ts` — pkt-line reader/writer, flush/delim/response-end, side-band framing.
  - `src/git/objects.ts` — blob/tree/commit/tag encode/decode, SHA-1, loose object store.
  - `src/git/refs.ts` — ref namespace, ancestry (is-ancestor), fast-forward check.
  - `src/git/pack-read.ts` — packfile parser (v2/v3, OFS/REF delta, zlib).
  - `src/git/pack-write.ts` — reachable-object traversal, packfile generation (non-delta ok).
  - `src/git/smart-http.ts` — info/refs, upload-pack (v0 + v2), receive-pack (v0).

## 1. Types (`src/model.ts`)

```ts
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
  author: string;    // raw "Name <email> ts tz" line as received
  committer: string; // raw line as received
  message: string;   // raw message bytes as string (utf8, may contain arbitrary bytes; keep raw)
}

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "040000"
  name: string;
  oid: Sha1;
}

export interface Repo {
  id: number;            // sequential per store, starts at 1
  name: RepoName;
  owner: Owner;
  fullName: string;      // "owner/name"
  description: string;
  isPrivate: boolean;
  defaultBranch: BranchName; // "main"
  hasIssues: boolean;    // true
  // git state
  objects: Map<Sha1, GitObject>;
  refs: Map<string, Sha1>; // "refs/heads/main" -> sha, "refs/tags/v1" -> sha
  // counters (per repo)
  issueCounter: number;  // next issue number (starts at 1)
  prCounter: number;     // next PR number (starts at 1)
  commentCounter: number;
  issues: Issue[];
  labels: Label[];
  pulls: PullRequest[];
}

export interface Label { name: string; color: string; }

export interface Issue {
  id: number;        // global sequential id (store-wide counter)
  number: number;    // per-repo, starts at 1
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];  // label names
  user: string;      // owner login
  comments: Comment[];
  seq: number;       // creation sequence (store-wide counter) for stable sort
}

export interface Comment {
  id: number;
  number: number;    // per-repo comment sequence (not used by REST shape)
  issueNumber: number;
  body: string;
  user: string;
}

export interface PullRequest {
  id: number;
  number: number;    // per-repo, starts at 1
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
  files: PrFile[];   // computed at create time from head vs base tree diff
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
```

Deterministic ids:
- `globalId(kind: string, repoId: number, localId: number): string` — `SHA-256(kind + ':' + repoId + ':' + localId)` hex, prefixed, e.g. `R_` + first 24 hex chars. Used for GraphQL `id` fields and REST `id` where a global id is needed. The store keeps a reverse map `globalId -> {kind, repoId, localId}` for `node(id:)`.
- `requestId(n: number): string` — `"req-" + n`.

## 2. ForgeStore (`src/store.ts`)

Single class, the ONLY place that mutates domain state. All handlers (REST, GraphQL, MCP, git)
call these methods; they never touch each other's private maps.

```ts
export class ForgeStore {
  // auth
  token: string; // MAKEFUN_SHOP_TOKEN from env (or "" if unset)
  checkAuth(req: IncomingMessage): boolean; // Bearer token equals this.token (or any non-empty if token=="")

  // repos
  createRepo(owner: Owner, name: RepoName, opts: { description?: string; isPrivate?: boolean }): Repo | { error: 'duplicate' };
  getRepo(owner: Owner, name: RepoName): Repo | null;
  listRepos(owner: Owner): Repo[];
  deleteRepo(owner: Owner, name: RepoName): boolean;
  updateRepo(owner: Owner, name: RepoName, patch: { description?: string }): Repo | null;

  // git objects & refs (thin wrappers over the repo's maps; the git modules do the
  // heavy parsing, the store owns the maps)
  putObject(repo: Repo, obj: GitObject): Sha1; // computes sha1("<type> <len>\0"+raw), stores, returns oid
  getObject(repo: Repo, oid: Sha1): GitObject | null;
  getRef(repo: Repo, ref: string): Sha1 | null;
  setRef(repo: Repo, ref: string, oid: Sha1): void;
  deleteRef(repo: Repo, ref: string): boolean;
  listRefs(repo: Repo): Array<{ name: string; oid: Sha1 }>; // sorted by name; includes HEAD symref target separately

  // issues / labels / comments
  createLabel(repo: Repo, name: string, color?: string): Label | { error: 'duplicate' };
  getLabel(repo: Repo, name: string): Label | null;
  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue | { error: 'unknown-label'; label: string };
  getIssue(repo: Repo, number: number): Issue | null;
  listIssues(repo: Repo, opts: { state?: 'open' | 'closed' | 'all'; sort?: 'created'; direction?: 'asc' | 'desc' }): Issue[];
  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue | null;
  addComment(repo: Repo, issueNumber: number, body: string, user: string): Comment | null;

  // pulls
  createPull(repo: Repo, input: { title: string; body?: string; head: BranchName; base: BranchName }): PullRequest | { error: 'bad-ref'; ref: string };
  getPull(repo: Repo, number: number): PullRequest | null;
  listPulls(repo: Repo, opts: { state?: 'open' | 'closed' | 'all' }): PullRequest[];
  mergePullSquash(repo: Repo, number: number): PullRequest | { error: 'not-found' } | { error: 'conflict' };
  // mergePullSquash: creates ONE new commit on base branch whose tree = head tree, message
  // "Merge pull request #N from <head>" (deterministic author/committer: "forge <forge@local> 0 +0000"),
  // sets base ref to it, marks PR closed+merged, mergedAt = "1970-01-01T00:00:00Z",
  // mergeCommitSha = new commit oid. Conflict if head tree cannot be applied (for MVP: never
  // conflict unless head ref missing — the suite's conflict case is a PR whose head was deleted;
  // return {error:'conflict'} then).

  // global ids
  globalId(kind: string, repoId: number, localId: number): string;
  resolveGlobalId(gid: string): { kind: string; repoId: number; localId: number } | null;

  // counters (store-wide, sequential, deterministic)
  nextSeq(): number; // creation sequence for issues/PRs (stable sort)
  nextId(): number;  // global object id counter
}
```

Notes:
- Repo `id` is a store-wide sequential number (1, 2, 3, ...).
- Issue `id` and PR `id` are store-wide sequential numbers (share one counter via `nextId()`).
- When a repo is deleted, its issues/PRs/objects go with it (remove from maps).
- `listIssues` default sort is `created` ascending by `seq`; `direction=desc` reverses. `state=open`
  is the default filter; `state=all` returns both.
- `createPull` computes `files` by diffing head tree vs base tree (flatten both trees to
  path->blob maps; added/modified/removed; additions/deletions counted by lines of the blob
  content — count `\n` in the new blob for additions, in the old blob for deletions; for a
  binary/empty blob use 0). `headSha`/`baseSha` are the current tip commits of those branches.
  `mergeable` is true unless the head branch is missing.

## 3. JSON helpers (`src/json.ts`)

```ts
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string,string>): void;
// Always sets content-type application/json; charset=utf-8, content-length, and
// x-github-request-id (from the per-request counter passed in, or generated).
export function sendError(res: ServerResponse, status: number, message: string, reqId: string): void;
// sendJson(status, { message }, { 'x-github-request-id': reqId })
export async function readJsonBody(req: IncomingMessage, limitBytes?: number): Promise<{ ok: true; value: unknown } | { ok: false; error: 'malformed' | 'empty' | 'too-large' }>;
// Reads the full body (default limit 8 MiB). Malformed JSON -> {ok:false,error:'malformed'}.
// Empty body -> {ok:false,error:'empty'} (callers that allow an empty body treat it as {}).
```

## 4. Git modules (`src/git/`)

### pkt.ts
```ts
export class PktWriter {
  static pkt(payload: Buffer | string): Buffer;      // 4-hex length + payload
  static flush(): Buffer;                            // "0000"
  static delim(): Buffer;                            // "0001"
  static responseEnd(): Buffer;                      // "0002"
  static sideband(channel: 1|2|3, data: Buffer): Buffer; // pkt(channelByte + data)
}
export class PktReader {
  constructor(buf: Buffer);
  // Iterate pkt-lines. Returns { kind: 'pkt', data: Buffer } | { kind: 'flush' } |
  // { kind: 'delim' } | { kind: 'response-end' }. Throws on truncation/bad length.
  next(): ...;
  rest(): Buffer; // unread bytes (e.g. the packfile after the pkt section)
}
```

### objects.ts
```ts
export function sha1Object(type: string, raw: Buffer): Sha1; // sha1("<type> <len>\0" + raw)
export function encodeCommit(c: { tree: Sha1; parents: Sha1[]; author: string; committer: string; message: string }): Buffer;
export function parseCommit(raw: Buffer): CommitData;
export function encodeTree(entries: TreeEntry[]): Buffer;
export function parseTree(raw: Buffer): TreeEntry[];
export function flattenTree(repo: Repo, treeOid: Sha1): Map<string, { oid: Sha1; mode: string }>; // path -> blob (recursive)
export function buildTreeFromFiles(files: Map<string, Buffer>): { rootOid: Sha1; objects: GitObject[] };
// buildTreeFromFiles: builds blob objects + nested trees bottom-up; returns the root tree oid
// and every object created (caller puts them in the store). Deterministic: entries sorted by name.
```

### refs.ts
```ts
export function isAncestor(repo: Repo, ancestor: Sha1, descendant: Sha1): boolean;
// Walk parents from descendant; true if ancestor is reached (or ancestor === descendant).
export function isFastForward(repo: Repo, oldOid: Sha1, newOid: Sha1): boolean;
// old === zero (create) -> true; otherwise old must be ancestor of new.
export const ZERO_OID: string; // 40 zeros
```

### pack-read.ts
```ts
export function parsePack(buf: Buffer): GitObject[];
// Parses a packfile (PACK v2/v3): headers, zlib streams, OFS_DELTA / REF_DELTA with
// recursive resolution + memoization. Returns the decoded objects (caller stores them
// via store.putObject). Validates the trailer checksum (throw on mismatch).
```

### pack-write.ts
```ts
export function collectReachable(repo: Repo, tips: Sha1[], opts?: { depth?: number }): Map<Sha1, GitObject>;
// Walk commits from tips (following parents, up to `depth` generations if given),
// collecting commits + their trees + blobs. Depth 1 = tip commit + its tree/blobs only.
// Returns oid -> object (already in store).
export function writePack(objects: Map<Sha1, GitObject> | GitObject[]): Buffer;
// Non-delta pack: "PACK" + version 2 + count + per object (varint size/type header +
// zlib(raw)) + trailer sha1 of all preceding bytes. Deterministic object order: sort by oid.
```

### smart-http.ts
```ts
export function createGitRouter(store: ForgeStore): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
// Returns true if the path was a git route (handled), false otherwise.
// Routes:
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack   (v0 + v2 via Git-Protocol header)
//   GET  /<owner>/<repo>.git/info/refs?service=git-receive-pack  (v0)
//   POST /<owner>/<repo>.git/git-upload-pack                      (v0 + v2)
//   POST /<owner>/<repo>.git/git-receive-pack                     (v0)
// Auth: same Bearer check as REST. Missing repo -> 404 JSON (not a git advertisement).
// Content types: advertisement upload "application/x-git-upload-pack-advertisement",
//   receive "application/x-git-receive-pack-advertisement",
//   POST upload "application/x-git-upload-pack-result",
//   POST receive "application/x-git-receive-pack-result".
// v0 upload advertisement: "# service=git-upload-pack\n" pkt + flush + ref lines; first ref
//   carries capabilities after NUL: "side-band-64k ofs-delta thin-pack multi_ack_detailed shallow".
// v2 advertisement (request header Git-Protocol: version=2): first pkt "version 2", then
//   "ls-refs", "fetch=shallow", "server-option", "object-format=sha1", flush.
// v2 fetch: parse want/have/done/deepen/thin-pack/ofs-delta/sideband-all; reply delim +
//   "packfile" + sideband channel-1 pack + flush/end. Depth 1 = tip only.
// v2 ls-refs: parse symrefs/peel/ref-prefix; emit oid + name lines (+ symref + peeled).
// receive-pack: parse "<old> <new> <ref>\0caps" lines + pack; validate fast-forward per ref
//   (mixed batch: apply the ones that pass, reject the rest with ng + reason); reply
//   sideband channel 1 with "unpack ok" + per-ref "ok <ref>" / "ng <ref> <reason>".
```

## 5. REST (`src/rest.ts`)

```ts
export function createRestRouter(store: ForgeStore): (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) => Promise<boolean>;
// Handles every /api/v3 route in the Hermes plan §5 table. Returns true if handled.
// Key shapes:
//   Repo object: { id, name, full_name, owner: { login }, private, description, default_branch, has_issues: true }
//   Issue object: { id, number, title, body, state, labels: [{name}], user: { login }, comments: <count>, url }
//   Comment object: { id, body, user: { login } }
//   PR object: { id, number, title, body, state, merged, merged_at, merge_commit_sha, head: { ref, sha }, base: { ref, sha }, mergeable, user: { login } }
//   Branch: { name, commit: { sha } }
//   Commit (list item): { sha, commit: { message, author: { name, email, date }, committer: {...} }, parents: [{sha}] }
//     (date is deterministic: "1970-01-01T00:00:00Z" — never wall clock.)
//   Contents file: { type: "file", name, path, sha, size, content: base64, encoding: "base64" }
//   Contents dir: array of { type: "file"|"dir", name, path, sha }
//   Ref object: { ref: "refs/heads/x", sha, object: { type: "commit", sha } }
// Contents PUT: body { message, content (base64), branch?, sha? } -> 201 create / 200 update;
//   stale sha -> 409. Creates blob + tree + commit (author/committer "forge <forge@local> 0 +0000"),
//   updates the branch ref. DELETE { message, sha, branch? } -> 200 { commit: { sha } }.
//   GET file decodes base64 byte-exact; GET dir lists the tree at that path.
// GET /api/v3/repos/{o}/{r}/git/refs: list refs. POST { ref, sha } -> 201 (validate the sha exists).
// GET /api/v3/repos/{o}/{r}/commits?sha=<branch>: walk parents from the branch tip (newest first).
// GET /api/v3/repos/{o}/{r}/pulls/{n}/files: the PR's computed files array.
// PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge { merge_method: "squash" } -> 200 { sha, merged: true, message };
//   unknown PR -> 404; already merged / conflict -> 405 {"message": ...}.
// GET /api/v3/meta -> 200 { installed_version: "1.0.0", ... } (installed_version non-empty).
// GET /api/v3/user/repos: list repos owned by the token user (all repos, since one token user).
```

## 6. GraphQL (`src/graphql.ts`)

```ts
export function createGraphqlHandler(store: ForgeStore): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
// POST /api/graphql. Body { query, variables?, operationName? }. Auth 401 if missing/wrong.
// Subset lexer/parser: operations, aliases, variables ($x), arguments, selection sets,
// list/object literals, fragment spreads (support at least inline fragments on the types
// the kit's graphql-client sends — read sdk/conformance/graphql-client.ts for the exact
// documents). Do NOT regex the raw query; tokenize then walk the field tree.
// Resolvers (minimum):
//   viewer { login }                       -> token owner login ("forge" if unset)
//   repository(owner, name)                -> Repository or null (no error)
//   Repository: id, databaseId, name, nameWithOwner, owner { login }, defaultBranchRef { name },
//     viewerPermission, hasIssuesEnabled, issue(number), issues(first, after, states, orderBy),
//     pullRequests(first), pullRequest(number)
//   Issue: id, number, title, state, body
//   PullRequest: id, number, headRefName, baseRefName, mergeable, state, merged, files { nodes { path } }
//   SearchType enum: ISSUE (introspection)
//   __type(name: "Issue") / __type(name: "PullRequest") / __type(name: "Repository") -> fields lists
//   Mutations: createIssue, closeIssue, createPullRequest, mergePullRequest (SQUASH),
//     addComment — all through the store (same objects as REST).
//   node(id:) -> repository by global id (round-trip stable).
//   Connections: { nodes, pageInfo { hasNextPage, endCursor } }; issues order CREATED_AT DESC,
//     tie number DESC; states:[OPEN] excludes closed.
//   Batch: two operation documents in one body answered in order (array response if the
//     client sends an array; otherwise run both and return the first's shape — read the
//     kit's graphql-client.ts to confirm which the suite sends).
// Errors: unknown field -> HTTP 200 { errors: [{ message }] } (no data for that field).
//   Unknown repository -> { data: { repository: null } } with no errors.
// Introspection responses are static but must match the resolvers.
```

## 7. MCP (`src/mcp.ts`)

```ts
export function createMcpHandler(store: ForgeStore): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
// POST /mcp. JSON-RPC 2.0 Streamable HTTP, application/json responses.
// Auth 401 if missing/wrong. Invalid JSON body -> HTTP 400 + JSON-RPC -32700.
// Unknown method/tool -> -32601 / -32602 (never HTTP 500). Answer within 3s.
// Handshake: modern `server/discover` returns result.supportedVersions including "2026-07-28";
//   legacy `initialize` (protocolVersion "2025-11-25" or older) returns protocolVersion echo +
//   capabilities + serverInfo; `notifications/initialized` is a notification (no response).
//   Optional Mcp-Session-Id header echoed if sent.
// tools/list: deterministic byte-identical across calls. Cache the JSON once.
//   Six tools (suffix match is case-insensitive; plain names are fine):
//   create_repo {name, description?, private?} / get_repo {owner, repo} /
//   create_issue {owner, repo, title, body?} / list_issues {owner, repo, state?} /
//   create_pull_request {owner, repo, title, head, base, body?} /
//   merge_pull_request {owner, repo, pull_number}
//   Each has non-empty description and inputSchema { type: "object", properties, required }.
// tools/call: echo the request id; missing required args -> isError:true or -32602.
//   Result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent?: payload }.
//   Effects must be visible via REST with the same ids.
// Concurrency: never share mutable request/response state between concurrent calls.
```

## 8. app.ts wiring

```ts
createApp(): Server
// - per-request counter (for x-github-request-id), starting at 1.
// - read the full body for POST/PUT/PATCH (limit 8 MiB) before routing.
// - GET /healthz -> 200 { ok: true } (no auth).
// - GET /api/v3 and /api/v3/ -> 200 API root + x-oauth-scopes (no auth needed? the starter
//   answers it without auth — keep that).
// - /api/v3/* -> rest router (auth enforced inside).
// - POST /api/graphql -> graphql handler.
// - POST /mcp -> mcp handler.
// - /<owner>/<repo>.git/* -> git router.
// - anything else -> 404 { message: "Not Found" } with request id.
// The server must survive 404/401/409/405/422 and malformed bodies without crashing.
```

## 9. Testing

- Local smoke: `MAKEFUN_SHOP_TOKEN=test node --experimental-strip-types main.ts` won't work
  without an env URL; instead test the server directly: a small script that imports
  `createApp()`, listens on an ephemeral port, and curls it (healthz, root, 404, auth).
- Kit conformance (no perf): from the kit dir,
  `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<port> --token "$MAKEFUN_SHOP_TOKEN" --json`
  (parse the per-check JSON; exit 0 does not mean all pass).
- Full local grade: `node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process`
  (try `--driver docker` first per the task; fall back to `process` if docker is unavailable).
- Practice trials: practice/trial-0, trial-1, trial-2 (scenario seeds in reference/scenario.json).
