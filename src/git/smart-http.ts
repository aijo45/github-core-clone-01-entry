// Git smart-HTTP router: info/refs, upload-pack (v0 + v2), receive-pack (v0)
// (DESIGN.md §4, smart-http.ts).
//
// Routes (auth via store.checkAuth, missing repo -> 404 JSON):
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack   (v0 + v2)
//   GET  /<owner>/<repo>.git/info/refs?service=git-receive-pack  (v0)
//   POST /<owner>/<repo>.git/git-upload-pack                      (v0 + v2)
//   POST /<owner>/<repo>.git/git-receive-pack                     (v0)
// Protocol v2 is selected by the `Git-Protocol: version=2` request header.
// The router reads the request body itself; if the caller already buffered
// it onto `req.body` (Buffer or string) that is used instead.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeStore } from '../store.ts';
import type { GitObject, Repo, Sha1 } from '../model.ts';
import { PktReader, PktWriter } from './pkt.ts';
import { parseCommit, parseTree } from './objects.ts';
import { ZERO_OID, isFastForward } from './refs.ts';
import { parsePack } from './pack-read.ts';
import { collectReachable, writePack } from './pack-write.ts';

const CT_UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const CT_RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const CT_UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const CT_RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const CT_JSON = 'application/json; charset=utf-8';
const HEX40 = /^[0-9a-f]{40}$/;

const AGENT = 'forge/1.0';

type GitRoute = 'info/refs' | 'git-upload-pack' | 'git-receive-pack';

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  sendBuffer(res, status, CT_JSON, Buffer.from(JSON.stringify({ message }), 'utf8'));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const pre = (req as unknown as { body?: unknown }).body;
  if (Buffer.isBuffer(pre)) return pre;
  if (typeof pre === 'string') return Buffer.from(pre, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function isV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim().toLowerCase() === 'version=2';
}

/** Stored refs sorted by name, with any HEAD entry removed (HEAD is synthesized). */
function sortedRefs(repo: Repo, store: ForgeStore): Array<{ name: string; oid: Sha1 }> {
  const seen = new Map<string, Sha1>();
  for (const ref of store.listRefs(repo)) {
    if (ref.name === 'HEAD') continue;
    if (!seen.has(ref.name)) seen.set(ref.name, ref.oid);
  }
  return [...seen.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Follow an annotated tag to its commit, or null when the ref is not a tag. */
function peelTagToCommit(repo: Repo, oid: Sha1): Sha1 | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const seen = new Set<Sha1>([oid]);
  let current: Sha1 | null = tagTargetOid(obj.raw);
  while (current !== null) {
    if (seen.has(current)) return null;
    seen.add(current);
    const target = repo.objects.get(current);
    if (!target) return null;
    if (target.type === 'commit') return current;
    if (target.type !== 'tag') return null;
    current = tagTargetOid(target.raw);
  }
  return null;
}

function tagTargetOid(raw: Buffer): Sha1 | null {
  const blank = raw.indexOf('\n\n');
  const header = raw.subarray(0, blank < 0 ? raw.length : blank).toString('utf8');
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) {
      const oid = line.slice('object '.length).trim();
      return HEX40.test(oid) ? oid : null;
    }
  }
  return null;
}

function pktText(text: string): Buffer {
  return PktWriter.pkt(text);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0RefLines(repo: Repo, store: ForgeStore, caps: string): Buffer[] {
  const refs = sortedRefs(repo, store);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  lines.push(pktText(`${headOid} HEAD\0${caps}\n`));
  for (const ref of refs) {
    lines.push(pktText(`${ref.oid} ${ref.name}\n`));
    if (ref.name.startsWith('refs/tags/')) {
      const peeled = peelTagToCommit(repo, ref.oid);
      if (peeled) lines.push(pktText(`${peeled} ${ref.name}^{}\n`));
    }
  }
  return lines;
}

function uploadPackAdvertisement(repo: Repo, store: ForgeStore, v2: boolean): Buffer {
  if (v2) {
    const parts: Buffer[] = [
      pktText('version 2\n'),
      pktText('ls-refs=unborn\n'),
      pktText('fetch=shallow\n'),
      pktText('server-option\n'),
      pktText('object-format=sha1\n'),
      pktText(`agent=${AGENT}\n`),
      PktWriter.flush(),
    ];
    return Buffer.concat(parts);
  }
  const caps =
    `side-band-64k ofs-delta thin-pack multi_ack_detailed shallow ` +
    `symref=HEAD:${headTarget(repo)} agent=${AGENT} object-format=sha1`;
  return Buffer.concat([pktText('# service=git-upload-pack\n'), PktWriter.flush(), ...v0RefLines(repo, store, caps)]);
}

function receivePackAdvertisement(repo: Repo, store: ForgeStore): Buffer {
  const caps =
    `report-status side-band-64k delete-refs ofs-delta ` +
    `symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  return Buffer.concat([pktText('# service=git-receive-pack\n'), PktWriter.flush(), ...v0RefLines(repo, store, caps)]);
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: Sha1[];
  haves: Sha1[];
  shallow: Sha1[];
  depth?: number;
  done: boolean;
}

function parseFetchLines(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (HEX40.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (HEX40.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (HEX40.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'done') {
      args.done = true;
    }
    // deepen-since / deepen-not / thin-pack / ofs-delta / sideband-all /
    // no-progress / filter: accepted and ignored (non-delta full pack).
  }
  return args;
}

/**
 * Objects to send for a fetch: the depth-limited closure of the wants,
 * minus what the client already holds. A `have` listed in the request's
 * shallow set is a boundary the client holds only one generation deep, so
 * only its commit + tree + blobs are excluded (depth 1); other haves
 * exclude their full history.
 */
function computeFetch(
  repo: Repo,
  store: ForgeStore,
  args: FetchArgs,
): { objects: Map<Sha1, GitObject>; shallow: Sha1[]; unshallow: Sha1[] } {
  const wantSet = collectReachable(repo, args.wants, args.depth !== undefined ? { depth: args.depth } : undefined);
  const shallowSet = new Set(args.shallow);
  const held = new Map<Sha1, GitObject>();
  for (const have of args.haves) {
    const part = shallowSet.has(have)
      ? collectReachable(repo, [have], { depth: 1 })
      : collectReachable(repo, [have]);
    for (const [oid, obj] of part) held.set(oid, obj);
  }
  const objects = new Map<Sha1, GitObject>();
  for (const [oid, obj] of wantSet) {
    if (!held.has(oid)) objects.set(oid, obj);
  }
  // Shallow boundaries: commits in the want closure whose parent exists in
  // the store but was cut off by the depth limit.
  const shallow: Sha1[] = [];
  if (args.depth !== undefined) {
    for (const [oid, obj] of wantSet) {
      if (obj.type !== 'commit') continue;
      let commit;
      try {
        commit = parseCommit(obj.raw);
      } catch {
        continue;
      }
      for (const parent of commit.parents) {
        if (!wantSet.has(parent) && store.getObject(repo, parent)) {
          shallow.push(oid);
          break;
        }
      }
    }
  }
  const shallowOut = new Set(shallow);
  const unshallow = args.shallow.filter((oid) => {
    const obj = wantSet.get(oid);
    return obj !== undefined && obj.type === 'commit' && !shallowOut.has(oid);
  });
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function uploadPackV0(repo: Repo, store: ForgeStore, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'pkt') lines.push(packet.data.toString('utf8').replace(/\n$/, ''));
    // flush separates the want section from the negotiation section; both
    // sections are parsed the same way.
  }
  const args = parseFetchLines(lines);
  const { objects, shallow, unshallow } = computeFetch(repo, store, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktText('NAK\n')];
  for (const oid of shallow) parts.push(pktText(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktText(`unshallow ${oid}\n`));
  parts.push(PktWriter.sideband(1, pack));
  parts.push(PktWriter.flush());
  return Buffer.concat(parts);
}

function uploadPackV2(repo: Repo, store: ForgeStore, body: Buffer): Buffer {
  const reader = new PktReader(body);
  let command = '';
  const argLines: string[] = [];
  let afterDelim = false;
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'pkt') continue; // flush ends the request
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (!command && line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    if (afterDelim) argLines.push(line);
  }
  if (command === 'ls-refs') {
    return lsRefsResponse(repo, store, argLines);
  }
  if (command === 'fetch') {
    const args = parseFetchLines(argLines);
    const { objects, shallow, unshallow } = computeFetch(repo, store, args);
    const pack = writePack(objects);
    const parts: Buffer[] = [pktText('acknowledgments\n'), pktText('NAK\n'), PktWriter.delim()];
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktText('shallow-info\n'));
      for (const oid of shallow) parts.push(pktText(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktText(`unshallow ${oid}\n`));
      parts.push(PktWriter.delim());
    }
    parts.push(pktText('packfile\n'));
    parts.push(PktWriter.sideband(1, pack));
    parts.push(PktWriter.flush());
    return Buffer.concat(parts);
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

function lsRefsResponse(repo: Repo, store: ForgeStore, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (keep('HEAD')) {
    if (headOid) {
      const suffix = symrefs ? ` symref-target:${target}` : '';
      parts.push(pktText(`${headOid} HEAD${suffix}\n`));
    } else if (unborn) {
      const suffix = symrefs ? ` symref-target:${target}` : '';
      parts.push(pktText(`unborn HEAD${suffix}\n`));
    }
  }
  for (const ref of sortedRefs(repo, store)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelTagToCommit(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktText(`${line}\n`));
  }
  parts.push(PktWriter.flush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: Sha1;
  newOid: Sha1;
  ref: string;
}

function receivePack(repo: Repo, store: ForgeStore, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'pkt') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
    if (!match) throw new Error(`bad receive-pack command line ${JSON.stringify(head.slice(0, 80))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const packBytes = reader.rest();

  // Unpack first: even a refused push must unpack, and the objects stay.
  let unpackError: string | null = null;
  const hasUpdate = commands.some((c) => c.newOid !== ZERO_OID);
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const obj of objects) store.putObject(repo, obj);
    } catch (err) {
      unpackError = (err as Error).message;
    }
  } else if (hasUpdate) {
    unpackError = 'unpacker error: missing packfile';
  }

  // Validate and apply per ref; a mixed batch applies the passing refs and
  // rejects the rest.
  const report: string[] = [];
  report.push(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`);
  for (const command of commands) {
    let ok = true;
    let reason = '';
    if (unpackError !== null) {
      ok = false;
      reason = 'unpack failed';
    } else {
      const current = store.getRef(repo, command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === ZERO_OID) {
          ok = false;
          reason = 'ref does not exist';
        } else if (command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else {
          store.deleteRef(repo, command.ref);
        }
      } else {
        const target = store.getObject(repo, command.newOid);
        if (command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!target) {
          ok = false;
          reason = 'object not found';
        } else if (
          (command.ref.startsWith('refs/heads/') && target.type !== 'commit') ||
          (command.ref.startsWith('refs/tags/') && target.type !== 'commit' && target.type !== 'tag') ||
          (!command.ref.startsWith('refs/heads/') &&
            !command.ref.startsWith('refs/tags/') &&
            target.type !== 'commit' &&
            target.type !== 'tag')
        ) {
          ok = false;
          reason = 'invalid object';
        } else if (!isFastForward(repo, command.oldOid, command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        } else {
          store.setRef(repo, command.ref, command.newOid);
        }
      }
    }
    report.push(ok ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }

  const reportBody = Buffer.concat([
    ...report.map((line) => pktText(`${line}\n`)),
    PktWriter.flush(),
  ]);
  return Buffer.concat([PktWriter.sideband(1, reportBody), PktWriter.flush()]);
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function createGitRouter(
  store: ForgeStore,
): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean> {
  return async (req, res, path): Promise<boolean> => {
    let pathname = path;
    let queryStr = '';
    const qIndex = path.indexOf('?');
    if (qIndex >= 0) {
      pathname = path.slice(0, qIndex);
      queryStr = path.slice(qIndex + 1);
    }
    if (!queryStr && req.url) {
      const urlQ = req.url.indexOf('?');
      if (urlQ >= 0) queryStr = req.url.slice(urlQ + 1);
    }
    const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
    if (!match) return false;
    const route = match[3] as GitRoute;
    const owner = decodeSegment(match[1]);
    const repoName = decodeSegment(match[2]);
    const query = new URLSearchParams(queryStr);
    const method = req.method ?? 'GET';

    if (route === 'info/refs' && method !== 'GET') {
      sendJson(res, 405, 'Method Not Allowed');
      return true;
    }
    if (route !== 'info/refs' && method !== 'POST') {
      sendJson(res, 405, 'Method Not Allowed');
      return true;
    }
    if (!store.checkAuth(req)) {
      sendJson(res, 401, 'Unauthorized');
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, 'Not Found');
      return true;
    }

    try {
      if (route === 'info/refs') {
        const service = query.get('service');
        if (service === 'git-upload-pack') {
          sendBuffer(res, 200, CT_UPLOAD_AD, uploadPackAdvertisement(repo, store, isV2(req)));
        } else if (service === 'git-receive-pack') {
          sendBuffer(res, 200, CT_RECEIVE_AD, receivePackAdvertisement(repo, store));
        } else {
          sendJson(res, 400, 'Missing or unknown service');
        }
        return true;
      }
      const body = await readBody(req);
      if (route === 'git-upload-pack') {
        const out = isV2(req) ? uploadPackV2(repo, store, body) : uploadPackV0(repo, store, body);
        sendBuffer(res, 200, CT_UPLOAD_RESULT, out);
      } else {
        sendBuffer(res, 200, CT_RECEIVE_RESULT, receivePack(repo, store, body));
      }
      return true;
    } catch (err) {
      // Malformed pkt-lines, bad commands, corrupt packs: answer 400 JSON
      // and stay alive; never leak a stack trace.
      if (!res.headersSent) sendJson(res, 400, (err as Error).message);
      return true;
    }
  };
}
