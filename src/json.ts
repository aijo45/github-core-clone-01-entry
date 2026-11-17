import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestId } from './model.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Fallback per-process request counter, used only when the caller did not supply an id. */
let fallbackCounter = 1;

/**
 * Answer with a JSON body. Always sets content-type application/json; charset=utf-8,
 * content-length, and x-github-request-id (taken from `headers` when present,
 * otherwise generated deterministically as req-<n>).
 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const text = `${JSON.stringify(body)}\n`;
  const out: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    ...(headers ?? {}),
  };
  if (out['x-github-request-id'] === undefined || out['x-github-request-id'] === '') {
    out['x-github-request-id'] = requestId(fallbackCounter);
    fallbackCounter += 1;
  }
  res.writeHead(status, out);
  res.end(text);
}

/** sendJson(status, { message }, { 'x-github-request-id': reqId }). */
export function sendError(res: ServerResponse, status: number, message: string, reqId: string): void {
  sendJson(res, status, { message }, { 'x-github-request-id': reqId });
}

/**
 * Read the full request body (default limit 8 MiB).
 * Malformed JSON -> { ok: false, error: 'malformed' }.
 * Empty body -> { ok: false, error: 'empty' } (callers that allow an empty body treat it as {}).
 * Over the limit -> { ok: false, error: 'too-large' }.
 */
export async function readJsonBody(
  req: IncomingMessage,
  limitBytes = 8 * 1024 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; error: 'malformed' | 'empty' | 'too-large' }> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > limitBytes) {
        // Stop consuming; the caller will answer without waiting for the rest.
        req.destroy();
        return { ok: false, error: 'too-large' };
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, error: 'malformed' };
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return { ok: false, error: 'empty' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}
