// httputil.ts — small shared plumbing for the HTTP surfaces: the request/response
// shapes, JSON helpers, pagination, and path decoding. Kept dependency-free.

import { StoreError } from './store.ts';

export interface RequestInfo {
  readonly method: string;
  readonly path: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
  readonly host: string;
  readonly requestId: string;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export function jsonResult(status: number, value: unknown, extraHeaders: Record<string, string> = {}): HttpResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

export function errorResult(status: number, message: string): HttpResult {
  return jsonResult(status, { message });
}

export function emptyResult(status: number, extraHeaders: Record<string, string> = {}): HttpResult {
  return { status, headers: { ...extraHeaders }, body: Buffer.alloc(0) };
}

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Parse a request body as JSON. An empty body is `{}`; a non-empty body that is not
 * valid JSON is a 400; a valid JSON value that is not an object is a 400 too.
 */
export function parseJsonBody(req: RequestInfo): Record<string, unknown> {
  if (req.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new StoreError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

/** Parse a request body as JSON without requiring an object (GraphQL batching). */
export function parseJsonValue(req: RequestInfo): unknown {
  if (req.body.length === 0) return undefined;
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new StoreError(400, 'Problems parsing JSON');
  }
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part.length > 0)
    .map(decodeSegment);
}

export interface Pagination {
  readonly page: number;
  readonly perPage: number;
}

export function parsePagination(query: URLSearchParams): Pagination {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
  return { page, perPage };
}

export function paginate<T>(items: readonly T[], pagination: Pagination): T[] {
  const start = (pagination.page - 1) * pagination.perPage;
  return items.slice(start, start + pagination.perPage);
}

/**
 * Build a GitHub-style Link header from the request's own host, preserving the
 * other query parameters. Only `next`/`last` are emitted, when they apply.
 */
export function linkHeader(req: RequestInfo, pagination: Pagination, total: number): string | undefined {
  const totalPages = Math.max(1, Math.ceil(total / pagination.perPage));
  if (totalPages <= 1) return undefined;
  const parts: string[] = [];
  const build = (page: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(page));
    params.set('per_page', String(pagination.perPage));
    return `<http://${req.host}${req.path}?${params.toString()}>`;
  };
  if (pagination.page < totalPages) parts.push(`${build(pagination.page + 1)}; rel="next"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  return parts.join(', ');
}

export function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

export function numberField(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringListField(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
