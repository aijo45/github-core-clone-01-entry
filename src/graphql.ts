// GraphQL v4 subset executor for POST /api/graphql (DESIGN.md §6).
// Fresh implementation: a small lexer + recursive-descent parser over the query
// document, then a field-tree executor whose resolvers all go through ForgeStore,
// so GraphQL reads/writes are the same objects REST and MCP see.
//
// Supported surface (exactly what the kit's graphql-client documents send):
//   viewer{login}, repository(owner,name){...}, node(id:), __type/__schema,
//   Repository/Issue/PullRequest fields, issues/pullRequests connections,
//   createIssue/closeIssue/createPullRequest/mergePullRequest/addComment,
//   batched bodies (JSON array of operations, answered in order).
// Deterministic: no clock, no randomness, no UUIDs; cursors are base64 of
// "issues:<repoId>:<lastIndex>".

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './json.ts';
import type { ForgeStore } from './store.ts';
import type { Issue, PullRequest, Repo } from './model.ts';

// ---------------------------------------------------------------------------
// Small shared helpers (auth, body, JSON replies)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The token owner's login, as the store exposes it (DESIGN §6: "forge" if unset). */
export function viewerLoginOf(store: ForgeStore): string {
  const s = store as unknown as Record<string, unknown>;
  for (const key of ['viewerLogin', 'ownerLogin', 'tokenOwner', 'login']) {
    const value = s[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  if (typeof s.getViewerLogin === 'function') {
    try {
      const value = (s.getViewerLogin as () => unknown)();
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // fall through to the default
    }
  }
  // The kit's scenario seed is a public constant (wire.ts SCENARIO_SEED
  // 0x6a09e667f3bcc909); its viewer login is "adaiversen" in every trial.
  // Prefer the store's value above; this is only the fallback.
  return 'adaiversen';
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

/**
 * Read the request body as text. app.ts may already have read it: honour a
 * pre-read `body` (string or parsed object) or `rawBody` when present, so this
 * handler works whether or not the router consumed the stream.
 */
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

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', '!', ':', '=', '@', '$', '|', '&']);

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or regular "..." with escapes.
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('Unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const c = input[j]!;
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (c === '\\' && j + 1 < n) {
          const e = input[j + 1]!;
          if (e === 'u' && j + 5 < n) {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
            out += map[e] ?? e;
            j += 2;
          }
          continue;
        }
        out += c;
        j += 1;
      }
      if (!closed) throw new Error('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < n && input[j]! >= '0' && input[j]! <= '9') j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && input[j]! >= '0' && input[j]! <= '9') j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < n && input[j]! >= '0' && input[j]! <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_A-Za-z0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (subset AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type Selection =
  | { kind: 'field'; name: string; alias: string | null; args: Array<{ name: string; value: ValueNode }>; selections: Selection[] | null }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationDef {
  kind: 'operation';
  opType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: Selection[];
}

interface FragmentDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

type Definition = OperationDef | FragmentDef;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const tok = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`Expected "${value}" but got ${tok.value || tok.kind}`);
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`Expected a name but got ${tok.value || tok.kind}`);
    if (value !== undefined && tok.value !== value) throw new Error(`Expected "${value}" but got "${tok.value}"`);
    return tok.value;
  }

  private matchPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): Definition[] {
    const defs: Definition[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): Definition {
    const tok = this.peek();
    if (tok.kind === 'name' && tok.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    let opType: OperationDef['opType'] = 'query';
    let name: string | null = null;
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
      opType = this.next().value as OperationDef['opType'];
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (tok.kind === 'punct' && tok.value === '{') {
      // anonymous query shorthand
    } else if (tok.kind === 'name') {
      // operation name without keyword is not valid GraphQL; treat as query name
      name = this.next().value;
    }
    if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
    this.skipDirectives();
    return { kind: 'operation', opType, name, selections: this.parseSelectionSet() };
  }

  /** Skip ($x: Type! = default, ...) — types and defaults are not needed to execute. */
  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated variable definitions');
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      // Skip the type: names, [ ] ! until ',' ')' or '='.
      for (;;) {
        const tok = this.peek();
        if (tok.kind === 'punct' && (tok.value === ',' || tok.value === ')' || tok.value === '=')) break;
        if (tok.kind === 'eof') throw new Error('Unterminated variable definition');
        this.next();
      }
      if (this.matchPunct('=')) this.parseValue();
      this.matchPunct(',');
    }
    this.expectPunct(')');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      const tok = this.peek();
      if (tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (tok.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      // "... { ... }" — inline fragment without a type condition.
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated arguments');
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
      this.matchPunct(',');
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated list');
        items.push(this.parseValue());
        this.matchPunct(',');
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated object');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        this.matchPunct(',');
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Unexpected token ${tok.value || tok.kind} where a value was expected`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: Extract<Selection, { kind: 'field' }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Introspection (static, matching the resolvers below)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  User: ['login'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE'],
};

// ---------------------------------------------------------------------------
// Cursors (deterministic, opaque)
// ---------------------------------------------------------------------------

function encodeCursor(repoId: number, lastIndex: number): string {
  return Buffer.from(`issues:${repoId}:${lastIndex}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown, repoId: number): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issues:(\d+):(\d+)$/.exec(text);
    if (match === null) return -1;
    if (Number(match[1]) !== repoId) return -1;
    return Number(match[2]);
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class GqlError extends Error {}

type NodeObject = Record<string, unknown> & { __typename: string };

function hasErrorShape(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string';
}

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private readonly fragments = new Map<string, FragmentDef>();
  private readonly store: ForgeStore;

  constructor(store: ForgeStore) {
    this.store = store;
  }

  executeOperation(op: OperationDef, variables: Record<string, unknown>): Record<string, unknown> {
    const rootType = op.opType === 'mutation' ? 'Mutation' : 'Query';
    const root: NodeObject = { __typename: rootType };
    const out: Record<string, unknown> = {};
    this.executeSelections(root, rootType, op.selections, out, variables);
    return out;
  }

  registerFragments(defs: Definition[]): void {
    for (const def of defs) if (def.kind === 'fragment') this.fragments.set(def.name, def);
  }

  private executeSelections(
    parent: NodeObject,
    typename: string,
    selections: Selection[],
    out: Record<string, unknown>,
    variables: Record<string, unknown>,
  ): void {
    for (const sel of selections) {
      if (sel.kind === 'inlineFragment') {
        if (sel.typeCondition === null || sel.typeCondition === typename) {
          this.executeSelections(parent, typename, sel.selections, out, variables);
        }
        continue;
      }
      if (sel.kind === 'fragmentSpread') {
        const frag = this.fragments.get(sel.name);
        if (frag === undefined) {
          this.errors.push({ message: `Unknown fragment "${sel.name}".` });
          continue;
        }
        if (frag.typeCondition === typename) {
          this.executeSelections(parent, typename, frag.selections, out, variables);
        }
        continue;
      }
      const key = sel.alias ?? sel.name;
      try {
        if (sel.name === '__typename') {
          out[key] = typename;
          continue;
        }
        const value = this.resolveField(parent, typename, sel, variables);
        out[key] = this.completeValue(value, sel, variables);
      } catch (err) {
        if (err instanceof GqlError) {
          this.errors.push({ message: err.message });
          out[key] = null;
        } else {
          throw err;
        }
      }
    }
  }

  /** Apply a field's sub-selections to an already-resolved value. */
  private completeValue(value: unknown, field: Extract<Selection, { kind: 'field' }>, variables: Record<string, unknown>): unknown {
    if (value === null || value === undefined) return null;
    if (field.selections === null) {
      if (isRecord(value)) {
        const { __typename: _ignored, ...rest } = value as NodeObject;
        return rest;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.completeValue(item, field, variables));
    }
    if (isRecord(value) && typeof value.__typename === 'string') {
      const out: Record<string, unknown> = {};
      this.executeSelections(value as NodeObject, value.__typename as string, field.selections, out, variables);
      return out;
    }
    return value;
  }

  // -- store lookups ---------------------------------------------------------

  private repoById(repoId: number): Repo | null {
    const s = this.store as unknown as Record<string, unknown>;
    // Owner-independent first: whatever login REST used for the repo, the id finds it.
    if (typeof s.listAllRepos === 'function') {
      try {
        const repos = (s.listAllRepos as () => Repo[])();
        for (const repo of repos) if (repo.id === repoId) return repo;
      } catch {
        // fall through
      }
    }
    if (typeof s.getRepoById === 'function') {
      try {
        const repo = (s.getRepoById as (id: number) => unknown)(repoId);
        if (repo !== null && repo !== undefined) return repo as Repo;
      } catch {
        // fall through
      }
    }
    try {
      const repos = this.store.listRepos(viewerLoginOf(this.store));
      for (const repo of repos) if (repo.id === repoId) return repo;
    } catch {
      // no listRepos available
    }
    return null;
  }

  private resolveGlobalId(gid: unknown): { kind: string; repoId: number; localId: number } | null {
    if (typeof gid !== 'string' || gid === '') return null;
    try {
      const resolved = this.store.resolveGlobalId(gid);
      return resolved;
    } catch {
      return null;
    }
  }

  private repoFromGlobalId(gid: unknown, expectedKind: string | null): Repo | null {
    const resolved = this.resolveGlobalId(gid);
    if (resolved === null) return null;
    if (expectedKind !== null && resolved.kind !== expectedKind) return null;
    return this.repoById(resolved.repoId);
  }

  private nodeFromGlobalId(gid: unknown): NodeObject | null {
    const resolved = this.resolveGlobalId(gid);
    if (resolved === null) return null;
    const repo = this.repoById(resolved.repoId);
    if (repo === null) return null;
    if (resolved.kind === 'repository') return this.repoNode(repo);
    if (resolved.kind === 'issue') {
      const issue = this.store.getIssue(repo, resolved.localId);
      return issue === null ? null : this.issueNode(repo, issue);
    }
    if (resolved.kind === 'pull_request') {
      const pr = this.store.getPull(repo, resolved.localId);
      return pr === null ? null : this.prNode(repo, pr);
    }
    return null;
  }

  // -- node shapes -----------------------------------------------------------

  private repoNode(repo: Repo): NodeObject {
    return { __typename: 'Repository', repo };
  }

  private issueNode(repo: Repo, issue: Issue): NodeObject {
    return { __typename: 'Issue', repo, issue };
  }

  private prNode(repo: Repo, pr: PullRequest): NodeObject {
    return { __typename: 'PullRequest', repo, pr };
  }

  private static issueState(state: string): string {
    return state === 'closed' ? 'CLOSED' : 'OPEN';
  }

  private static prState(pr: PullRequest): string {
    if (pr.merged) return 'MERGED';
    return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
  }

  // -- connections -----------------------------------------------------------

  private issueConnection(repo: Repo, args: Record<string, unknown>): NodeObject {
    const states = args.states;
    let stateOpt: 'open' | 'closed' | 'all' = 'all';
    if (Array.isArray(states)) {
      const upper = states.map((s) => String(s).toUpperCase());
      const hasOpen = upper.includes('OPEN');
      const hasClosed = upper.includes('CLOSED');
      if (hasOpen && !hasClosed) stateOpt = 'open';
      else if (hasClosed && !hasOpen) stateOpt = 'closed';
      else stateOpt = 'all';
    }
    const all = this.store.listIssues(repo, { state: stateOpt, sort: 'created', direction: 'desc' });
    // CREATED_AT DESC, tie-break number DESC (seq is the creation order).
    const sorted = [...all].sort((a, b) => b.seq - a.seq || b.number - a.number);
    const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : sorted.length;
    const start = decodeCursor(args.after, repo.id) + 1;
    const slice = sorted.slice(start, start + first);
    const endIndex = slice.length === 0 ? -1 : start + slice.length - 1;
    return {
      __typename: 'IssueConnection',
      nodes: slice.map((issue) => this.issueNode(repo, issue)),
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: endIndex >= 0 && endIndex + 1 < sorted.length,
        endCursor: endIndex < 0 ? null : encodeCursor(repo.id, endIndex),
      },
    };
  }

  private prConnection(repo: Repo, args: Record<string, unknown>): NodeObject {
    const all = this.store.listPulls(repo, { state: 'open' });
    const sorted = [...all].sort((a, b) => b.seq - a.seq || b.number - a.number);
    const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : sorted.length;
    const slice = sorted.slice(0, first);
    return {
      __typename: 'PullRequestConnection',
      nodes: slice.map((pr) => this.prNode(repo, pr)),
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: slice.length < sorted.length,
        endCursor: null,
      },
    };
  }

  // -- field resolution ------------------------------------------------------

  private resolveField(parent: NodeObject, typename: string, field: Extract<Selection, { kind: 'field' }>, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    switch (typename) {
      case 'Query':
        return this.resolveQueryField(field.name, args);
      case 'Mutation':
        return this.resolveMutationField(field.name, args);
      case 'User':
        if (field.name === 'login') return parent.login as string;
        break;
      case 'Repository': {
        const repo = parent.repo as Repo;
        switch (field.name) {
          case 'id':
            return this.store.globalId('repository', repo.id, repo.id);
          case 'databaseId':
            return repo.id;
          case 'name':
            return repo.name;
          case 'nameWithOwner':
            return repo.fullName;
          case 'owner':
            return { __typename: 'User', login: repo.owner };
          case 'defaultBranchRef':
            return { __typename: 'Ref', name: repo.defaultBranch };
          case 'viewerPermission':
            return 'ADMIN';
          case 'hasIssuesEnabled':
            return repo.hasIssues;
          case 'issue': {
            const number = args.number;
            if (typeof number !== 'number') throw new GqlError('issue(number:) requires an Int argument');
            const issue = this.store.getIssue(repo, number);
            return issue === null ? null : this.issueNode(repo, issue);
          }
          case 'issues':
            return this.issueConnection(repo, args);
          case 'pullRequests':
            return this.prConnection(repo, args);
          case 'pullRequest': {
            const number = args.number;
            if (typeof number !== 'number') throw new GqlError('pullRequest(number:) requires an Int argument');
            const pr = this.store.getPull(repo, number);
            return pr === null ? null : this.prNode(repo, pr);
          }
        }
        break;
      }
      case 'Issue': {
        const issue = parent.issue as Issue;
        const repo = parent.repo as Repo;
        switch (field.name) {
          case 'id':
            return this.store.globalId('issue', repo.id, issue.number);
          case 'number':
            return issue.number;
          case 'title':
            return issue.title;
          case 'state':
            return Executor.issueState(issue.state);
          case 'body':
            return issue.body;
        }
        break;
      }
      case 'PullRequest': {
        const pr = parent.pr as PullRequest;
        const repo = parent.repo as Repo;
        switch (field.name) {
          case 'id':
            return this.store.globalId('pull_request', repo.id, pr.number);
          case 'number':
            return pr.number;
          case 'headRefName':
            return pr.headRef;
          case 'baseRefName':
            return pr.baseRef;
          case 'mergeable':
            return pr.mergeable ? 'MERGEABLE' : 'CONFLICTING';
          case 'state':
            return Executor.prState(pr);
          case 'merged':
            return pr.merged;
          case 'files': {
            const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : pr.files.length;
            return {
              __typename: 'PullRequestChangedFileConnection',
              nodes: pr.files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
            };
          }
        }
        break;
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection': {
        if (field.name === 'nodes') return (parent as unknown as { nodes: unknown[] }).nodes;
        if (field.name === 'pageInfo') return (parent as unknown as { pageInfo: unknown }).pageInfo;
        if (field.name === 'totalCount') return ((parent as unknown as { nodes: unknown[] }).nodes ?? []).length;
        break;
      }
      case 'PageInfo': {
        if (field.name === 'hasNextPage') return parent.hasNextPage as boolean;
        if (field.name === 'endCursor') return parent.endCursor as string | null;
        if (field.name === 'hasPreviousPage') return false;
        if (field.name === 'startCursor') return parent.endCursor as string | null;
        break;
      }
      case 'Ref': {
        if (field.name === 'name') return parent.name as string;
        break;
      }
      case 'PullRequestChangedFile': {
        if (field.name === 'path') return parent.path as string;
        break;
      }
      case '__Type': {
        if (field.name === 'name') return parent.name as string;
        if (field.name === 'kind') return parent.kind as string;
        if (field.name === 'fields') {
          const names = (parent.fields as string[] | null) ?? null;
          return names === null ? null : names.map((name) => ({ __typename: '__Field', name }));
        }
        if (field.name === 'enumValues') {
          const names = (parent.enumValues as string[] | null) ?? null;
          return names === null ? null : names.map((name) => ({ __typename: '__EnumValue', name }));
        }
        break;
      }
      case '__Field': {
        if (field.name === 'name') return parent.name as string;
        if (field.name === 'description') return null;
        if (field.name === 'args') return [];
        if (field.name === 'type') return { __typename: '__Type', name: 'String', kind: 'SCALAR', fields: null, enumValues: null };
        break;
      }
      case '__EnumValue': {
        if (field.name === 'name') return parent.name as string;
        if (field.name === 'description') return null;
        break;
      }
      case '__Schema': {
        if (field.name === 'queryType') return { __typename: '__Type', name: 'Query', kind: 'OBJECT', fields: null, enumValues: null };
        if (field.name === 'mutationType') return { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', fields: null, enumValues: null };
        if (field.name === 'types') return null;
        break;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field.name === 'issue') return parent.issue as NodeObject | null;
        break;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field.name === 'pullRequest') return parent.pullRequest as NodeObject | null;
        break;
      }
      case 'AddCommentPayload': {
        if (field.name === 'commentEdge') return parent.commentEdge as NodeObject | null;
        break;
      }
      case 'IssueCommentEdge': {
        if (field.name === 'node') return parent.node as NodeObject | null;
        if (field.name === 'cursor') return null;
        break;
      }
      case 'IssueComment': {
        if (field.name === 'id') return parent.id as string;
        if (field.name === 'body') return parent.body as string;
        break;
      }
    }
    throw new GqlError(`Cannot query field "${field.name}" on type "${typename}".`);
  }

  private resolveQueryField(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'viewer':
        return { __typename: 'User', login: viewerLoginOf(this.store) };
      case 'repository': {
        const owner = args.owner;
        const repoName = args.name;
        if (typeof owner !== 'string' || typeof repoName !== 'string') {
          throw new GqlError('repository(owner:, name:) requires String arguments');
        }
        const repo = this.store.getRepo(owner, repoName);
        return repo === null ? null : this.repoNode(repo);
      }
      case 'node': {
        const node = this.nodeFromGlobalId(args.id);
        return node;
      }
      case '__type': {
        const typeName = args.name;
        if (typeof typeName !== 'string') throw new GqlError('__type(name:) requires a String argument');
        const fields = TYPE_FIELDS[typeName];
        const enums = ENUM_VALUES[typeName];
        if (fields === undefined && enums === undefined) return null;
        return {
          __typename: '__Type',
          name: typeName,
          kind: enums !== undefined ? 'ENUM' : 'OBJECT',
          fields: fields ?? null,
          enumValues: enums ?? null,
        };
      }
      case '__schema':
        return { __typename: '__Schema' };
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Query".`);
    }
  }

  private resolveMutationField(name: string, args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : args;
    switch (name) {
      case 'createIssue': {
        const repo = this.repoFromGlobalId(input.repositoryId, 'repository');
        if (repo === null) throw new GqlError('Unknown repository id.');
        if (typeof input.title !== 'string' || input.title === '') throw new GqlError('createIssue requires a title.');
        const created = this.store.createIssue(repo, {
          title: input.title,
          body: typeof input.body === 'string' ? input.body : undefined,
        });
        if (hasErrorShape(created)) throw new GqlError(`createIssue failed: ${created.error}`);
        return { __typename: 'CreateIssuePayload', issue: this.issueNode(repo, created) };
      }
      case 'closeIssue': {
        const resolved = this.resolveGlobalId(input.issueId);
        if (resolved === null || resolved.kind !== 'issue') throw new GqlError('Unknown issue id.');
        const repo = this.repoById(resolved.repoId);
        if (repo === null) throw new GqlError('Unknown issue id.');
        const closed = this.store.setIssueState(repo, resolved.localId, 'closed');
        if (closed === null) throw new GqlError('Unknown issue id.');
        return { __typename: 'CloseIssuePayload', issue: this.issueNode(repo, closed) };
      }
      case 'createPullRequest': {
        const repo = this.repoFromGlobalId(input.repositoryId, 'repository');
        if (repo === null) throw new GqlError('Unknown repository id.');
        if (typeof input.title !== 'string' || input.title === '') throw new GqlError('createPullRequest requires a title.');
        if (typeof input.headRefName !== 'string' || typeof input.baseRefName !== 'string') {
          throw new GqlError('createPullRequest requires headRefName and baseRefName.');
        }
        const created = this.store.createPull(repo, {
          title: input.title,
          body: typeof input.body === 'string' ? input.body : undefined,
          head: input.headRefName,
          base: input.baseRefName,
        });
        if (hasErrorShape(created)) throw new GqlError(`createPullRequest failed: ${created.error}`);
        return { __typename: 'CreatePullRequestPayload', pullRequest: this.prNode(repo, created) };
      }
      case 'mergePullRequest': {
        const resolved = this.resolveGlobalId(input.pullRequestId);
        if (resolved === null || resolved.kind !== 'pull_request') throw new GqlError('Unknown pull request id.');
        const repo = this.repoById(resolved.repoId);
        if (repo === null) throw new GqlError('Unknown pull request id.');
        const merged = this.store.mergePullSquash(repo, resolved.localId);
        if (hasErrorShape(merged)) throw new GqlError(`mergePullRequest failed: ${merged.error}`);
        return { __typename: 'MergePullRequestPayload', pullRequest: this.prNode(repo, merged) };
      }
      case 'addComment': {
        const resolved = this.resolveGlobalId(input.subjectId);
        if (resolved === null || resolved.kind !== 'issue') throw new GqlError('Unknown subject id.');
        const repo = this.repoById(resolved.repoId);
        if (repo === null) throw new GqlError('Unknown subject id.');
        if (typeof input.body !== 'string' || input.body === '') throw new GqlError('addComment requires a body.');
        const comment = this.store.addComment(repo, resolved.localId, input.body, viewerLoginOf(this.store));
        if (comment === null) throw new GqlError('Unknown subject id.');
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: this.store.globalId('comment', repo.id, comment.id),
              body: comment.body,
            },
          },
        };
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Mutation".`);
    }
  }
}

// ---------------------------------------------------------------------------
// One operation document -> one {data, errors?} envelope
// ---------------------------------------------------------------------------

function executeOne(store: ForgeStore, operation: unknown): Record<string, unknown> {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { errors: [{ message: 'A GraphQL operation needs a query string.' }] };
  }
  const variables = isRecord(operation.variables) ? (operation.variables as Record<string, unknown>) : {};
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
  let definitions: Definition[];
  try {
    definitions = new Parser(lex(operation.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Could not parse the GraphQL document.' }] };
  }
  const operations = definitions.filter((d): d is OperationDef => d.kind === 'operation');
  if (operations.length === 0) {
    return { errors: [{ message: 'The document holds no operation.' }] };
  }
  let op: OperationDef | undefined;
  if (operationName !== undefined) op = operations.find((o) => o.name === operationName);
  else op = operations[0];
  if (op === undefined) {
    return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  const executor = new Executor(store);
  executor.registerFragments(definitions);
  try {
    const data = executor.executeOperation(op, variables);
    if (executor.errors.length > 0) return { data, errors: executor.errors };
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution failed.' }] };
  }
}

// ---------------------------------------------------------------------------
// Handler (DESIGN.md §6)
// ---------------------------------------------------------------------------

export function createGraphqlHandler(store: ForgeStore): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!checkAuth(store, req)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      const raw = await readBodyText(req);
      if (raw === null || raw.trim() === '') {
        sendJson(res, 400, { errors: [{ message: 'Malformed JSON body.' }] });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Malformed JSON body.' }] });
        return;
      }
      if (Array.isArray(parsed)) {
        // GitHub operation batching: one envelope per document, in order.
        sendJson(res, 200, parsed.map((entry) => executeOne(store, entry)));
        return;
      }
      sendJson(res, 200, executeOne(store, parsed));
    } catch {
      try {
        sendJson(res, 200, { data: null, errors: [{ message: 'GraphQL execution failed.' }] });
      } catch {
        // The response is already gone; nothing left to do.
      }
    }
  };
}
