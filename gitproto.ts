// gitproto.ts — git smart HTTP: info/refs advertisements (upload-pack v2 and v0,
// receive-pack v0), protocol v2 ls-refs and fetch, v0 fetch, and receive-pack pushes.
// All object math lives in gitobj.ts and store.ts; this module is the wire framing.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  decodePktLinesUntilFlush,
  encodePktLines,
  isObjectId,
  packetLines,
  parseCommit,
  parseTag,
  parseTree,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './gitobj.ts';
import type { GitObject, GitPacket } from './gitobj.ts';
import { DEFAULT_BRANCH, Store, VIEWER } from './store.ts';
import type { Repo } from './store.ts';
import { errorResult, headerValue } from './httputil.ts';
import type { HttpResult, RequestInfo } from './httputil.ts';

const AGENT = 'forge/1.0';
const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_PACK_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';
const SIDEBAND_CHUNK = 32768;

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

interface GitRoute {
  readonly owner: string;
  readonly repoName: string;
  readonly action: string;
}

/** Match /<owner>/<repo>.git/info/refs and /<owner>/<repo>.git/git-<service>. */
export function matchGitRoute(req: RequestInfo): GitRoute | null {
  const segments = req.segments;
  if (segments.length < 3) return null;
  const [owner, repoGit] = segments;
  if (owner === undefined || repoGit === undefined) return null;
  if (!repoGit.endsWith('.git')) return null;
  const repoName = repoGit.slice(0, -'.git'.length);
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    return { owner, repoName, action: 'info/refs' };
  }
  if (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
    return { owner, repoName, action: segments[2] };
  }
  return null;
}

function resolveRepo(store: Store, route: GitRoute): Repo | null {
  if (route.owner.toLowerCase() !== VIEWER.login) return null;
  return store.findRepo(route.repoName) ?? null;
}

function notFoundResult(): HttpResult {
  return errorResult(404, 'Not Found');
}

function binaryResult(status: number, contentType: string, body: Buffer): HttpResult {
  return { status, headers: { 'content-type': contentType }, body };
}

/** Peel an annotated tag chain to its ultimate non-tag target (or the input oid). */
function peel(store: Store, repo: Repo, oid: string): string {
  const lookup = store.lookup(repo);
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

function isAnnotatedTag(store: Store, repo: Repo, oid: string): boolean {
  return repo.objects.get(oid)?.type === 'tag';
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function advertiseUploadPackV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow thin-pack ofs-delta\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function advertiseUploadPackV0(store: Store, repo: Repo): Buffer {
  const refs = store.listRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=git-upload-pack\n`), pktFlush()];
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  const lines: string[] = [];
  if (headTip !== undefined) {
    lines.push(`${headTip} HEAD\0${V0_UPLOAD_CAPS}\n`);
  }
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    if (isAnnotatedTag(store, repo, oid)) {
      lines.push(`${peel(store, repo, oid)} ${name}^{}\n`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${V0_UPLOAD_CAPS}\n`));
  } else {
    // When HEAD is absent (no default branch but other refs exist), the capabilities
    // ride on the first ref line instead.
    if (headTip === undefined) {
      const first = lines[0]!;
      lines[0] = first.endsWith('\n') ? `${first.slice(0, -1)}\0${V0_UPLOAD_CAPS}\n` : `${first}\0${V0_UPLOAD_CAPS}\n`;
    }
    for (const line of lines) parts.push(pktLine(line));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseReceivePackV0(store: Store, repo: Repo): Buffer {
  const refs = store.listRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=git-receive-pack\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${V0_RECEIVE_CAPS}\n`));
  } else {
    refs.forEach(([name, oid], index) => {
      const suffix = index === 0 ? `\0${V0_RECEIVE_CAPS}` : '';
      parts.push(pktLine(`${oid} ${name}${suffix}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleInfoRefs(store: Store, req: RequestInfo, route: GitRoute): HttpResult {
  if (req.method !== 'GET') return notFoundResult();
  const repo = resolveRepo(store, route);
  if (repo === null) return notFoundResult();
  const service = req.query.get('service') ?? '';
  if (service === 'git-upload-pack') {
    const protocol = headerValue(req.headers, 'git-protocol');
    if (protocol === 'version=2') {
      return binaryResult(200, UPLOAD_PACK_ADVERTISEMENT, advertiseUploadPackV2());
    }
    return binaryResult(200, UPLOAD_PACK_ADVERTISEMENT, advertiseUploadPackV0(store, repo));
  }
  if (service === 'git-receive-pack') {
    return binaryResult(200, RECEIVE_PACK_ADVERTISEMENT, advertiseReceivePackV0(store, repo));
  }
  return notFoundResult();
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(store: Store, repo: Repo, args: string[]): Buffer {
  const options: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const arg of args) {
    if (arg === 'peel') options.peel = true;
    else if (arg === 'symrefs') options.symrefs = true;
    else if (arg === 'unborn') options.unborn = true;
    else if (arg.startsWith('ref-prefix ')) options.prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix')) options.prefixes.push(arg.slice('ref-prefix'.length).trim());
  }
  const matchesPrefix = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (headTip !== undefined && matchesPrefix('HEAD')) {
    const attrs = options.symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : '';
    lines.push(`${headTip} HEAD${attrs}\n`);
  }
  for (const [name, oid] of store.listRefs(repo)) {
    if (!matchesPrefix(name)) continue;
    let attrs = '';
    if (options.peel && isAnnotatedTag(store, repo, oid)) {
      attrs += ` peeled:${peel(store, repo, oid)}`;
    }
    lines.push(`${oid} ${name}${attrs}\n`);
  }
  if (lines.length === 0 && options.unborn && repo.refs.size === 0 && matchesPrefix('HEAD')) {
    lines.push(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch object selection (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly knownHaves: string[];
}

function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  oldShallow: string[],
): FetchPlan {
  const lookup = store.lookup(repo);
  // BFS over commit parents from the wants, measuring distance. Tag wants peel to
  // their commit at the same distance; the tag object itself is always included.
  const distances = new Map<string, number>();
  const tagObjects = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const want of wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.add(want);
      const peeled = peel(store, repo, want);
      const target = lookup(peeled);
      if (target !== undefined && target.type === 'commit') queue.push({ oid: peeled, distance: 0 });
      else if (target !== undefined) tagObjects.add(peeled);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, distance: 0 });
    } else {
      // A direct want of a tree or blob: include it and its closure below.
      tagObjects.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    const known = distances.get(oid);
    if (known !== undefined && known <= distance) continue;
    distances.set(oid, distance);
    // A depth limit cuts the walk: ancestors at or beyond it can neither be
    // sent nor name a shallow boundary, so their parents are never expanded.
    if (depth !== undefined && distance >= depth) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, distance: distance + 1 });
    }
  }

  const includedCommits = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const [oid, distance] of distances) {
    if (depth !== undefined && distance >= depth) continue;
    includedCommits.add(oid);
    if (depth !== undefined) {
      const object = lookup(oid);
      const parents = object !== undefined && object.type === 'commit' ? parseCommit(object.data).parents : [];
      if (distance === depth - 1 && parents.length > 0) shallow.push(oid);
      if (oldShallow.includes(oid) && distance < depth - 1) unshallow.push(oid);
    }
  }

  // Closure of everything included, minus the full closure of the haves. The
  // closure is depth-aware: an included commit contributes itself plus its tree
  // closure, never its parents (a depth-1 fetch must not carry history).
  const included = new Set<string>();
  for (const oid of includedCommits) {
    included.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      const treeClosure = collectReachable([parseCommit(object.data).tree], lookup, { allowMissing: true });
      for (const reachable of treeClosure) included.add(reachable);
    }
  }
  for (const oid of tagObjects) {
    included.add(oid);
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      // Walk the tag chain so nested tags resolve; a non-commit target adds its
      // own closure (a commit target is already handled above via the BFS).
      let current = oid;
      const seenTags = new Set<string>();
      for (;;) {
        if (seenTags.has(current)) break;
        seenTags.add(current);
        const currentObject = lookup(current);
        if (currentObject === undefined || currentObject.type !== 'tag') {
          if (currentObject !== undefined && currentObject.type !== 'commit') {
            const targetClosure = collectReachable([current], lookup, { allowMissing: true });
            for (const reachable of targetClosure) included.add(reachable);
          }
          break;
        }
        included.add(current);
        current = parseTag(currentObject.data).object;
      }
    } else if (object.type === 'tree') {
      const treeClosure = collectReachable([oid], lookup, { allowMissing: true });
      for (const reachable of treeClosure) included.add(reachable);
    }
  }
  const haveClosure = heldClosure(store, repo, haves, oldShallow);
  const objects: GitObject[] = [];
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  }
  const knownHaves = haves.filter((have) => lookup(have) !== undefined);
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort(), knownHaves };
}

/**
 * What the fetching client already holds: the closure of its haves, except that
 * the parents of an old shallow commit are NOT held — the shallow boundary cut
 * them off in the client's clone, so the server must be willing to send them.
 */
function heldClosure(store: Store, repo: Repo, haves: string[], oldShallow: string[]): Set<string> {
  const lookup = store.lookup(repo);
  const shallowSet = new Set(oldShallow);
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || held.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      const treeClosure = collectReachable([commit.tree], lookup, { allowMissing: true });
      for (const reachable of treeClosure) held.add(reachable);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return held;
}

function sidebandPackets(payload: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += SIDEBAND_CHUNK) {
    const chunk = payload.subarray(offset, Math.min(payload.length, offset + SIDEBAND_CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

function packfileSection(objects: GitObject[], sectionHeader: boolean): Buffer[] {
  const pack = writePack(objects);
  const header = sectionHeader ? [pktLine('packfile\n')] : [];
  return [...header, ...sidebandPackets(pack), pktFlush()];
}

// ---------------------------------------------------------------------------------------------
// protocol v2: fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV2(store: Store, repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) oldShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
    // thin-pack / no-progress / ofs-delta / filter / done: noted, no action needed.
  }
  const plan = planFetch(store, repo, wants, haves, depth, oldShallow);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.knownHaves.length > 0) {
      for (const have of plan.knownHaves) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktFlush());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(...packfileSection(plan.objects, true));
  return Buffer.concat(parts);
}

/** Split a v2 request body into its command section and its argument lines. */
function splitV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let seenDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (!seenDelim) lines.push(line);
    else args.push(line);
  }
  const commandLine = lines.find((line) => line.startsWith('command=')) ?? '';
  return { command: commandLine.slice('command='.length), args };
}

function handleUploadPack(store: Store, req: RequestInfo, route: GitRoute): HttpResult {
  if (req.method !== 'POST') return notFoundResult();
  const repo = resolveRepo(store, route);
  if (repo === null) return notFoundResult();
  let packets: GitPacket[];
  try {
    packets = decodePktLines(req.body).packets;
  } catch {
    return errorResult(400, 'Malformed git request');
  }
  const lines = packetLines(packets);
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    const { command, args } = splitV2Request(req.body);
    if (command === 'ls-refs') {
      return binaryResult(200, UPLOAD_PACK_RESULT, handleLsRefs(store, repo, args));
    }
    if (command === 'fetch') {
      return binaryResult(200, UPLOAD_PACK_RESULT, handleFetchV2(store, repo, args));
    }
    return errorResult(400, `Unsupported git command ${command}`);
  }
  // Protocol v0 fetch: wants + shallow/deepen, flush, haves + done, flush.
  return binaryResult(200, UPLOAD_PACK_RESULT, handleFetchV0(store, repo, packets));
}

function handleFetchV0(store: Store, repo: Repo, packets: GitPacket[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let depth: number | undefined;
  let afterFirstFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      afterFirstFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (!afterFirstFlush) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const nul = rest.indexOf('\0');
        wants.push((nul === -1 ? rest : rest.slice(0, nul)).trim());
      } else if (line.startsWith('shallow ')) oldShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const parsed = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(store, repo, wants, haves, depth, oldShallow);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    if (plan.knownHaves.length > 0) {
      for (const have of plan.knownHaves) parts.push(pktLine(`ACK ${have}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...packfileSection(plan.objects, false));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(store: Store, req: RequestInfo, route: GitRoute): HttpResult {
  if (req.method !== 'POST') return notFoundResult();
  const repo = resolveRepo(store, route);
  if (repo === null) return notFoundResult();

  let packets: GitPacket[];
  let packBytes: Buffer;
  try {
    const decoded = decodePktLinesUntilFlush(req.body);
    packets = decoded.packets;
    packBytes = decoded.rest;
  } catch {
    return errorResult(400, 'Malformed git request');
  }

  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').trimEnd();
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        for (const cap of line.slice(nul + 1).split(' ')) {
          if (cap.length > 0) capabilities.add(cap);
        }
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isObjectId(parts[0]!) && isObjectId(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }

  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, { resolveBase: store.lookup(repo) });
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = (err as Error).message;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = 'non-fast-forward';
    if (!unpackOk) {
      reason = 'unpacker error';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reason = 'non-fast-forward';
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reason = 'non-fast-forward';
      } else {
        repo.refs.delete(command.ref);
        ok = true;
      }
    } else {
      const object = repo.objects.get(command.newOid);
      if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
        reason = 'non-fast-forward';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reason = 'non-fast-forward';
        } else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else if (current === undefined || current !== command.oldOid) {
        reason = 'non-fast-forward';
      } else if (command.newOid === command.oldOid) {
        ok = true;
      } else if (store.ancestor(repo, command.oldOid, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      } else {
        reason = 'non-fast-forward';
      }
    }
    results.push({ ref: command.ref, ok, reason });
  }

  const reportLines: Array<string | 'flush'> = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'error'}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  reportLines.push('flush');
  const report = encodePktLines(reportLines);
  const body = capabilities.has('side-band-64k')
    ? Buffer.concat([...sidebandPackets(report), pktFlush()])
    : report;
  return binaryResult(200, RECEIVE_PACK_RESULT, body);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export function handleGitRequest(store: Store, req: RequestInfo): HttpResult | null {
  const route = matchGitRoute(req);
  if (route === null) return null;
  if (route.action === 'info/refs') return handleInfoRefs(store, req, route);
  if (route.action === 'git-upload-pack') return handleUploadPack(store, req, route);
  return handleReceivePack(store, req, route);
}

export { parseTree, parseCommit };
