// main.ts — the forge's lifecycle: bind an ephemeral port, register it with the
// trial environment, serve until the environment says it is done, then exit 0.
// Without MAKEFUN_ENV_URL there is no trial to serve, so exit 1 at once.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;

if (ENV_URL === undefined || ENV_URL === '') {
  console.error('MAKEFUN_ENV_URL is not set; nothing to serve.');
  process.exit(1);
}

const BASE = ENV_URL.replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(path: string, value: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function getJson(path: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return response.json();
}

/** Register our port. Retries with exponential backoff for up to 30 seconds. */
async function register(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let delay = 250;
  for (;;) {
    try {
      const response = await postJson('/register', { port }, 5_000);
      if (response.status === 200 || response.status === 201 || response.status === 204) return;
      if (response.status === 409) {
        console.error('Another forge already registered with the environment.');
        process.exit(1);
      }
      if (response.status === 400 || response.status === 405) {
        console.error(`Register was rejected with ${response.status}; giving up.`);
        process.exit(1);
      }
      throw new Error(`register returned ${response.status}`);
    } catch (err) {
      if (Date.now() + delay > deadline) {
        console.error(`Could not register: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }
}

/** Poll /done until the environment reports done:true. Never holds a request open. */
async function waitUntilDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const body = await getJson('/done', 5_000);
      if (
        body !== null &&
        typeof body === 'object' &&
        (body as Record<string, unknown>)['done'] === true
      ) {
        return;
      }
      delay = 500;
    } catch {
      delay = Math.min(delay * 2, 2_000);
    }
    await sleep(delay);
  }
}

const { server } = createApp();

server.listen(0, '127.0.0.1', () => {
  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address !== 'object') {
    console.error('Could not determine the bound port.');
    process.exit(1);
  }
  void (async () => {
    await register(address.port);
    await waitUntilDone();
    server.close(() => process.exit(0));
    // Do not hang on a lingering keep-alive socket.
    setTimeout(() => process.exit(0), 2_000).unref();
  })();
});

server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});
