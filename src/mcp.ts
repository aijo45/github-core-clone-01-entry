// MCP JSON-RPC 2.0 Streamable HTTP endpoint for POST /mcp (DESIGN.md §7).
// Fresh implementation, stdlib only. Stateless: no session is minted, no
// mutable state is shared between concurrent calls; the six tools are built
// once and frozen, so tools/list is byte-identical on every call. Every tool
// effect goes through ForgeStore, so MCP-created objects are the same objects
// REST and GraphQL read, with the same ids.
//
// Protocol eras supported:
//   modern 2026-07-28: server/discover -> supportedVersions (incl. 2026-07-28),
//     capabilities, serverInfo; every request may declare its revision in
//     _meta and in the MCP-Protocol-Version header.
//   legacy 2025-11-25 and older: initialize (protocolVersion echo) +
//     capabilities + serverInfo; notifications/initialized is a notification
//     and gets no response body.
// Deterministic: no clock, no randomness, no UUIDs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './json.ts';
import type { ForgeStore } from './store.ts';
import type { Issue, PullRequest, Repo } from './model.ts';
import { viewerLoginOf } from './graphql.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });
const bool = (description: string): { type: string; description: string } => ({ type: 'boolean', description });

/** The six tools, built once and frozen: tools/list is byte-identical per call. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a repository owned by the token user.',
    {
      name: str('The repository name.'),
      description: str('A short description of the repository.'),
      private: bool('Whether the repository is private.'),
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      title: str('The issue title.'),
      body: str('The issue body.'),
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      state: str('Issue state filter: open, closed, or all.'),
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      title: str('The pull request title.'),
      head: str('The head branch name.'),
      base: str('The base branch name.'),
      body: str('The pull request body.'),
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Squash-merge a pull request.',
    {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);




// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorShape(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string';
}

function checkAuth(store: ForgeStore, req: IncomingMessage): boolean {
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.checkAuth === 'function') {
    try {
      return (s.checkAuth as (r: IncomingMessage) => boolean)(req) === true;
    } catch {
      return false;
    }
  }
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = typeof s.token === 'string' ? s.token : '';
  if (token === '') return match[1]!.trim() !== '';
  return match[1] === token;
}

async function readBodyText(req: IncomingMessage): Promise<string | null> {
  const extra = req as unknown as Record<string, unknown>;
  if (typeof extra.rawBody === 'string') return extra.rawBody;
  if (typeof extra.body === 'string') return extra.body;
  if (extra.body !== undefined && extra.body !== null && typeof extra.body === 'object') {
    try {
      return JSON.stringify(extra.body);
    } catch {
      return null;
    }
  }
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Shared sendJson, plus the Mcp-Session-Id echo when the client sent one. */
function sendMcpJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const headers: Record<string, string> = {};
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string' && sessionId !== '') headers['mcp-session-id'] = sessionId;
  sendJson(res, status, body, headers);
}

// ---------------------------------------------------------------------------
// REST-shaped payloads (same ids as REST: the store's numeric ids)
// ---------------------------------------------------------------------------

function repoPayload(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
  };
}

function issuePayload(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user },
    comments: issue.comments.length,
  };
}

function prPayload(pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    mergeable: pr.mergeable,
  };
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

type RpcResult = Record<string, unknown>;
type RpcError = { code: number; message: string; data?: unknown };

function toolOk(payload: unknown): RpcResult {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
}

function toolErr(message: string): RpcResult {
  const payload = { error: message };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function rpcError(code: number, message: string, data?: unknown): RpcError {
  const err: RpcError = { code, message };
  if (data !== undefined) err.data = data;
  return err;
}

/** Missing-required-argument check; returns the missing names (empty = ok). */
function missingArgs(args: Record<string, unknown>, required: string[]): string[] {
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function getRepoOrNull(store: ForgeStore, args: Record<string, unknown>): Repo | 'missing-arg' | null {
  const owner = asNonEmptyString(args.owner);
  const repoName = asNonEmptyString(args.repo);
  if (owner === null || repoName === null) return 'missing-arg';
  return store.getRepo(owner, repoName);
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): { result: RpcResult } | { error: RpcError } {
  switch (name) {
    case 'create_repo': {
      const missing = missingArgs(args, ['name']);
      if (missing.length > 0) return { result: toolErr(`Missing required argument: ${missing.join(', ')}`) };
      const repoName = asNonEmptyString(args.name);
      if (repoName === null) return { result: toolErr('Missing required argument: name') };
      const created = store.createRepo(viewerLoginOf(store), repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        isPrivate: args.private === true,
      });
      if (hasErrorShape(created)) return { result: toolErr(`Repository already exists: ${repoName}`) };
      return { result: toolOk(repoPayload(created)) };
    }
    case 'get_repo': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length > 0) return { result: toolErr(`Missing required argument: ${missing.join(', ')}`) };
      const repo = getRepoOrNull(store, args);
      if (repo === 'missing-arg') return { result: toolErr('Missing required argument: owner, repo') };
      if (repo === null) return { result: toolErr(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      return { result: toolOk(repoPayload(repo)) };
    }
    case 'create_issue': {
      const missing = missingArgs(args, ['owner', 'repo', 'title']);
      if (missing.length > 0) return { result: toolErr(`Missing required argument: ${missing.join(', ')}`) };
      const repo = getRepoOrNull(store, args);
      if (repo === 'missing-arg') return { result: toolErr('Missing required argument: owner, repo') };
      if (repo === null) return { result: toolErr(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const title = asNonEmptyString(args.title);
      if (title === null) return { result: toolErr('Missing required argument: title') };
      const created = store.createIssue(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      if (hasErrorShape(created)) return { result: toolErr(`Could not create issue: ${created.error}`) };
      return { result: toolOk(issuePayload(created)) };
    }
    case 'list_issues': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length > 0) return { result: toolErr(`Missing required argument: ${missing.join(', ')}`) };
      const repo = getRepoOrNull(store, args);
      if (repo === 'missing-arg') return { result: toolErr('Missing required argument: owner, repo') };
      if (repo === null) return { result: toolErr(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const rawState = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const state: 'open' | 'closed' | 'all' = rawState === 'closed' ? 'closed' : rawState === 'all' ? 'all' : 'open';
      const issues = store.listIssues(repo, { state });
      return { result: toolOk(issues.map((issue) => issuePayload(issue))) };
    }
    case 'create_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing.length > 0) return { result: toolErr(`Missing required argument: ${missing.join(', ')}`) };
      const repo = getRepoOrNull(store, args);
      if (repo === 'missing-arg') return { result: toolErr('Missing required argument: owner, repo') };
      if (repo === null) return { result: toolErr(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const head = asNonEmptyString(args.head);
      const base = asNonEmptyString(args.base);
      const title = asNonEmptyString(args.title);
      if (head === null || base === null || title === null) {
        return { result: toolErr('Missing required argument: title, head, base') };
      }
      const created = store.createPull(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : undefined,
        head,
        base,
      });
      if (hasErrorShape(created)) return { result: toolErr(`Could not create pull request: ${created.error}`) };
      return { result: toolOk(prPayload(created)) };
    }
    case 'merge_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'pull_number']);
      if (missing.length > 0) return { result: toolErr(`Missing required argument: ${missing.join(', ')}`) };
      const repo = getRepoOrNull(store, args);
      if (repo === 'missing-arg') return { result: toolErr('Missing required argument: owner, repo') };
      if (repo === null) return { result: toolErr(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const number = asInt(args.pull_number);
      if (number === null) return { result: toolErr('Missing required argument: pull_number') };
      const pr = store.getPull(repo, number);
      if (pr === null) return { result: toolErr(`Pull request not found: #${number}`) };
      const merged = store.mergePullSquash(repo, number);
      if (hasErrorShape(merged)) return { result: toolErr(`Could not merge pull request #${number}: ${merged.error}`) };
      return { result: toolOk(prPayload(merged)) };
    }
    default:
      return { error: rpcError(INVALID_PARAMS, `Unknown tool: ${name}`) };
  }
}

// ---------------------------------------------------------------------------
// One JSON-RPC message -> response object, or null for a notification
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function discoverResult(): Record<string, unknown> {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

function handleOne(store: ForgeStore, message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) {
    return { jsonrpc: '2.0', id: null, error: rpcError(INVALID_REQUEST, 'Invalid Request') };
  }
  const id: JsonRpcId =
    message.id === undefined ? null : typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
  const hasId = message.id !== undefined && message.id !== null;
  const method = message.method;
  if (typeof method !== 'string' || method === '') {
    if (!hasId) return null;
    return { jsonrpc: '2.0', id, error: rpcError(INVALID_REQUEST, 'Invalid Request: missing method') };
  }
  // Notifications (no id) never get a response.
  if (!hasId) return null;
  const params = isRecord(message.params) ? message.params : {};

  // Revision declared in _meta / header must be one we speak (initialize is
  // exempt: its own protocolVersion param is the negotiation).
  if (method !== 'initialize') {
    const meta = isRecord(params._meta) ? params._meta : {};
    const declared =
      typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
        ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
        : typeof meta.protocolVersion === 'string'
          ? (meta.protocolVersion as string)
          : null;
    if (declared !== null && !SUPPORTED_VERSIONS.includes(declared)) {
      return {
        jsonrpc: '2.0',
        id,
        error: rpcError(UNSUPPORTED_VERSION, `Unsupported protocol version: ${declared}`, { supported: [...SUPPORTED_VERSIONS] }),
      };
    }
  }

  try {
    switch (method) {
      case 'server/discover':
        return { jsonrpc: '2.0', id, result: discoverResult() };
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
        if (offered === null || !SUPPORTED_VERSIONS.includes(offered)) {
          return { jsonrpc: '2.0', id, error: rpcError(INVALID_PARAMS, `Unsupported protocol version: ${String(offered ?? '')}`) };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: offered,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        // The tools array is built once and frozen; serializing the same
        // frozen objects keeps two calls byte-identical.
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        if (toolName === '') {
          return { jsonrpc: '2.0', id, error: rpcError(INVALID_PARAMS, 'tools/call requires a tool name') };
        }
        const outcome = callTool(store, toolName, args);
        if ('error' in outcome) return { jsonrpc: '2.0', id, error: outcome.error };
        return { jsonrpc: '2.0', id, result: outcome.result };
      }
      default:
        return { jsonrpc: '2.0', id, error: rpcError(METHOD_NOT_FOUND, `Method not found: ${method}`) };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: rpcError(INTERNAL_ERROR, err instanceof Error ? err.message : 'Internal error'),
    };
  }
}

// ---------------------------------------------------------------------------
// Handler (DESIGN.md §7)
// ---------------------------------------------------------------------------

export function createMcpHandler(store: ForgeStore): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === 'DELETE') {
        // Best-effort session close; this server mints no sessions.
        sendMcpJson(req, res, 200, {});
        return;
      }
      if (req.method !== 'POST') {
        sendMcpJson(req, res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!checkAuth(store, req)) {
        sendMcpJson(req, res, 401, { message: 'Unauthorized' });
        return;
      }
      const raw = await readBodyText(req);
      if (raw === null || raw.trim() === '') {
        sendMcpJson(req, res, 400, { jsonrpc: '2.0', id: null, error: rpcError(PARSE_ERROR, 'Parse error') });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        sendMcpJson(req, res, 400, { jsonrpc: '2.0', id: null, error: rpcError(PARSE_ERROR, 'Parse error') });
        return;
      }
      if (Array.isArray(parsed)) {
        const responses = parsed.map((entry) => handleOne(store, entry)).filter((entry) => entry !== null);
        sendMcpJson(req, res, 200, responses);
        return;
      }
      const response = handleOne(store, parsed);
      if (response === null) {
        // A notification (e.g. notifications/initialized): no response body.
        res.writeHead(202);
        res.end();
        return;
      }
      sendMcpJson(req, res, 200, response);
    } catch {
      try {
        sendMcpJson(req, res, 200, { jsonrpc: '2.0', id: null, error: rpcError(INTERNAL_ERROR, 'Internal error') });
      } catch {
        // The response is already gone; nothing left to do.
      }
    }
  };
}
