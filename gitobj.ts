// gitobj.ts — the git object model: hashing, commit/tree/tag parse and build,
// packfile read/write (with delta resolution), reachability, and the pkt-line codec.
// Original implementation written for this forge from the git wire format; it uses
// only node:crypto and node:zlib. No git binary, no dependencies.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0` + bytes: the object's id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------------------------

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Split a commit/tag object's headers from its message, folding continuation lines. */
function splitHeaders(data: Buffer): { headers: Array<[string, string]>; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const headers: Array<[string, string]> = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && headers.length > 0) {
      const prev = headers[headers.length - 1]!;
      prev[1] += `\n${line}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.push([line.slice(0, space), line.slice(space + 1)]);
  }
  return { headers, message };
}

function headerValue(headers: Array<[string, string]>, name: string): string {
  for (const [key, value] of headers) if (key === name) return value;
  return '';
}

export function parseCommit(data: Buffer): ParsedCommit {
  const { headers, message } = splitHeaders(data);
  const parents: string[] = [];
  for (const [key, value] of headers) if (key === 'parent') parents.push(value.trim());
  return {
    tree: headerValue(headers, 'tree').trim(),
    parents,
    author: headerValue(headers, 'author'),
    committer: headerValue(headers, 'committer'),
    message,
  };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`, `committer ${input.committer}`, '');
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(input.message, 'utf8')]);
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries by name, directories compared as name + '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const { headers, message } = splitHeaders(data);
  return {
    object: headerValue(headers, 'object').trim(),
    type: headerValue(headers, 'type').trim(),
    tag: headerValue(headers, 'tag').trim(),
    tagger: headerValue(headers, 'tagger'),
    message,
  };
}

export function buildTag(input: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const head = `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(input.message, 'utf8')]);
}

/** Peel tags until a non-tag object; returns the final oid (or the input when unknown). */
export function peelToNonTag(lookup: ObjectLookup, oid: string): string {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `tips` (commits walk trees and parents, trees walk entries
 * except gitlinks, tags walk their target). Throws on a missing object unless allowMissing.
 */
export function collectReachable(
  tips: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by following commit parents. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** A merge-base of two commits: the first common ancestor found by BFS from `b`. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    }
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new PackError('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('pack entry size varint is truncated');
    byte = buffer[offset]!;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new PackError('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new PackError('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('ofs-delta base offset is truncated');
    byte = buffer[offset]!;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new PackError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new PackError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new PackError('delta size varint is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new PackError('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new PackError(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new PackError('delta copy offset is truncated');
          copyOffset += delta[offset]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new PackError('delta copy size is truncated');
          copySize += delta[offset]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new PackError('delta copy is out of the base');
      if (written + copySize > targetSize) throw new PackError('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new PackError('delta insert is truncated');
      if (written + literal > targetSize) throw new PackError('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new PackError('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new PackError(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base a thin pack leaves out. Every object's SHA-1
 * is recomputed; a mismatch is an error.
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 32) throw new PackError(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new PackError('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new PackError(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PackError('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new PackError(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new PackError(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new PackError(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new PackError(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new PackError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) throw new PackError(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, checksumOk };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), with the SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new PackError('pack is shorter than its trailer');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

export function verifyPackChecksum(pack: Buffer): boolean {
  return pack.subarray(pack.length - 20).toString('hex') === packChecksum(pack);
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer }
  | { kind: 'response-end'; raw: Buffer };

export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktLineError';
  }
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new PktLineError(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode every pkt-line in `buffer`. Returns the packets and the offset of the first
 * byte after the last complete packet (trailing bytes, e.g. a raw pack, start there).
 * Throws on a malformed header. A trailing partial packet is left unconsumed.
 */
export function decodePktLines(buffer: Buffer): { packets: GitPacket[]; consumed: number } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const headerText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(headerText)) throw new PktLineError(`invalid pkt-line length ${JSON.stringify(headerText)}`);
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new PktLineError(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) break;
    const raw = buffer.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, consumed: offset };
}

/**
 * Decode pkt-lines until (and including) the first flush, without looking past it:
 * the bytes after the flush may be a raw pack, which is not pkt-line framed.
 * Returns the packets and the trailing bytes. Throws on a malformed header before
 * the flush. A trailing partial packet is left unconsumed.
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: GitPacket[]; rest: Buffer } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const headerText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(headerText)) throw new PktLineError(`invalid pkt-line length ${JSON.stringify(headerText)}`);
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new PktLineError(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) break;
    const raw = buffer.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Split one pkt-line stream into its data-packet payloads as strings (flush/delim dropped). */
export function packetLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}
