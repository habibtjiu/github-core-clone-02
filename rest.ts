// rest.ts — the REST v3 surface under /api/v3: repositories, branches, commits,
// contents, labels, issues, pull requests, and git refs. Responses are generous
// GitHub-like bodies (the suite's shape checker allows extra properties); every
// error is JSON with a string `message`.

import { parseCommit, parseTree, peelToNonTag } from './gitobj.ts';
import { DEFAULT_BRANCH, Store, StoreError, VIEWER } from './store.ts';
import type { Issue, IssueComment, Label, PullRequest, Repo } from './store.ts';
import {
  booleanField,
  emptyResult,
  errorResult,
  jsonResult,
  linkHeader,
  numberField,
  paginate,
  parseJsonBody,
  parsePagination,
  stringField,
  stringListField,
} from './httputil.ts';
import type { HttpResult, RequestInfo } from './httputil.ts';

// ---------------------------------------------------------------------------------------------
// global ids (shared with the GraphQL and MCP surfaces)
// ---------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`forge:${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith('forge:')) return null;
  const rest = decoded.slice('forge:'.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  return { kind: rest.slice(0, colon), key: rest.slice(colon + 1) };
}

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

function apiBase(req: RequestInfo): string {
  return `http://${req.host}/api/v3`;
}

function userJson(_req: RequestInfo): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: encodeGlobalId('User', VIEWER.login),
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(req: RequestInfo, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeGlobalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: userJson(req),
    private: repo.isPrivate,
    html_url: `http://${req.host}/${repo.ownerLogin}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(req: RequestInfo, repo: Repo, label: Label): Record<string, unknown> {
  return {
    name: label.name,
    color: label.color,
    description: label.description,
    url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

export function issueJson(req: RequestInfo, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(req),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name.toLowerCase());
      return label !== undefined
        ? labelJson(req, repo, label)
        : { name, color: '000000', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

function commentJson(req: RequestInfo, repo: Repo, comment: IssueComment, parentKind: 'issues' | 'pulls', parentNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: encodeGlobalId('IssueComment', `${repo.id}:${comment.id}`),
    body: comment.body,
    user: userJson(req),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `http://${req.host}/${repo.ownerLogin}/${repo.name}/${parentKind}/${parentNumber}#issuecomment-${comment.id}`,
    url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullRequestJson(req: RequestInfo, store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? '';
  return {
    id: pr.id,
    node_id: encodeGlobalId('PullRequest', `${repo.id}:${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(req),
    labels: [],
    milestone: null,
    comments: pr.comments.length,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    merged: pr.merged,
    mergeable: pr.state === 'open' ? store.isMergeable(repo, pr) : false,
    mergeable_state: pr.state === 'open' ? (store.isMergeable(repo, pr) ? 'clean' : 'dirty') : 'unknown',
    head: {
      label: `${repo.ownerLogin}:${pr.headRef}`,
      ref: pr.headRef,
      sha: headSha,
      user: userJson(req),
      repo: repoJson(req, repo),
    },
    base: {
      label: `${repo.ownerLogin}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: baseSha,
      user: userJson(req),
      repo: repoJson(req, repo),
    },
    html_url: `http://${req.host}/${repo.ownerLogin}/${repo.name}/pull/${pr.number}`,
    url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/pulls/${pr.number}`,
  };
}

interface IdentParts {
  name: string;
  email: string;
  date: string;
}

/** Parse `Name <email> <unix-seconds> <tz>` into its parts. */
function parseIdent(ident: string): IdentParts {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident.trim());
  if (match === null) return { name: ident, email: '', date: Store.iso(0) };
  const sec = Number.parseInt(match[3]!, 10);
  return { name: match[1]!, email: match[2]!, date: Store.iso(sec) };
}

function commitJson(req: RequestInfo, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  return {
    sha,
    node_id: encodeGlobalId('Commit', `${repo.id}:${sha}`),
    commit: {
      message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/git/commits/${parent}` })),
    url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/commits/${sha}`,
    html_url: `http://${req.host}/${repo.ownerLogin}/${repo.name}/commit/${sha}`,
  };
}

function refJson(req: RequestInfo, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    ref,
    node_id: encodeGlobalId('Ref', `${repo.id}:${ref}`),
    url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/git/refs/${ref.slice('refs/'.length)}`,
    object: {
      sha,
      type: repo.objects.get(sha)?.type ?? 'commit',
      url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/git/commits/${sha}`,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------------------------

function requireRepo(store: Store, owner: string, name: string): Repo {
  if (owner.toLowerCase() !== VIEWER.login) throw new StoreError(404, 'Not Found');
  const repo = store.findRepo(name);
  if (repo === undefined) throw new StoreError(404, 'Not Found');
  return repo;
}

function parseNumber(segment: string): number {
  const value = Number.parseInt(segment, 10);
  if (!Number.isFinite(value) || String(value) !== segment) throw new StoreError(404, 'Not Found');
  return value;
}

function pagedResult(req: RequestInfo, items: unknown[]): HttpResult {
  const pagination = parsePagination(req.query);
  const page = paginate(items, pagination);
  const link = linkHeader(req, pagination, items.length);
  return jsonResult(200, page, link === undefined ? {} : { link });
}

// ---------------------------------------------------------------------------------------------
// endpoint handlers
// ---------------------------------------------------------------------------------------------

function handleRoot(req: RequestInfo): HttpResult {
  const base = apiBase(req);
  return jsonResult(
    200,
    {
      current_user_url: `${base}/user`,
      current_user_authorizations_html_url: `${base}/user`,
      authorizations_url: `${base}/authorizations`,
      repository_url: `${base}/repos/{owner}/{repo}`,
      user_url: `${base}/users/{user}`,
      user_search_url: `${base}/search/users`,
      rate_limit_url: `${base}/rate_limit`,
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleUserRepos(store: Store, req: RequestInfo): HttpResult {
  if (req.method === 'POST') {
    const body = parseJsonBody(req);
    const name = stringField(body, 'name');
    if (name === undefined || name.length === 0) throw new StoreError(422, 'name is required');
    const description = stringField(body, 'description') ?? '';
    const isPrivate = booleanField(body, 'private') ?? false;
    const repo = store.createRepo(name, description, isPrivate);
    return jsonResult(201, repoJson(req, repo));
  }
  if (req.method === 'GET') {
    const repos = store.listRepos();
    return pagedResult(req, repos.map((repo) => repoJson(req, repo)));
  }
  throw new StoreError(404, 'Not Found');
}

function handleRepo(store: Store, req: RequestInfo, owner: string, name: string): HttpResult {
  const repo = requireRepo(store, owner, name);
  if (req.method === 'GET') return jsonResult(200, repoJson(req, repo));
  if (req.method === 'PATCH') {
    const body = parseJsonBody(req);
    const description = stringField(body, 'description');
    if (description !== undefined) repo.description = description;
    const isPrivate = booleanField(body, 'private');
    if (isPrivate !== undefined) repo.isPrivate = isPrivate;
    repo.updatedAt = store.nowIso();
    return jsonResult(200, repoJson(req, repo));
  }
  if (req.method === 'DELETE') {
    store.deleteRepo(repo.name);
    return emptyResult(204);
  }
  throw new StoreError(404, 'Not Found');
}

function handleBranches(store: Store, req: RequestInfo, owner: string, name: string, rest: string[]): HttpResult {
  const repo = requireRepo(store, owner, name);
  if (req.method !== 'GET') throw new StoreError(404, 'Not Found');
  if (rest.length === 0) {
    const branches = store.branchNames(repo).map((branch) => ({
      name: branch,
      commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '', url: '' },
      protected: false,
    }));
    return pagedResult(req, branches);
  }
  const branch = rest.join('/');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) throw new StoreError(404, 'Not Found');
  return jsonResult(200, {
    name: branch,
    commit: { sha: tip, url: `${apiBase(req)}/repos/${owner}/${name}/commits/${tip}` },
    protected: false,
  });
}

function handleCommits(store: Store, req: RequestInfo, owner: string, name: string): HttpResult {
  const repo = requireRepo(store, owner, name);
  if (req.method !== 'GET') throw new StoreError(404, 'Not Found');
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const tip = store.resolveRef(repo, ref);
  if (tip === undefined) throw new StoreError(404, 'Not Found');
  const oids = store.listCommitOids(repo, tip);
  const commits: unknown[] = [];
  for (const oid of oids) {
    const json = commitJson(req, repo, oid);
    if (json !== null) commits.push(json);
  }
  return pagedResult(req, commits);
}

function handleContents(store: Store, req: RequestInfo, owner: string, name: string, pathParts: string[]): HttpResult {
  const repo = requireRepo(store, owner, name);
  const path = pathParts.join('/');
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === undefined) throw new StoreError(404, 'Not Found');
    const commitObject = repo.objects.get(tip);
    if (commitObject === undefined || commitObject.type !== 'commit') throw new StoreError(404, 'Not Found');
    const treeOid = parseCommit(commitObject.data).tree;
    if (path === '') {
      const entries = store.readDir(repo, treeOid, '');
      if (entries === null) throw new StoreError(404, 'Not Found');
      return jsonResult(200, entries.map((entry) => contentEntryJson(req, repo, entry, '')));
    }
    const found = store.lookupPath(repo, treeOid, path);
    if (found === null) throw new StoreError(404, 'Not Found');
    if (found.isDir) {
      const entries = store.readDir(repo, treeOid, path);
      if (entries === null) throw new StoreError(404, 'Not Found');
      return jsonResult(200, entries.map((entry) => contentEntryJson(req, repo, entry, path)));
    }
    const blob = repo.objects.get(found.entry.oid);
    if (blob === undefined) throw new StoreError(404, 'Not Found');
    return jsonResult(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: found.entry.name,
      path,
      sha: found.entry.oid,
      content: blob.data.toString('base64'),
      url: `${apiBase(req)}/repos/${owner}/${name}/contents/${path}`,
      html_url: `http://${req.host}/${owner}/${name}/blob/${ref}/${path}`,
      download_url: null,
      _links: {},
    });
  }
  if (req.method === 'PUT') {
    const body = parseJsonBody(req);
    const content = stringField(body, 'content');
    if (content === undefined) throw new StoreError(422, 'content is required');
    const message = stringField(body, 'message') ?? '';
    const sha = stringField(body, 'sha');
    const branch = stringField(body, 'branch');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content, 'base64');
    } catch {
      throw new StoreError(422, 'content must be base64');
    }
    const result = store.putContents(repo, path, bytes, message, branch, sha);
    const status = result.created ? 201 : 200;
    return jsonResult(status, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: pathParts[pathParts.length - 1] ?? '',
        path,
        sha: result.blobSha,
        content,
      },
      commit: { sha: result.commitSha, message },
    });
  }
  if (req.method === 'DELETE') {
    const body = parseJsonBody(req);
    const sha = stringField(body, 'sha');
    if (sha === undefined) throw new StoreError(422, 'sha is required');
    const message = stringField(body, 'message') ?? '';
    const branch = stringField(body, 'branch');
    const result = store.deleteContents(repo, path, message, branch, sha);
    return jsonResult(200, { commit: { sha: result.commitSha, message }, content: null });
  }
  throw new StoreError(404, 'Not Found');
}

function contentEntryJson(
  req: RequestInfo,
  repo: Repo,
  entry: { mode: string; name: string; oid: string },
  dirPath: string,
): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
  const object = repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (object?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${apiBase(req)}/repos/${repo.ownerLogin}/${repo.name}/contents/${path}`,
    html_url: `http://${req.host}/${repo.ownerLogin}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    download_url: isDir ? null : '',
    _links: {},
  };
}

function handleLabels(store: Store, req: RequestInfo, owner: string, name: string): HttpResult {
  const repo = requireRepo(store, owner, name);
  if (req.method === 'POST') {
    const body = parseJsonBody(req);
    const labelName = stringField(body, 'name');
    if (labelName === undefined || labelName.length === 0) throw new StoreError(422, 'name is required');
    const color = stringField(body, 'color') ?? '000000';
    const description = stringField(body, 'description') ?? '';
    const label = store.createLabel(repo, labelName, color, description);
    return jsonResult(201, labelJson(req, repo, label));
  }
  if (req.method === 'GET') {
    return pagedResult(req, store.listLabels(repo).map((label) => labelJson(req, repo, label)));
  }
  throw new StoreError(404, 'Not Found');
}

function handleIssues(store: Store, req: RequestInfo, owner: string, name: string, rest: string[]): HttpResult {
  const repo = requireRepo(store, owner, name);
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = parseJsonBody(req);
      const title = stringField(body, 'title');
      if (title === undefined || title.length === 0) throw new StoreError(422, 'title is required');
      const bodyText = stringField(body, 'body') ?? '';
      const labels = labelNamesFromBody(body);
      const issue = store.createIssue(repo, title, bodyText, labels);
      return jsonResult(201, issueJson(req, repo, issue));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = store.listIssues(repo);
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const ascending = direction === 'asc';
      issues = [...issues].sort((a, b) => {
        let cmp = 0;
        if (sort === 'updated') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.seq - b.seq;
        else if (sort === 'comments') cmp = a.comments.length - b.comments.length || a.seq - b.seq;
        else cmp = a.seq - b.seq;
        return ascending ? cmp : -cmp;
      });
      return pagedResult(req, issues.map((issue) => issueJson(req, repo, issue)));
    }
    throw new StoreError(404, 'Not Found');
  }
  const number = parseNumber(rest[0]!);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      return jsonResult(200, issueJson(req, repo, store.getIssue(repo, number)));
    }
    if (req.method === 'PATCH') {
      const body = parseJsonBody(req);
      const issue = store.getIssue(repo, number);
      const title = stringField(body, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = stringField(body, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      const state = stringField(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      if (body['labels'] !== undefined) {
        const labels = labelNamesFromBody(body);
        for (const labelName of labels) {
          if (!repo.labels.has(labelName.toLowerCase())) throw new StoreError(422, `Label '${labelName}' does not exist`);
        }
        issue.labels = labels;
      }
      issue.updatedAt = store.nowIso();
      return jsonResult(200, issueJson(req, repo, issue));
    }
    throw new StoreError(404, 'Not Found');
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (req.method === 'POST') {
      const body = parseJsonBody(req);
      const text = stringField(body, 'body');
      if (text === undefined) throw new StoreError(422, 'body is required');
      const comment = store.addIssueComment(repo, number, text);
      return jsonResult(201, commentJson(req, repo, comment, 'issues', number));
    }
    if (req.method === 'GET') {
      const issue = store.getIssue(repo, number);
      return pagedResult(req, issue.comments.map((comment) => commentJson(req, repo, comment, 'issues', number)));
    }
  }
  throw new StoreError(404, 'Not Found');
}

function labelNamesFromBody(body: Record<string, unknown>): string[] {
  const value = body['labels'];
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') names.push(item);
      else if (item !== null && typeof item === 'object') {
        const name = (item as Record<string, unknown>)['name'];
        if (typeof name === 'string') names.push(name);
      }
    }
    return names;
  }
  return stringListField(body, 'labels');
}

function handlePulls(store: Store, req: RequestInfo, owner: string, name: string, rest: string[]): HttpResult {
  const repo = requireRepo(store, owner, name);
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = parseJsonBody(req);
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (title === undefined || title.length === 0) throw new StoreError(422, 'title is required');
      if (head === undefined || head.length === 0) throw new StoreError(422, 'head is required');
      if (base === undefined || base.length === 0) throw new StoreError(422, 'base is required');
      const bodyText = stringField(body, 'body') ?? '';
      const pr = store.createPullRequest(repo, title, bodyText, head, base);
      return jsonResult(201, pullRequestJson(req, store, repo, pr));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let prs = store.listPullRequests(repo);
      if (state !== 'all') prs = prs.filter((pr) => pr.state === state);
      prs = [...prs].sort((a, b) => b.seq - a.seq);
      return pagedResult(req, prs.map((pr) => pullRequestJson(req, store, repo, pr)));
    }
    throw new StoreError(404, 'Not Found');
  }
  const number = parseNumber(rest[0]!);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      return jsonResult(200, pullRequestJson(req, store, repo, store.getPullRequest(repo, number)));
    }
    throw new StoreError(404, 'Not Found');
  }
  if (rest[1] === 'files' && rest.length === 2 && req.method === 'GET') {
    const pr = store.getPullRequest(repo, number);
    const { changes } = store.diffPullRequest(repo, pr);
    return jsonResult(200, changes.map((change) => ({
      sha: '',
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    })));
  }
  if (rest[1] === 'merge' && rest.length === 2 && req.method === 'PUT') {
    parseJsonBody(req);
    const pr = store.getPullRequest(repo, number);
    const result = store.mergePullRequest(repo, pr);
    return jsonResult(200, { sha: result.sha, merged: result.merged, message: result.message });
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (req.method === 'POST') {
      const body = parseJsonBody(req);
      const text = stringField(body, 'body');
      if (text === undefined) throw new StoreError(422, 'body is required');
      const comment = store.addPullRequestComment(repo, number, text);
      return jsonResult(201, commentJson(req, repo, comment, 'pulls', number));
    }
    if (req.method === 'GET') {
      const pr = store.getPullRequest(repo, number);
      return pagedResult(req, pr.comments.map((comment) => commentJson(req, repo, comment, 'pulls', number)));
    }
  }
  throw new StoreError(404, 'Not Found');
}

function handleGitRefs(store: Store, req: RequestInfo, owner: string, name: string, rest: string[]): HttpResult {
  const repo = requireRepo(store, owner, name);
  if (rest.length === 0) {
    if (req.method === 'GET') {
      return jsonResult(200, store.listRefs(repo).map(([ref, sha]) => refJson(req, repo, ref, sha)));
    }
    if (req.method === 'POST') {
      const body = parseJsonBody(req);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/')) throw new StoreError(422, 'ref must start with refs/');
      if (sha === undefined || sha.length === 0) throw new StoreError(422, 'sha is required');
      const object = repo.objects.get(sha);
      if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
        throw new StoreError(422, 'sha does not name a commit or tag');
      }
      if (repo.refs.has(ref)) throw new StoreError(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonResult(201, refJson(req, repo, ref, sha));
    }
    throw new StoreError(404, 'Not Found');
  }
  if (req.method !== 'GET') throw new StoreError(404, 'Not Found');
  const refName = `refs/${rest.join('/')}`;
  const exact = repo.refs.get(refName);
  if (exact !== undefined) return jsonResult(200, refJson(req, repo, refName, exact));
  const prefix = store.listRefs(repo).filter(([ref]) => ref.startsWith(`${refName}/`));
  if (prefix.length > 0) {
    return jsonResult(200, prefix.map(([ref, sha]) => refJson(req, repo, ref, sha)));
  }
  throw new StoreError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

/**
 * Handle a request under /api/v3. `segments` are the path segments after the
 * `/api/v3` prefix. Returns null only when the path is not under /api/v3 at all.
 */
export function handleRestRequest(store: Store, req: RequestInfo): HttpResult | null {
  if (req.segments.length < 2 || req.segments[0] !== 'api' || req.segments[1] !== 'v3') return null;
  const segments = req.segments.slice(2);
  try {
    if (segments.length === 0) {
      if (req.method === 'GET') return handleRoot(req);
      throw new StoreError(404, 'Not Found');
    }
    if (segments[0] === 'meta' && segments.length === 1) {
      if (req.method === 'GET') return jsonResult(200, { installed_version: '1.0.0' });
      throw new StoreError(404, 'Not Found');
    }
    if (segments[0] === 'user' && segments.length === 1) {
      if (req.method === 'GET') return jsonResult(200, userJson(req));
      throw new StoreError(404, 'Not Found');
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      return handleUserRepos(store, req);
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1]!;
      const name = segments[2]!;
      const rest = segments.slice(3);
      if (rest.length === 0) return handleRepo(store, req, owner, name);
      if (rest[0] === 'branches') return handleBranches(store, req, owner, name, rest.slice(1));
      if (rest[0] === 'commits' && rest.length === 1) return handleCommits(store, req, owner, name);
      if (rest[0] === 'contents') return handleContents(store, req, owner, name, rest.slice(1));
      if (rest[0] === 'labels' && rest.length === 1) return handleLabels(store, req, owner, name);
      if (rest[0] === 'issues') return handleIssues(store, req, owner, name, rest.slice(1));
      if (rest[0] === 'pulls') return handlePulls(store, req, owner, name, rest.slice(1));
      if (rest[0] === 'git' && rest[1] === 'refs') return handleGitRefs(store, req, owner, name, rest.slice(2));
    }
    throw new StoreError(404, 'Not Found');
  } catch (err) {
    if (err instanceof StoreError) return errorResult(err.status, err.message);
    throw err;
  }
}

export { DEFAULT_BRANCH, parseTree, peelToNonTag };
export type { Repo };
