// app.ts — HTTP server wiring for the github-core-clone-01 forge.
//
// One ForgeStore is the single source of truth; the four surface routers
// (REST v3, GraphQL v4, MCP, git smart HTTP) all read and mutate it.
// main.ts owns the lifecycle (listen(0), register, poll /done); this file
// only routes requests. It never pre-reads a request body: each handler
// reads its own stream (or honours a pre-stashed req.body), so the MCP
// parse-error check (HTTP 400 + JSON-RPC -32700) and the REST malformed-JSON
// check (HTTP 400) both work.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './src/store.ts';
import { createRestRouter } from './src/rest.ts';
import { createGraphqlHandler } from './src/graphql.ts';
import { createMcpHandler } from './src/mcp.ts';
import { createGitRouter } from './src/git/smart-http.ts';
import { sendJson } from './src/json.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query params of a request URL, or empty when it does not parse. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new ForgeStore();
  const restRouter = createRestRouter(store);
  const graphqlHandler = createGraphqlHandler(store);
  const mcpHandler = createMcpHandler(store);
  const gitRouter = createGitRouter(store);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = (req.method ?? 'GET').toUpperCase();

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GitHub REST v3 (the router also answers the /api/v3 root, no auth).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await restRouter(req, res, path, queryOf(req))) return;
        }

        // GitHub GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          await graphqlHandler(req, res);
          return;
        }

        // MCP over streamable HTTP.
        if (method === 'POST' && path === '/mcp') {
          await mcpHandler(req, res);
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}.
        if (await gitRouter(req, res, path)) return;

        // Everything else, every method: GitHub's 404 body.
        if (!res.writableEnded) sendJson(res, 404, { message: 'Not Found' });
      } catch {
        // Never crash the server or leak a stack: a JSON 500 for the unexpected.
        if (!res.writableEnded) {
          try {
            sendJson(res, 500, { message: 'Internal Server Error' });
          } catch {
            // The socket is gone; nothing more to do.
          }
        }
      }
    })();
  });
}
