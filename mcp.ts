// mcp.ts — the MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, modern era
// (2026-07-28) only, plain JSON responses, no SSE, no session ids. The six tools act
// on the same store as REST and GraphQL, so every surface sees the same state.

import { Store, StoreError, VIEWER } from './store.ts';
import { issueJson, pullRequestJson, repoJson } from './rest.ts';
import { emptyResult, jsonResult, parseJsonValue } from './httputil.ts';
import type { HttpResult, RequestInfo } from './httputil.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description?: string }>;
    readonly required: string[];
  };
}

// Frozen at startup: two consecutive tools/list calls return byte-identical tools.
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request between two branches of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------------------------
// tool argument reading (canonical names first, synonyms defensively)
// ---------------------------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

function argText(args: ToolArgs, names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function argInt(args: ToolArgs, names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function argBool(args: ToolArgs, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === 'boolean' ? value : undefined;
}

function ownerAndRepo(args: ToolArgs): { owner: string; repo: string } {
  let owner = argText(args, ['owner', 'owner_login', 'ownerLogin']);
  let repo = argText(args, ['repo', 'repo_name', 'repoName']);
  if ((owner === undefined || repo === undefined) && typeof args['full_name'] === 'string') {
    const parts = (args['full_name'] as string).split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repo = repo ?? parts[1];
    }
  }
  if (owner === undefined) throw new RpcError(-32602, 'Missing required argument: owner');
  if (repo === undefined) throw new RpcError(-32602, 'Missing required argument: repo');
  return { owner, repo };
}

function requireRepo(store: Store, owner: string, name: string) {
  if (owner.toLowerCase() !== VIEWER.login) throw new StoreError(404, 'Not Found');
  const repo = store.findRepo(name);
  if (repo === undefined) throw new StoreError(404, 'Not Found');
  return repo;
}

// ---------------------------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------------------------

function callTool(store: Store, req: RequestInfo, name: string, args: ToolArgs): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = argText(args, ['name']);
      if (repoName === undefined) throw new RpcError(-32602, 'Missing required argument: name');
      const description = argText(args, ['description']) ?? '';
      const isPrivate = argBool(args, 'private') ?? false;
      return repoJson(req, store.createRepo(repoName, description, isPrivate));
    }
    case 'get_repo': {
      const { owner, repo } = ownerAndRepo(args);
      return repoJson(req, requireRepo(store, owner, repo));
    }
    case 'create_issue': {
      const { owner, repo } = ownerAndRepo(args);
      const title = argText(args, ['title']);
      if (title === undefined) throw new RpcError(-32602, 'Missing required argument: title');
      const body = argText(args, ['body']) ?? '';
      const found = requireRepo(store, owner, repo);
      return issueJson(req, found, store.createIssue(found, title, body, []));
    }
    case 'list_issues': {
      const { owner, repo } = ownerAndRepo(args);
      const found = requireRepo(store, owner, repo);
      const state = argText(args, ['state']) ?? 'open';
      let issues = store.listIssues(found);
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      return issues.map((issue) => issueJson(req, found, issue));
    }
    case 'create_pull_request': {
      const { owner, repo } = ownerAndRepo(args);
      const title = argText(args, ['title']);
      const head = argText(args, ['head', 'head_ref', 'headRef']);
      const base = argText(args, ['base', 'base_ref', 'baseRef']);
      if (title === undefined) throw new RpcError(-32602, 'Missing required argument: title');
      if (head === undefined) throw new RpcError(-32602, 'Missing required argument: head');
      if (base === undefined) throw new RpcError(-32602, 'Missing required argument: base');
      const body = argText(args, ['body']) ?? '';
      const found = requireRepo(store, owner, repo);
      return pullRequestJson(req, store, found, store.createPullRequest(found, title, body, head, base));
    }
    case 'merge_pull_request': {
      const { owner, repo } = ownerAndRepo(args);
      const pullNumber = argInt(args, ['pull_number', 'pull_request_number', 'number']);
      if (pullNumber === undefined) throw new RpcError(-32602, 'Missing required argument: pull_number');
      const found = requireRepo(store, owner, repo);
      const pr = store.getPullRequest(found, pullNumber);
      const result = store.mergePullRequest(found, pr);
      return { sha: result.sha, merged: result.merged, message: result.message, number: pr.number };
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function handleRpcRequest(store: Store, req: RequestInfo, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request['id'];
  const isNotification = id === undefined || id === null;
  const method = request['method'];
  if (typeof method !== 'string') {
    if (isNotification) return null;
    return rpcError(id, -32600, 'Invalid Request: method must be a string');
  }
  const params = request['params'];
  const paramsObject = params !== null && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};

  if (method.startsWith('notifications/')) return null;

  try {
    switch (method) {
      case 'server/discover': {
        return rpcResult(id, {
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        });
      }
      case 'initialize': {
        const requested = typeof paramsObject['protocolVersion'] === 'string'
          ? (paramsObject['protocolVersion'] as string)
          : PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const name = paramsObject['name'];
        if (typeof name !== 'string') throw new RpcError(-32602, 'Missing required parameter: name');
        const args = paramsObject['arguments'];
        const argsObject = args !== null && typeof args === 'object' && !Array.isArray(args)
          ? (args as ToolArgs)
          : {};
        try {
          const result = callTool(store, req, name, argsObject);
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          });
        } catch (err) {
          if (err instanceof RpcError) throw err;
          if (err instanceof StoreError) {
            return rpcResult(id, {
              content: [{ type: 'text', text: err.message }],
              isError: true,
            });
          }
          throw err;
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message);
    if (err instanceof StoreError) return rpcError(id, -32603, err.message);
    return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

export function handleMcpRequest(store: Store, req: RequestInfo): HttpResult | null {
  if (req.segments.length !== 1 || req.segments[0] !== 'mcp') return null;
  if (req.method !== 'POST') throw new StoreError(405, 'Method Not Allowed');
  let parsed: unknown;
  try {
    parsed = parseJsonValue(req);
  } catch {
    return jsonResult(400, rpcError(null, -32700, 'Parse error'));
  }
  if (parsed === undefined) {
    return jsonResult(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        responses.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const response = handleRpcRequest(store, req, item as Record<string, unknown>);
      if (response !== null) responses.push(response);
    }
    return responses.length === 0 ? emptyResult(202) : jsonResult(200, responses);
  }
  if (parsed === null || typeof parsed !== 'object') {
    return jsonResult(400, rpcError(null, -32600, 'Invalid Request'));
  }
  const response = handleRpcRequest(store, req, parsed as Record<string, unknown>);
  if (response === null) return emptyResult(202);
  return jsonResult(200, response);
}
