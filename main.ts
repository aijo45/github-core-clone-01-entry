// Lifecycle entrypoint for the github-core-clone-01 forge.
// The forge itself is built by app.ts; this file only owns the
// make.fun environment handshake: bind an ephemeral port, register
// it with the suite, then wait until the suite reports it is done.

import { createApp } from './app.ts';

const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const DONE_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envBaseUrl(): string {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
  return raw;
}

async function registerPort(baseUrl: string, port: number): Promise<void> {
  let backoff = FIRST_BACKOFF_MS;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(baseUrl + REGISTER_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(`register: request failed (${error}), retrying in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }
    if (response.status === 200 || response.status === 409) {
      // 409 means another entry registered first; the suite still
      // drives this process to completion, so wait like any other case.
      console.log(`register: accepted (HTTP ${response.status}) on port ${port}`);
      return;
    }
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register: contract error, HTTP ${response.status}`);
    }
    console.error(`register: HTTP ${response.status}, retrying in ${backoff}ms`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

async function waitForDone(baseUrl: string): Promise<void> {
  let backoff = FIRST_BACKOFF_MS;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(baseUrl + DONE_PATH, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(`done: request failed (${error}), retrying in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }
    if (!response.ok) {
      console.error(`done: HTTP ${response.status}, retrying in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }
    backoff = FIRST_BACKOFF_MS;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      console.error('done: unparsable response, retrying');
      await sleep(backoff);
      continue;
    }
    if (typeof payload === 'object' && payload !== null && (payload as { done?: unknown }).done === true) {
      console.log('done: suite finished, shutting down');
      return;
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const baseUrl = envBaseUrl();
  if (!baseUrl) {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const server = createApp();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    console.error(`listen failed: ${error}`);
    process.exit(1);
  }

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!port) {
    console.error('could not determine the listening port');
    process.exit(1);
  }
  console.log(`forge listening on port ${port}`);

  try {
    await registerPort(baseUrl, port);
    await waitForDone(baseUrl);
  } catch (error) {
    console.error(`lifecycle failed: ${error}`);
    process.exit(1);
  }

  // Drop any keep-alive connections first so close() cannot hang on
  // an idle client, and force the exit if the close never completes.
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

void main();
