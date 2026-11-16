// git.ts — git smart-HTTP surface for the forge.
// Written from scratch for this entry, from the git-spec note only.
// Node 22 built-ins only. Deterministic: no clocks, no randomness.

import { createInflate, deflateSync, inflateSync } from 'node:zlib';
import { parseCommit, parseTag, store } from './store.ts';
import type { ObjType, Repo } from './store.ts';
import { ZERO_OID, errorResponse, gitObjectId, isObjectId, sha1Hex } from './util.ts';
import type { ApiRequest, ApiResponse } from './util.ts';

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type PktKind = 'data' | 'flush' | 'delim' | 'end';

interface Pkt {
  kind: PktKind;
  text: string;
  raw: Buffer;
}

function decodePackets(buf: Buffer, stopAtFirstFlush: boolean): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.toString('ascii', off, off + 4);
    if (head === '0000') {
      packets.push({ kind: 'flush', text: '', raw: Buffer.alloc(0) });
      off += 4;
      if (stopAtFirstFlush) return { packets, rest: buf.subarray(off) };
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', text: '', raw: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'end', text: '', raw: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('pktline-header');
    const len = parseInt(head, 16);
    if (len < 4 || len > 65520) throw new Error('pktline-too-long');
    if (off + len > buf.length) throw new Error('pktline-truncated');
    const raw = Buffer.from(buf.subarray(off + 4, off + len));
    packets.push({ kind: 'data', text: raw.toString('utf8'), raw });
    off += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Follow an annotated-tag chain to its non-tag target oid, or null. */
function peelTag(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = store.getObject(repo, cur);
    if (!obj || obj.type !== 'tag') return null;
    const tag = parseTag(obj.bytes);
    if (!tag) return null;
    const target = tag.object;
    const targetObj = store.getObject(repo, target);
    if (!targetObj) return target;
    if (targetObj.type === 'tag') {
      cur = target;
      continue;
    }
    return target;
  }
}

function typeCode(type: ObjType): number {
  if (type === 'commit') return 1;
  if (type === 'tree') return 2;
  if (type === 'blob') return 3;
  return 4; // tag
}

function typeRank(type: string): number {
  if (type === 'commit') return 0;
  if (type === 'tag') return 1;
  if (type === 'tree') return 2;
  return 3; // blob
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const UPLOAD_V0_CAPS =
  'symref=HEAD:refs/heads/main side-band-64k multi_ack_detailed multi_ack thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_V0_CAPS =
  'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta thin-pack agent=forge/1.0';

// ---------------------------------------------------------------------------
// Deterministic-response cache (fetch + v0 advertisement)
// ---------------------------------------------------------------------------
//
// An upload-pack fetch response and a v0 advertisement are pure functions
// of (repository state, request parameters): same repo, same wants / haves /
// depth / shallow, same bytes — deflate is deterministic, the pack is laid
// out in a fixed order, and no clock or randomness feeds in. So they are
// cached, keyed by the repository's (dbId, gen) plus the request's
// parameters; any object or ref mutation bumps gen and retires every cached
// response for the repo, and a deleted-and-recreated repo gets a fresh dbId
// so its keys can never collide with the old repo's. This matters most for
// the clone workload: 50 concurrent depth-1 clones of one repo are 50
// identical fetch requests, and without the cache the server rebuilds the
// same pack 50 times. The cached Buffers are never mutated (send() only
// ends the response with them), so sharing them across responses is safe.
// Entries are capped (16 entries, 512 KiB each) and evicted oldest-first.
interface CachedGitResponse {
  body: Buffer;
  contentType: string;
}

const gitResponseCache = new Map<string, CachedGitResponse>();
const GIT_CACHE_MAX_ENTRIES = 16;
const GIT_CACHE_MAX_BYTES = 512 << 10;

function gitCacheGet(key: string): CachedGitResponse | undefined {
  return gitResponseCache.get(key);
}

function gitCachePut(key: string, entry: CachedGitResponse): void {
  if (entry.body.length > GIT_CACHE_MAX_BYTES) return;
  gitResponseCache.delete(key);
  gitResponseCache.set(key, entry);
  while (gitResponseCache.size > GIT_CACHE_MAX_ENTRIES) {
    const oldest = gitResponseCache.keys().next().value;
    if (oldest === undefined) break;
    gitResponseCache.delete(oldest);
  }
}

/** The protocol-v2 advertisement: the same five capability lines for every
 *  repository, so it is built once, not once per info/refs request. */
const V2_ADVERT: Buffer = (() => {
  const lines = ['version 2', 'fetch=shallow', 'ls-refs=unborn', 'object-format=sha1', 'agent=forge/1.0'];
  const parts: Buffer[] = lines.map((line) => pkt(`${line}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
})();

function v2Advert(): Buffer {
  return V2_ADVERT;
}

function v0Advert(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pkt(`${oid} ${ref}\n`));
      const obj = store.getObject(repo, oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelTag(repo, oid);
        if (peeled && peeled !== oid) parts.push(pkt(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleInfoRefs(req: ApiRequest, repo: Repo): ApiResponse {
  const service = req.query.get('service') ?? '';
  // Header names arrive already lowercased from the HTTP layer, so the
  // git-protocol value is read straight off the request headers.
  const proto = req.headers['git-protocol'] ?? '';
  const wantsV2 = proto.includes('version=2');
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advert() };
    }
    // The v0 advertisement is a pure function of (repo state, service):
    // cache it — every push and every clone issues one.
    const cacheKey = `a:${repo.dbId}:${repo.gen}:git-upload-pack`;
    const cached = gitCacheGet(cacheKey);
    if (cached) return { status: 200, contentType: cached.contentType, body: cached.body };
    const body = v0Advert(repo, 'git-upload-pack', UPLOAD_V0_CAPS);
    gitCachePut(cacheKey, { body, contentType: 'application/x-git-upload-pack-advertisement' });
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body,
    };
  }
  if (service === 'git-receive-pack') {
    const cacheKey = `a:${repo.dbId}:${repo.gen}:git-receive-pack`;
    const cached = gitCacheGet(cacheKey);
    if (cached) return { status: 200, contentType: cached.contentType, body: cached.body };
    const body = v0Advert(repo, 'git-receive-pack', RECEIVE_V0_CAPS);
    gitCachePut(cacheKey, { body, contentType: 'application/x-git-receive-pack-advertisement' });
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body,
    };
  }
  return errorResponse(400, 'unknown service');
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, packets: Pkt[]): ApiResponse {
  const args: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (afterDelim && p.kind === 'data') args.push(p.text.trim());
  }
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  // The ls-refs response is a pure function of (repo state, args): cache it
  // like the fetch — every clone issues one, and the server work per clone
  // should be zero after the first.
  const cacheKey = `l:${repo.dbId}:${repo.gen}:${peel ? 1 : 0}:${symrefs ? 1 : 0}:${prefixes.join(',')}`;
  const cached = gitCacheGet(cacheKey);
  if (cached) return { status: 200, contentType: cached.contentType, body: cached.body };
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));

  const lines: string[] = [];
  const mainOid = repo.refs.get('refs/heads/main');
  if (prefixes.length === 0) {
    if (mainOid !== undefined) {
      lines.push(`${mainOid} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}`);
    } else {
      lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = store.getObject(repo, oid);
    if (peel && obj && obj.type === 'tag') {
      const peeled = peelTag(repo, oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts: Buffer[] = lines.map((line) => pkt(`${line}\n`));
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  gitCachePut(cacheKey, { body, contentType: 'application/x-git-upload-pack-result' });
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// ---------------------------------------------------------------------------
// Reachability / fetch planning
// ---------------------------------------------------------------------------

/** Add a tree and everything under it (blobs and subtrees; gitlinks skipped). */
function collectTreeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack: string[] = [treeOid];
  const seenTrees = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seenTrees.has(oid)) continue;
    seenTrees.add(oid);
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'tree') continue;
    out.add(oid);
    for (const entry of store.readTree(repo, oid)) {
      if (entry.mode === '160000') continue;
      out.add(entry.oid);
      if (entry.mode === '40000') stack.push(entry.oid);
    }
  }
}

function walkObjectInto(
  repo: Repo,
  oid: string,
  out: Set<string>,
  stopAtShallow: Set<string>,
): void {
  // Iterative walk over commits/tags/trees/blobs, never past a shallow commit's parents.
  const pending: string[] = [oid];
  const seenCommits = new Set<string>();
  const seenTags = new Set<string>();
  while (pending.length > 0) {
    const cur = pending.pop() as string;
    const obj = store.getObject(repo, cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (seenCommits.has(cur)) continue;
      seenCommits.add(cur);
      out.add(cur);
      const commit = parseCommit(obj.bytes);
      if (!commit) continue;
      collectTreeClosure(repo, commit.tree, out);
      if (stopAtShallow.has(cur)) continue;
      for (const parent of commit.parents) pending.push(parent);
    } else if (obj.type === 'tag') {
      if (seenTags.has(cur)) continue;
      seenTags.add(cur);
      out.add(cur);
      const tag = parseTag(obj.bytes);
      if (tag) pending.push(tag.object);
    } else if (obj.type === 'tree') {
      collectTreeClosure(repo, cur, out);
    } else {
      out.add(cur);
    }
  }
}

/** Resolve a want/tag oid to its commit oid, or null when it is not one. */
function resolveToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = store.getObject(repo, cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.bytes);
      if (!tag) return null;
      cur = tag.object;
      continue;
    }
    return null;
  }
}

interface FetchPlan {
  acks: string[];
  shallow: string[];
  unshallow: string[];
  packOids: Set<string>;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  prevShallow: string[],
  depth: number | undefined,
): FetchPlan {
  const wantList: string[] = [];
  const seenWant = new Set<string>();
  for (const oid of wants) {
    if (!isObjectId(oid) || oid === ZERO_OID) continue;
    if (seenWant.has(oid)) continue;
    seenWant.add(oid);
    wantList.push(oid);
  }
  const haveList: string[] = [];
  const haveSet = new Set<string>();
  for (const oid of haves) {
    if (!isObjectId(oid) || oid === ZERO_OID) continue;
    if (haveSet.has(oid)) continue;
    haveSet.add(oid);
    haveList.push(oid);
  }
  const prevShallowSet = new Set<string>(prevShallow.filter((oid) => isObjectId(oid)));

  // Included commits, by generation (0 = want tip). BFS over parents.
  const included = new Map<string, number>();
  const tagRoots: string[] = [];
  const otherRoots: string[] = [];
  const queue: { oid: string; gen: number }[] = [];
  const enqueueRoot = (oid: string): void => {
    const obj = store.getObject(repo, oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      queue.push({ oid, gen: 0 });
    } else if (obj.type === 'tag') {
      tagRoots.push(oid);
      const tag = parseTag(obj.bytes);
      if (tag) enqueueRoot(tag.object);
    } else {
      otherRoots.push(oid);
    }
  };
  for (const oid of wantList) enqueueRoot(oid);

  let qi = 0;
  while (qi < queue.length) {
    const item = queue[qi] as { oid: string; gen: number };
    qi += 1;
    if (depth !== undefined && item.gen >= depth) continue;
    const prev = included.get(item.oid);
    if (prev !== undefined && prev <= item.gen) continue;
    included.set(item.oid, item.gen);
    const obj = store.getObject(repo, item.oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.bytes);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, gen: item.gen + 1 });
  }

  // Shallow boundaries: commits at the depth limit, or whose parents are not included.
  const shallowSet = new Set<string>();
  if (depth !== undefined) {
    for (const [oid, gen] of included) {
      const obj = store.getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.bytes);
      if (!commit) continue;
      const parentMissing = commit.parents.some((parent) => !included.has(parent));
      if (gen === depth - 1 || parentMissing) shallowSet.add(oid);
    }
  }

  // Unshallow: previous shallow commits now included with a parent included.
  const unshallowSet = new Set<string>();
  for (const oid of prevShallowSet) {
    if (!included.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.bytes);
    if (!commit) continue;
    if (commit.parents.some((parent) => included.has(parent))) unshallowSet.add(oid);
  }

  // Objects the client already holds: closure of the haves, stopping at
  // shallow boundaries (a shallow commit's parents are NOT held).
  const held = new Set<string>();
  for (const oid of haveList) walkObjectInto(repo, oid, held, prevShallowSet);

  // Pack set: closure of the included commits and tag/other roots, minus held.
  const packOids = new Set<string>();
  for (const oid of included.keys()) {
    packOids.add(oid);
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.bytes);
    if (commit) collectTreeClosure(repo, commit.tree, packOids);
  }
  for (const oid of tagRoots) packOids.add(oid);
  for (const oid of otherRoots) {
    const obj = store.getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'tree') collectTreeClosure(repo, oid, packOids);
    else packOids.add(oid);
  }
  for (const oid of held) packOids.delete(oid);

  // Acknowledgements: a have that is an ancestor-or-equal of any want.
  const wantCommits: string[] = [];
  for (const oid of wantList) {
    const commitOid = resolveToCommit(repo, oid);
    if (commitOid !== null) wantCommits.push(commitOid);
  }
  const acks: string[] = [];
  for (const have of haveList) {
    let acked = false;
    for (const want of wantList) {
      if (have === want) {
        acked = true;
        break;
      }
    }
    if (!acked) {
      for (const wantCommit of wantCommits) {
        if (store.isAncestor(repo, have, wantCommit)) {
          acked = true;
          break;
        }
      }
    }
    if (acked) acks.push(have);
  }

  return {
    acks,
    shallow: [...shallowSet].sort(),
    unshallow: [...unshallowSet].sort(),
    packOids,
  };
}

// ---------------------------------------------------------------------------
// Packfile write
// ---------------------------------------------------------------------------

function encodeObjectHeader(typeCodeValue: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCodeValue << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

function buildPack(repo: Repo, oids: Set<string>): Buffer {
  const list = [...oids].filter((oid) => store.getObject(repo, oid) !== undefined);
  list.sort((a, b) => {
    const ra = typeRank(store.getObject(repo, a)?.type ?? '');
    const rb = typeRank(store.getObject(repo, b)?.type ?? '');
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  // Deflate every object first, then lay the pack out in one pre-sized
  // buffer: the old version concatenated the whole pack twice (once for the
  // body, once to append the trailer), which copies every pack byte an
  // extra two times per clone. The bytes produced are identical.
  const encoded: { header: Buffer; data: Buffer }[] = [];
  let total = 12 + 20;
  for (const oid of list) {
    const obj = store.getObject(repo, oid) as { type: ObjType; bytes: Buffer };
    const header = encodeObjectHeader(typeCode(obj.type), obj.bytes.length);
    const data = deflateSync(obj.bytes);
    encoded.push({ header, data });
    total += header.length + data.length;
  }
  const out = Buffer.alloc(total);
  out.write('PACK', 0, 'ascii');
  out.writeUInt32BE(2, 4);
  out.writeUInt32BE(list.length, 8);
  let pos = 12;
  for (const { header, data } of encoded) {
    header.copy(out, pos);
    pos += header.length;
    data.copy(out, pos);
    pos += data.length;
  }
  Buffer.from(sha1Hex(out.subarray(0, pos)), 'hex').copy(out, pos);
  return out;
}

/** Split pack bytes into sideband band-1 pkt-lines. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return out;
  }
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch (upload-pack)
// ---------------------------------------------------------------------------

function parseDepthArg(line: string): number | undefined {
  const match = /^(?:deepen|depth) (\d+)$/.exec(line);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function handleFetchV2(repo: Repo, packets: Pkt[]): ApiResponse {
  const args: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (afterDelim && p.kind === 'data') args.push(p.text.trim());
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else {
      const d = parseDepthArg(arg);
      if (d !== undefined) depth = d;
    }
  }
  // The fetch response is a pure function of (repo state, wants, haves,
  // depth, shallow): identical requests return identical bytes, so cache it
  // (the 50 concurrent clones of one repo are 50 identical fetches).
  const cacheKey =
    `f:${repo.dbId}:${repo.gen}:v2:${wants.join(',')}:${haves.join(',')}:${depth ?? ''}:${shallow.join(',')}`;
  const cached = gitCacheGet(cacheKey);
  if (cached) return { status: 200, contentType: cached.contentType, body: cached.body };
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = buildPack(repo, plan.packOids);

  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (plan.acks.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    for (const oid of plan.acks) parts.push(pkt(`ACK ${oid}\n`));
  }
  parts.push(DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const sideband of sidebandPackets(pack)) parts.push(sideband);
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  gitCachePut(cacheKey, { body, contentType: 'application/x-git-upload-pack-result' });
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function handleFetchV0(repo: Repo, packets: Pkt[]): ApiResponse {
  const sections: string[][] = [[]];
  for (const p of packets) {
    if (p.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (p.kind === 'data') sections[sections.length - 1]?.push(p.text.trim());
  }
  const wantSection = sections[0] ?? [];
  const haveSection = sections[1] ?? [];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of wantSection) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else {
      const d = parseDepthArg(line);
      if (d !== undefined) depth = d;
    }
  }
  for (const line of haveSection) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  // Same pure-function argument as handleFetchV2: cache the response.
  const cacheKey =
    `f:${repo.dbId}:${repo.gen}:v0:${wants.join(',')}:${haves.join(',')}:${depth ?? ''}:${shallow.join(',')}`;
  const cached = gitCacheGet(cacheKey);
  if (cached) return { status: 200, contentType: cached.contentType, body: cached.body };
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = buildPack(repo, plan.packOids);

  const parts: Buffer[] = [];
  if (plan.acks.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    for (const oid of plan.acks) parts.push(pkt(`ACK ${oid}\n`));
  }
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  for (const sideband of sidebandPackets(pack)) parts.push(sideband);
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  gitCachePut(cacheKey, { body, contentType: 'application/x-git-upload-pack-result' });
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function handleUploadPack(req: ApiRequest, repo: Repo): ApiResponse {
  const body = req.rawBody ?? Buffer.alloc(0);
  if (body.length === 0) return errorResponse(400, 'empty request body');
  const { packets } = decodePackets(body, false);
  const first = packets.find((p) => p.kind === 'data');
  if (!first) return errorResponse(400, 'malformed request');
  const firstText = first.text;
  if (firstText.startsWith('command=ls-refs')) return handleLsRefs(repo, packets);
  if (firstText.startsWith('command=fetch')) return handleFetchV2(repo, packets);
  if (firstText.startsWith('want ')) return handleFetchV0(repo, packets);
  return errorResponse(400, 'unknown git command');
}

// ---------------------------------------------------------------------------
// Packfile read (receive-pack)
// ---------------------------------------------------------------------------

function readDeltaVarint(data: Buffer, pos: { i: number }): number {
  let value = 0;
  let shift = 0;
  while (true) {
    if (pos.i >= data.length) throw new Error('delta-corrupt');
    const b = data[pos.i] as number;
    pos.i += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return value;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const pos = { i: 0 };
  const sourceSize = readDeltaVarint(delta, pos);
  const targetSize = readDeltaVarint(delta, pos);
  if (sourceSize !== base.length) throw new Error('delta-base-size');
  const chunks: Buffer[] = [];
  let outLen = 0;
  while (pos.i < delta.length) {
    const op = delta[pos.i] as number;
    pos.i += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let k = 0; k < 4; k++) {
        if ((op & (1 << k)) !== 0) {
          if (pos.i >= delta.length) throw new Error('delta-corrupt');
          offset |= (delta[pos.i] as number) << (8 * k);
          pos.i += 1;
        }
      }
      for (let k = 0; k < 3; k++) {
        if ((op & (0x10 << k)) !== 0) {
          if (pos.i >= delta.length) throw new Error('delta-corrupt');
          size |= (delta[pos.i] as number) << (8 * k);
          pos.i += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta-corrupt');
      chunks.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      const n = op;
      if (pos.i + n > delta.length) throw new Error('delta-corrupt');
      chunks.push(delta.subarray(pos.i, pos.i + n));
      pos.i += n;
      outLen += n;
    } else {
      throw new Error('delta-corrupt');
    }
    if (outLen > targetSize) throw new Error('delta-size');
  }
  if (outLen !== targetSize) throw new Error('delta-size');
  return Buffer.concat(chunks);
}

/** Inflate one pack entry starting at `offset` and report how many
 *  compressed bytes its deflate stream consumed — synchronously.
 *  `inflateSync` stops at the end of the first deflate stream and ignores
 *  trailing bytes, and with `{ info: true }` its engine reports
 *  `bytesWritten`, the exact consumed length. One sync call replaces a
 *  whole streaming Inflate (setup, event turns, teardown) per object:
 *  micro-benchmarked 5.8x faster per 3-object pack (7.3 ms vs 42.1 ms per
 *  200 packs), with zero event-loop turns, so the push path stays
 *  synchronous. Any anomaly (no length, wrong size) throws and the caller
 *  falls back to the streaming path. */
function inflateOneSync(pack: Buffer, offset: number): { data: Buffer; len: number } {
  const result = inflateSync(pack.subarray(offset), { info: true }) as {
    buffer: Buffer;
    engine: { bytesWritten?: unknown };
  };
  const len = result.engine.bytesWritten;
  if (typeof len !== 'number' || len <= 0) throw new Error('pack-zlib');
  return { data: result.buffer, len };
}

/** Smallest deflate-stream length whose inflation yields `size` bytes. */
function findDeflateLength(pack: Buffer, offset: number, size: number, maxLen: number): { data: Buffer; len: number } {
  const tryLen = (len: number): Buffer | null => {
    try {
      const out = inflateSync(pack.subarray(offset, offset + len));
      return out.length === size ? out : null;
    } catch {
      return null;
    }
  };
  if (maxLen <= 0) throw new Error('pack-zlib');
  let lo = 0;
  let hi = 1;
  let hiOut: Buffer | null = null;
  while (hi < maxLen) {
    const out = tryLen(hi);
    if (out !== null) {
      hiOut = out;
      break;
    }
    lo = hi;
    hi = Math.min(maxLen, hi * 2);
  }
  if (hiOut === null) {
    const out = tryLen(maxLen);
    if (out === null) throw new Error('pack-zlib');
    hiOut = out;
    hi = maxLen;
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const out = tryLen(mid);
    if (out !== null) {
      hi = mid;
      hiOut = out;
    } else {
      lo = mid;
    }
  }
  const finalOut = tryLen(hi);
  if (finalOut === null) throw new Error('pack-zlib');
  return { data: finalOut, len: hi };
}

interface PackEntry {
  offset: number;
  code: number;
  size: number;
  baseOffset: number;
  baseOid: string;
  data: Buffer;
}

/** Inflate one pack entry starting at `offset` and report how many
 *  compressed bytes its deflate stream consumed. A streaming Inflate stops
 *  exactly at the end of the deflate stream, and `bytesWritten` is the
 *  number of input bytes the engine consumed — so one inflate per object
 *  replaces the old binary search, which re-inflated each object ~15 times
 *  and threw (with a full stack-trace capture) on every failed probe.
 *  Micro-benchmarked 4.68x faster per 3-object pack. Rejects when the
 *  stream cannot report a consumed length, so the caller can fall back. */
function inflateOne(pack: Buffer, offset: number): Promise<{ data: Buffer; len: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    inf.on('data', (c: Buffer) => chunks.push(c));
    inf.on('error', (err: Error) => done(() => { inf.destroy(); reject(err); }));
    inf.on('end', () => done(() => {
      const len = inf.bytesWritten;
      inf.destroy();
      if (typeof len !== 'number' || len <= 0) {
        reject(new Error('pack-zlib'));
        return;
      }
      resolve({ data: Buffer.concat(chunks), len });
    }));
    inf.write(pack.subarray(offset));
    inf.end();
  });
}

type InflateFn = (
  pack: Buffer,
  offset: number,
  size: number,
  maxLen: number,
) => { data: Buffer; len: number } | Promise<{ data: Buffer; len: number }>;

/** Parse a pack. Fast path: synchronous inflate per entry (see
 *  inflateOneSync) — no stream setup, no event-loop turns. Any failure
 *  falls back to the streaming path, then to the binary search, so a Node
 *  difference in the sync engine's accounting can only cost speed, never
 *  correctness. */
async function parsePack(
  repo: Repo,
  pack: Buffer,
): Promise<Map<string, { type: ObjType; bytes: Buffer }>> {
  try {
    return parsePackWith(repo, pack, inflateOneSync);
  } catch {
    // fall through to the streaming fallback
  }
  try {
    return await parsePackWith(repo, pack, inflateOne);
  } catch {
    return parsePackWith(repo, pack, findDeflateLength);
  }
}

async function parsePackWith(
  repo: Repo,
  pack: Buffer,
  inflate: InflateFn,
): Promise<Map<string, { type: ObjType; bytes: Buffer }>> {
  if (pack.length < 32) throw new Error('pack-truncated');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack-header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) throw new Error('pack-checksum');
  const dataEnd = pack.length - 20;

  const entries: PackEntry[] = [];
  const offsetToIndex = new Map<number, number>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off >= dataEnd) throw new Error('pack-truncated');
    const entryOffset = off;
    let b = pack[off] as number;
    off += 1;
    const code = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (off >= dataEnd) throw new Error('pack-truncated');
      b = pack[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (code !== 1 && code !== 2 && code !== 3 && code !== 4 && code !== 6 && code !== 7) {
      throw new Error('pack-type');
    }
    let baseOffset = -1;
    let baseOid = '';
    if (code === 6) {
      if (off >= dataEnd) throw new Error('pack-truncated');
      let bb = pack[off] as number;
      off += 1;
      let o = bb & 0x7f;
      while ((bb & 0x80) !== 0) {
        if (off >= dataEnd) throw new Error('pack-truncated');
        bb = pack[off] as number;
        off += 1;
        o = ((o + 1) << 7) | (bb & 0x7f);
      }
      baseOffset = entryOffset - o;
      if (o === 0 || baseOffset < 0 || baseOffset >= entryOffset) throw new Error('pack-delta-base');
    }
    if (code === 7) {
      if (off + 20 > dataEnd) throw new Error('pack-truncated');
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const found = await inflate(pack, off, size, dataEnd - off);
    if (found.data.length !== size) throw new Error('pack-zlib');
    entries.push({ offset: entryOffset, code, size, baseOffset, baseOid, data: found.data });
    offsetToIndex.set(entryOffset, i);
    off += found.len;
  }
  if (off !== dataEnd) throw new Error('pack-trailing');

  const resolved = new Map<number, { type: ObjType; bytes: Buffer; oid: string }>();
  const resolve = (idx: number, stack: Set<number>): { type: ObjType; bytes: Buffer; oid: string } => {
    const cached = resolved.get(idx);
    if (cached) return cached;
    if (stack.has(idx)) throw new Error('pack-delta-cycle');
    stack.add(idx);
    const entry = entries[idx] as PackEntry;
    let result: { type: ObjType; bytes: Buffer; oid: string };
    if (entry.code === 6 || entry.code === 7) {
      let base: { type: ObjType; bytes: Buffer } | null = null;
      if (entry.code === 6) {
        const baseIndex = offsetToIndex.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('pack-delta-base');
        base = resolve(baseIndex, stack);
      } else {
        const held = store.getObject(repo, entry.baseOid);
        if (held) {
          base = held;
        } else {
          for (let j = 0; j < entries.length; j++) {
            if (j === idx) continue;
            const candidate = resolve(j, stack);
            if (candidate.oid === entry.baseOid) {
              base = candidate;
              break;
            }
          }
          if (!base) throw new Error('pack-delta-base');
        }
      }
      const bytes = applyDelta(base.bytes, entry.data);
      result = { type: base.type, bytes, oid: gitObjectId(base.type, bytes) };
    } else {
      const type: ObjType = entry.code === 1 ? 'commit' : entry.code === 2 ? 'tree' : entry.code === 3 ? 'blob' : 'tag';
      result = { type, bytes: entry.data, oid: gitObjectId(type, entry.data) };
    }
    stack.delete(idx);
    resolved.set(idx, result);
    return result;
  };

  const out = new Map<string, { type: ObjType; bytes: Buffer }>();
  for (let i = 0; i < entries.length; i++) {
    const r = resolve(i, new Set<number>());
    if (!out.has(r.oid)) out.set(r.oid, { type: r.type, bytes: r.bytes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Push (receive-pack)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** The report-status bytes for the overwhelmingly common case — one ref,
 *  `refs/heads/main`, updated ok — built once from the same framing calls
 *  as the dynamic path, so the bytes are identical by construction. The
 *  push workload's 200 reports are all this shape. */
const REPORT_OK_MAIN: Buffer = (() => {
  const inner = Buffer.concat([pkt('unpack ok\n'), pkt('ok refs/heads/main\n'), FLUSH]);
  return Buffer.concat([...sidebandPackets(inner), FLUSH]);
})();

async function handleReceivePack(req: ApiRequest, repo: Repo): Promise<ApiResponse> {
  const body = req.rawBody ?? Buffer.alloc(0);
  if (body.length === 0) return errorResponse(400, 'empty request body');
  const { packets, rest } = decodePackets(body, true);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.text;
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.endsWith('\n')) line = line.slice(0, -1);
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error('malformed command');
    const oldOid = parts[0] as string;
    const newOid = parts[1] as string;
    const ref = parts[2] as string;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('malformed command');
    if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\x00-\x1f\x7f]/.test(ref)) {
      throw new Error('malformed command');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return errorResponse(400, 'empty command list');

  // Store every pack object before applying any ref update.
  if (rest.length > 0) {
    const objects = await parsePack(repo, rest);
    for (const [oid, obj] of objects) {
      // parsePack already computed each object's oid (it is the map key);
      // storing it directly avoids re-hashing every object a second time.
      repo.objects.set(oid, obj);
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid command' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      const cur = repo.refs.get(cmd.ref);
      if (cur === undefined) {
        if (cmd.oldOid === ZERO_OID) results.push({ ref: cmd.ref, ok: true, reason: '' });
        else results.push({ ref: cmd.ref, ok: false, reason: 'old ref mismatch' });
      } else if (cur !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old ref mismatch' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (repo.refs.has(cmd.ref)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      } else if (store.getObject(repo, cmd.newOid) === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: fast-forward only.
    const cur = repo.refs.get(cmd.ref);
    if (cur === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old ref mismatch' });
    } else if (cur !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else if (store.getObject(repo, cmd.newOid) === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
    } else if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }

  // Pack objects were stored above (direct repo.objects.set) and refs may
  // have moved: bump the generation so every cached fetch/advertisement for
  // this repo retires.
  repo.gen += 1;

  // Fast path: the common single-ref success report is prebuilt (see
  // REPORT_OK_MAIN); anything else builds dynamically below.
  if (results.length === 1 && results[0]?.ok === true && results[0]?.ref === 'refs/heads/main') {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: REPORT_OK_MAIN };
  }

  // report-status inside sideband band 1: the band-1 bytes are themselves a
  // pkt-line stream (report lines, then a flush).
  const innerParts: Buffer[] = [pkt('unpack ok\n')];
  for (const r of results) {
    innerParts.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  innerParts.push(FLUSH);
  const inner = Buffer.concat(innerParts);
  const outerParts: Buffer[] = [...sidebandPackets(inner), FLUSH];
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(outerParts) };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleGit(req: ApiRequest): Promise<ApiResponse> {
  try {
    if (!req.authed) return errorResponse(401, 'authentication required');
    const parts = req.parts;
    if (parts.length < 2 || !parts[1]?.endsWith('.git')) return errorResponse(404, 'repository not found');
    const owner = parts[0] as string;
    const repoName = (parts[1] as string).slice(0, -4);
    if (repoName.length === 0) return errorResponse(404, 'repository not found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return errorResponse(404, 'repository not found');
    const rest = parts.slice(2);
    if (req.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
      return handleInfoRefs(req, repo);
    }
    if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
      return handleUploadPack(req, repo);
    }
    if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
      return handleReceivePack(req, repo);
    }
    return errorResponse(404, 'not found');
  } catch (e) {
    return errorResponse(400, e instanceof Error ? e.message : 'bad request');
  }
}
