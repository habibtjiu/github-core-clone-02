// app.ts — the HTTP server: body reading, bearer-token auth, routing to the four
// surfaces, and uniform response headers. Every reply is JSON (except the git
// binary protocol), every reply carries X-GitHub-Request-Id, and a handler that
// throws can never take the server down.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Store, StoreError } from './store.ts';
import { handleGitRequest } from './gitproto.ts';
import { handleRestRequest } from './rest.ts';
import { handleGraphQLRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { errorResult, headerValue, splitPath } from './httputil.ts';
import type { HttpResult, RequestInfo } from './httputil.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface AppOptions {
  /** Expected bearer token; defaults to MAKEFUN_SHOP_TOKEN. Empty means "any bearer". */
  readonly shopToken?: string;
}

export interface ForgeApp {
  readonly server: Server;
  readonly store: Store;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new StoreError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function sendResponse(res: ServerResponse, result: HttpResult, requestId: string): void {
  try {
    const headers: Record<string, string> = { 'x-github-request-id': requestId, ...result.headers };
    if (result.status !== 204) headers['content-length'] = String(result.body.length);
    res.writeHead(result.status, headers);
    res.end(result.status === 204 ? undefined : result.body);
  } catch {
    // The client went away; nothing more to do.
    try {
      res.destroy();
    } catch {
      // Ignore.
    }
  }
}

export function createApp(options: AppOptions = {}): ForgeApp {
  const store = new Store();
  const shopToken = options.shopToken ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      try {
        const body = await readBody(req);
        const rawUrl = req.url ?? '/';
        const host = headerValue(req.headers, 'host') ?? '127.0.0.1';
        const url = new URL(rawUrl, `http://${host}`);
        const path = url.pathname;
        const info: RequestInfo = {
          method: (req.method ?? 'GET').toUpperCase(),
          path,
          segments: splitPath(path),
          query: url.searchParams,
          headers: req.headers,
          body,
          host,
          requestId,
        };

        // Health check: no auth, always up.
        if (info.method === 'GET' && path === '/healthz') {
          sendResponse(res, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') }, requestId);
          return;
        }

        // Auth: every API surface requires the bearer token. The git endpoints
        // and unknown paths do not.
        const needsAuth =
          path === '/api/v3' ||
          path.startsWith('/api/v3/') ||
          path === '/api/graphql' ||
          path === '/mcp';
        if (needsAuth) {
          const authorization = headerValue(req.headers, 'authorization') ?? '';
          const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
          const authorized = shopToken.length > 0 ? presented === shopToken : presented.length > 0;
          if (!authorized) {
            sendResponse(res, errorResult(401, 'Requires authentication'), requestId);
            return;
          }
        }

        let result: HttpResult | null = null;
        try {
          result = handleGitRequest(store, info);
          if (result === null) result = handleRestRequest(store, info);
          if (result === null) result = handleGraphQLRequest(store, info);
          if (result === null) result = handleMcpRequest(store, info);
        } catch (err) {
          if (err instanceof StoreError) {
            result = errorResult(err.status, err.message);
          } else {
            throw err;
          }
        }
        if (result === null) result = errorResult(404, 'Not Found');
        sendResponse(res, result, requestId);
      } catch (err) {
        const message = err instanceof StoreError ? err.message : 'Internal Server Error';
        const status = err instanceof StoreError ? err.status : 500;
        sendResponse(res, errorResult(status, message), requestId);
      }
    })();
  });

  return { server, store };
}
