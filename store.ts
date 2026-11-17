// store.ts — the forge's in-memory store: repositories, git objects, refs, issues,
// pull requests, labels. Everything is deterministic: timestamps come from a fixed
// epoch plus a monotonic counter, never from the wall clock, so two runs over the
// same request sequence leave identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToNonTag,
} from './gitobj.ts';
import type { GitObject, GitObjectType, ParsedCommit, TreeEntry } from './gitobj.ts';

export { ZERO_OID };

// The scenario's fixed epoch (2025-01-01T00:00:00Z) plus a per-store tick counter.
// Every timestamp the forge emits — REST bodies, commit headers, GraphQL — derives
// from this counter, so state is a pure function of the request sequence.
export const EPOCH_SEC = 1735689600;

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const REST_IDENT = `${VIEWER.name} <${VIEWER.email}>`;
export const DEFAULT_BRANCH = 'main';

export type IssueState = 'open' | 'closed';

export interface IssueComment {
  readonly id: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: IssueComment[];
  readonly seq: number;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: IssueComment[];
  readonly seq: number;
}

export interface Label {
  readonly name: string;
  color: string;
  description: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly ownerLogin: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pullRequests: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  numberCounter: number;
  readonly seq: number;
}

export interface FlatFile {
  readonly oid: string;
  readonly mode: string;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

function notFound(message = 'Not Found'): StoreError {
  return new StoreError(404, message);
}

function unprocessable(message: string): StoreError {
  return new StoreError(422, message);
}

export class Store {
  private tickCount = 0;
  private repoIdCounter = 0;
  private objectIdCounter = 0;
  private repoSeq = 0;
  private entitySeq = 0;
  private readonly repos = new Map<string, Repo>();

  /** Advance the deterministic clock by one second and return the new timestamp. */
  tick(): number {
    this.tickCount += 1;
    return EPOCH_SEC + this.tickCount;
  }

  /** ISO-8601 form of the deterministic clock, advancing it by one second. */
  nowIso(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  /** ISO-8601 form of a timestamp from the deterministic clock (no advance). */
  static iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  private nextEntitySeq(): number {
    this.entitySeq += 1;
    return this.entitySeq;
  }

  // -----------------------------------------------------------------------------------------
  // repositories
  // -----------------------------------------------------------------------------------------

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const key = name.toLowerCase();
    if (this.repos.has(key)) throw unprocessable(`Repository '${name}' already exists`);
    this.repoIdCounter += 1;
    this.repoSeq += 1;
    const createdAt = this.nowIso();
    const repo: Repo = {
      id: this.repoIdCounter,
      name,
      ownerLogin: VIEWER.login,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt,
      updatedAt: createdAt,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pullRequests: new Map(),
      labels: new Map(),
      numberCounter: 0,
      seq: this.repoSeq,
    };
    this.repos.set(key, repo);
    return repo;
  }

  findRepo(name: string): Repo | undefined {
    return this.repos.get(name.toLowerCase());
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  deleteRepo(name: string): void {
    this.repos.delete(name.toLowerCase());
  }

  nextObjectId(): number {
    this.objectIdCounter += 1;
    return this.objectIdCounter;
  }

  // -----------------------------------------------------------------------------------------
  // objects and refs
  // -----------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, refName: string): string | undefined {
    return repo.refs.get(refName);
  }

  setRef(repo: Repo, refName: string, oid: string): void {
    repo.refs.set(refName, oid);
  }

  deleteRef(repo: Repo, refName: string): void {
    repo.refs.delete(refName);
  }

  listRefs(repo: Repo): Array<[string, string]> {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const refName of repo.refs.keys()) {
      if (refName.startsWith('refs/heads/')) names.push(refName.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Resolve a branch name, full ref, or 40-hex oid to a commit oid (peeling tags). */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (object === undefined) return undefined;
      if (object.type === 'tag') return peelToNonTag(this.lookup(repo), ref);
      if (object.type === 'commit') return ref;
      return undefined;
    }
    const candidates = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const candidate of candidates) {
      const tip = repo.refs.get(candidate);
      if (tip !== undefined) {
        const peeled = peelToNonTag(this.lookup(repo), tip);
        const object = repo.objects.get(peeled);
        if (object !== undefined && object.type === 'commit') return peeled;
        return undefined;
      }
    }
    return undefined;
  }

  /** The default branch's tip as a commit oid, or undefined for an empty repo. */
  headCommit(repo: Repo): string | undefined {
    return this.resolveRef(repo, repo.defaultBranch);
  }

  /** List commits newest-first from `tip`, following first parents then merges. */
  listCommits(repo: Repo, tip: string): ParsedCommit[] {
    const commits: ParsedCommit[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      commits.push(commit);
      for (const parent of commit.parents) queue.push(parent);
    }
    return commits;
  }

  /** Commit oids newest-first from `tip` (BFS over parents, stable). */
  listCommitOids(repo: Repo, tip: string): string[] {
    const oids: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      oids.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return oids;
  }

  // -----------------------------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------------------------

  /** Flatten a tree into path -> {oid, mode} (gitlinks omitted). */
  flattenTree(repo: Repo, treeOid: string): Map<string, FlatFile> {
    const files = new Map<string, FlatFile>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /** Entries at one level of a tree: `dirPath` '' is the root. Returns null when missing. */
  readDir(repo: Repo, treeOid: string, dirPath: string): TreeEntry[] | null {
    if (dirPath === '') {
      const object = repo.objects.get(treeOid);
      return object !== undefined && object.type === 'tree' ? parseTree(object.data) : null;
    }
    const parts = dirPath.split('/').filter((part) => part.length > 0);
    let current = treeOid;
    for (const part of parts) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
      if (entry === undefined) return null;
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    return object !== undefined && object.type === 'tree' ? parseTree(object.data) : null;
  }

  /** Resolve a path in a tree to its entry (file or directory), or null. */
  lookupPath(repo: Repo, treeOid: string, path: string): { entry: TreeEntry; isDir: boolean } | null {
    const parts = path.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) return null;
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) return { entry, isDir: entry.mode === '40000' };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Build (and store) a tree hierarchy from a flat path map; returns the root tree oid. */
  buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, FlatFile>): string {
    interface DirNode {
      readonly files: Map<string, FlatFile>;
      readonly dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/').filter((part) => part.length > 0);
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let child = node.dirs.get(parts[i]!);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(parts[i]!, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1]!, file);
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on top of `parents` with the given tree and message. */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string, ident?: string): string {
    const when = this.tick();
    const identity = ident ?? `${REST_IDENT} ${when} +0000`;
    const data = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message });
    return this.putObject(repo, 'commit', data);
  }

  // -----------------------------------------------------------------------------------------
  // contents API core (shared by REST and MCP)
  // -----------------------------------------------------------------------------------------

  static validateContentPath(path: string): void {
    const parts = path.split('/');
    if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
      throw new StoreError(404, 'Not Found');
    }
  }

  /**
   * Write a file at `path` on `branch` (creating the branch from the default tip when
   * it does not exist). Returns the commit oid and the new blob oid. Mirrors the
   * contents PUT rules: 409 on a stale sha, 422 when the file exists and no sha
   * was given, 422 when the path names a directory.
   */
  putContents(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    expectedSha: string | undefined,
  ): { commitSha: string; blobSha: string; created: boolean } {
    Store.validateContentPath(path);
    const targetBranch = branch ?? repo.defaultBranch;
    const branchRef = `refs/heads/${targetBranch}`;
    let tip = repo.refs.get(branchRef);
    const branchExists = tip !== undefined;
    let baseFiles = new Map<string, FlatFile>();
    let parents: string[] = [];
    if (tip !== undefined) {
      const peeled = peelToNonTag(this.lookup(repo), tip);
      const object = repo.objects.get(peeled);
      if (object !== undefined && object.type === 'commit') {
        tip = peeled;
        parents = [peeled];
        baseFiles = this.flattenTree(repo, parseCommit(object.data).tree);
      } else {
        tip = undefined;
      }
    }
    if (!branchExists) {
      // A new branch starts from the default branch tip (or an empty root when unborn).
      const defaultTip = this.headCommit(repo);
      if (defaultTip !== undefined) {
        const object = repo.objects.get(defaultTip)!;
        parents = [defaultTip];
        baseFiles = this.flattenTree(repo, parseCommit(object.data).tree);
      }
    }
    const existing = baseFiles.get(path);
    if (existing === undefined) {
      // The path may still name a directory in the current tree.
      if (tip !== undefined) {
        const object = repo.objects.get(tip)!;
        const found = this.lookupPath(repo, parseCommit(object.data).tree, path);
        if (found !== null && found.isDir) throw unprocessable(`'${path}' is a directory`);
      }
      if (expectedSha !== undefined) throw new StoreError(409, 'sha does not match the current file');
    } else {
      if (expectedSha === undefined) throw unprocessable(`'${path}' already exists; supply its sha to update it`);
      if (expectedSha !== existing.oid) throw new StoreError(409, 'sha does not match the current file');
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const files = new Map(baseFiles);
    files.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = this.buildTreeFromFiles(repo, files);
    const commitSha = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(branchRef, commitSha);
    repo.updatedAt = this.nowIso();
    return { commitSha, blobSha, created: existing === undefined };
  }

  deleteContents(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    expectedSha: string,
  ): { commitSha: string } {
    Store.validateContentPath(path);
    const targetBranch = branch ?? repo.defaultBranch;
    const branchRef = `refs/heads/${targetBranch}`;
    const tip = this.resolveRef(repo, targetBranch);
    if (tip === undefined) throw notFound();
    const object = repo.objects.get(tip)!;
    const files = this.flattenTree(repo, parseCommit(object.data).tree);
    const existing = files.get(path);
    if (existing === undefined) throw notFound();
    if (expectedSha !== existing.oid) throw new StoreError(409, 'sha does not match the current file');
    files.delete(path);
    const treeOid = this.buildTreeFromFiles(repo, files);
    const commitSha = this.makeCommit(repo, treeOid, [tip], message);
    repo.refs.set(branchRef, commitSha);
    repo.updatedAt = this.nowIso();
    return { commitSha };
  }

  // -----------------------------------------------------------------------------------------
  // labels, issues, pull requests
  // -----------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const existing = repo.labels.get(name.toLowerCase());
    if (existing !== undefined) throw unprocessable(`Label '${name}' already exists`);
    const label: Label = { name, color, description };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()];
  }

  private nextNumber(repo: Repo): number {
    repo.numberCounter += 1;
    return repo.numberCounter;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    for (const name of labelNames) {
      if (!repo.labels.has(name.toLowerCase())) throw unprocessable(`Label '${name}' does not exist`);
    }
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextObjectId(),
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      createdAt: now,
      updatedAt: now,
      comments: [],
      seq: this.nextEntitySeq(),
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw notFound();
    return issue;
  }

  listIssues(repo: Repo): Issue[] {
    return [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
  }

  addIssueComment(repo: Repo, number: number, body: string): IssueComment {
    const issue = this.getIssue(repo, number);
    const now = this.nowIso();
    const comment: IssueComment = { id: this.nextObjectId(), body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    issue.updatedAt = now;
    return comment;
  }

  createPullRequest(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest {
    const head = headRef.includes(':') ? headRef.slice(headRef.indexOf(':') + 1) : headRef;
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (headTip === undefined) throw unprocessable(`Head branch '${head}' does not exist`);
    if (baseTip === undefined) throw unprocessable(`Base branch '${baseRef}' does not exist`);
    for (const pr of repo.pullRequests.values()) {
      if (pr.state === 'open' && pr.headRef === head && pr.baseRef === baseRef) {
        throw unprocessable('A pull request is already open for these branches');
      }
    }
    const now = this.nowIso();
    const pr: PullRequest = {
      id: this.nextObjectId(),
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      merged: false,
      headRef: head,
      baseRef,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      comments: [],
      seq: this.nextEntitySeq(),
    };
    repo.pullRequests.set(pr.number, pr);
    return pr;
  }

  getPullRequest(repo: Repo, number: number): PullRequest {
    const pr = repo.pullRequests.get(number);
    if (pr === undefined) throw notFound();
    return pr;
  }

  listPullRequests(repo: Repo): PullRequest[] {
    return [...repo.pullRequests.values()].sort((a, b) => a.seq - b.seq);
  }

  addPullRequestComment(repo: Repo, number: number, body: string): IssueComment {
    const pr = this.getPullRequest(repo, number);
    const now = this.nowIso();
    const comment: IssueComment = { id: this.nextObjectId(), body, createdAt: now, updatedAt: now };
    pr.comments.push(comment);
    pr.updatedAt = now;
    return comment;
  }

  // -----------------------------------------------------------------------------------------
  // diffs and merges
  // -----------------------------------------------------------------------------------------

  /** Flatten the tree at a commit oid (peeling tags); empty map for an unknown tip. */
  filesAt(repo: Repo, commitOid: string): Map<string, FlatFile> {
    const peeled = peelToNonTag(this.lookup(repo), commitOid);
    const object = repo.objects.get(peeled);
    if (object === undefined || object.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(object.data).tree);
  }

  /** Line-level added/removed counts between two blobs (multiset difference). */
  private lineCounts(before: Buffer | undefined, after: Buffer | undefined): { additions: number; deletions: number } {
    const beforeText = before === undefined ? '' : before.toString('utf8');
    const afterText = after === undefined ? '' : after.toString('utf8');
    const beforeLines = beforeText === '' ? [] : beforeText.split('\n');
    const afterLines = afterText === '' ? [] : afterText.split('\n');
    const counts = new Map<string, number>();
    for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of afterLines) {
      const remaining = counts.get(line) ?? 0;
      if (remaining > 0) counts.set(line, remaining - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const remaining of counts.values()) deletions += remaining;
    return { additions, deletions };
  }

  /** Three-dot diff: files changed from the merge-base of head and base to head. */
  diffPullRequest(repo: Repo, pr: PullRequest): { changes: FileChange[]; base: string | null } {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { changes: [], base: null };
    const headCommit = peelToNonTag(this.lookup(repo), headTip);
    const baseCommit = peelToNonTag(this.lookup(repo), baseTip);
    const base = mergeBase(this.lookup(repo), headCommit, baseCommit);
    const before = base === null ? new Map<string, FlatFile>() : this.filesAt(repo, base);
    const after = this.filesAt(repo, headCommit);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldFile = before.get(path);
      const newFile = after.get(path);
      if (oldFile !== undefined && newFile !== undefined && oldFile.oid === newFile.oid) continue;
      const beforeBlob = oldFile === undefined ? undefined : repo.objects.get(oldFile.oid)?.data;
      const afterBlob = newFile === undefined ? undefined : repo.objects.get(newFile.oid)?.data;
      const { additions, deletions } = this.lineCounts(beforeBlob, afterBlob);
      const status = oldFile === undefined ? 'added' : newFile === undefined ? 'removed' : 'modified';
      changes.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return { changes, base };
  }

  /**
   * Whether the pull request merges cleanly: no path changed on both sides of the
   * merge-base with different results (including delete-vs-modify). Returns false
   * when either branch tip is missing.
   */
  isMergeable(repo: Repo, pr: PullRequest): boolean {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return false;
    const headCommit = peelToNonTag(this.lookup(repo), headTip);
    const baseCommit = peelToNonTag(this.lookup(repo), baseTip);
    const base = mergeBase(this.lookup(repo), headCommit, baseCommit);
    const baseFiles = base === null ? new Map<string, FlatFile>() : this.filesAt(repo, base);
    const headFiles = this.filesAt(repo, headCommit);
    const targetFiles = this.filesAt(repo, baseCommit);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
    for (const path of paths) {
      const baseOid = baseFiles.get(path)?.oid;
      const headOid = headFiles.get(path)?.oid;
      const targetOid = targetFiles.get(path)?.oid;
      const headChanged = headOid !== baseOid;
      const targetChanged = targetOid !== baseOid;
      if (headChanged && targetChanged && headOid !== targetOid) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch: the result tree is the base
   * tip's tree plus the head side's changes since the merge-base. Throws 405 on a
   * conflict, 422 when already merged, 404 when a branch tip is missing.
   */
  mergePullRequest(repo: Repo, pr: PullRequest): { sha: string; merged: boolean; message: string } {
    if (pr.state !== 'open') throw new StoreError(405, 'Pull request is already closed');
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) throw notFound('A branch of this pull request no longer exists');
    if (!this.isMergeable(repo, pr)) throw new StoreError(405, 'Pull request has merge conflicts');
    const headCommit = peelToNonTag(this.lookup(repo), headTip);
    const baseCommit = peelToNonTag(this.lookup(repo), baseTip);
    const base = mergeBase(this.lookup(repo), headCommit, baseCommit);
    const baseFiles = base === null ? new Map<string, FlatFile>() : this.filesAt(repo, base);
    const headFiles = this.filesAt(repo, headCommit);
    const result = new Map(this.filesAt(repo, baseCommit));
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const baseOid = baseFiles.get(path)?.oid;
      const headFile = headFiles.get(path);
      if (headFile !== undefined && headFile.oid !== baseOid) result.set(path, headFile);
      else if (headFile === undefined && baseFiles.has(path)) result.delete(path);
    }
    const treeOid = this.buildTreeFromFiles(repo, result);
    const message = `Merge pull request #${pr.number}\n`;
    const sha = this.makeCommit(repo, treeOid, [baseCommit], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    const now = this.nowIso();
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = now;
    pr.mergeCommitSha = sha;
    pr.updatedAt = now;
    repo.updatedAt = now;
    return { sha, merged: true, message: `Pull request #${pr.number} merged` };
  }

  // -----------------------------------------------------------------------------------------
  // helpers shared by the surfaces
  // -----------------------------------------------------------------------------------------

  /** Reachability of a set of tips within a repo (throws on a missing object). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup(repo));
  }

  ancestor(repo: Repo, ancestor: string, descendant: string): boolean {
    return isAncestor(this.lookup(repo), ancestor, descendant);
  }

  tagTarget(repo: Repo, tagOid: string): string {
    const object = repo.objects.get(tagOid);
    if (object === undefined || object.type !== 'tag') return tagOid;
    return parseTag(object.data).object;
  }

  /** Build an annotated tag object (unused by the suite, kept for completeness). */
  createTagObject(repo: Repo, target: string, type: string, name: string, message: string): string {
    const when = this.tick();
    const tagger = `${REST_IDENT} ${when} +0000`;
    const data = buildTag({ object: target, type, tag: name, tagger, message });
    return this.putObject(repo, 'tag', data);
  }
}

export type { GitObject, GitObjectType, ParsedCommit, TreeEntry };
