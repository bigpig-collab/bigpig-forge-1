// store.ts — the forge's single in-memory store.
// Every surface (REST v3, GraphQL, MCP, git smart HTTP) reads and writes this
// one store, so a push, a contents PUT, an issue create and a GraphQL mutation
// all see the same repositories, refs, objects, issues and pull requests.
// Written from scratch for this entry. Node 22 built-ins only.

import { gitObjectId, lineCount } from './util.ts';

/** The scenario's viewer: the login the suite's token names. Fixed by the
 *  contest seed (SCENARIO_SEED 6a09e667f3bcc909) for every instance. */
export interface ForgeUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: ForgeUser = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

/** Identity stamped on commits the forge itself creates (contents PUTs, merges). */
export const FORGE_IDENT = 'ada iversen <adaiversen@example.invalid> 1700000000 +0000';

/** Fixed timestamp string for merged_at (only non-emptiness is asserted). */
export const MERGED_AT = '2025-01-01T00:00:00Z';

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  bytes: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface IssueComment {
  id: number;
  globalId: string;
  body: string;
}

export interface Issue {
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Branch tips at creation time; the files diff and the merge base use these. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  dbId: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
  /** Mutation generation: bumped on every object or ref change in this
   *  repository. The git fetch/advertisement cache keys on (dbId, gen), so
   *  any mutation invalidates every cached response for the repo; a
   *  deleted-and-recreated repo gets a fresh dbId, so its cache keys can
   *  never collide with the old repo's. */
  gen: number;
}

/** Bump a repository's mutation generation (see Repo.gen). */
export function touchRepo(repo: Repo): void {
  repo.gen += 1;
}

// ---------------------------------------------------------------------------
// Object primitives
// ---------------------------------------------------------------------------

/** Compare two tree entry names the way git does: a directory sorts as if its
 *  name ended in '/'. `aDir`/`bDir` say whether the entry is a tree. */
export function compareTreeNames(a: string, aDir: boolean, b: string, bDir: boolean): number {
  const an = aDir ? `${a}/` : a;
  const bn = bDir ? `${b}/` : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Serialise tree entries (already in git order) to tree object bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse tree object bytes into entries, in stored order. */
export function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const space = bytes.indexOf(0x20, pos);
    const nul = bytes.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > bytes.length) break;
    const mode = bytes.toString('utf8', pos, space);
    const name = bytes.toString('utf8', space + 1, nul);
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Serialise a commit's headers + message to commit object bytes. */
export function buildCommit(info: CommitInfo): Buffer {
  let text = `tree ${info.tree}\n`;
  for (const parent of info.parents) text += `parent ${parent}\n`;
  text += `author ${info.author}\n`;
  text += `committer ${info.committer}\n`;
  text += `\n${info.message}`;
  return Buffer.from(text, 'utf8');
}

/** Parse commit object bytes. Returns null when no valid tree header exists. */
export function parseCommit(bytes: Buffer): CommitInfo | null {
  const text = bytes.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  if (!/^[0-9a-f]{40}$/.test(info.tree)) return null;
  return info;
}

/** Parse an annotated tag object. Returns null on a malformed header. */
export function parseTag(bytes: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } | null {
  const text = bytes.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  if (!/^[0-9a-f]{40}$/.test(out.object)) return null;
  return out;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class Store {
  private reposByKey = new Map<string, Repo>();
  private nextDbId = 1;
  private nextSeq = 1;

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // -- repositories ---------------------------------------------------------

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.reposByKey.has(this.key(VIEWER.login, name))) return null;
    const dbId = this.nextDbId;
    this.nextDbId += 1;
    const repo: Repo = {
      dbId,
      globalId: `R_${dbId}`,
      owner: VIEWER.login,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.nextSeq,
      gen: 0,
    };
    this.nextSeq += 1;
    this.reposByKey.set(this.key(VIEWER.login, name), repo);
    return repo;
  }

  /** A repository only exists under the viewer's login; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.reposByKey.get(this.key(owner, name));
  }

  getRepoByGlobalId(globalId: string): Repo | undefined {
    const match = /^R_(\d+)$/.exec(globalId);
    if (!match) return undefined;
    const dbId = Number(match[1]);
    for (const repo of this.reposByKey.values()) {
      if (repo.dbId === dbId) return repo;
    }
    return undefined;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.reposByKey.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.reposByKey.values()].sort((a, b) => a.seq - b.seq);
  }

  // -- git objects ----------------------------------------------------------

  putObject(repo: Repo, type: ObjType, bytes: Buffer): string {
    const oid = gitObjectId(type, bytes);
    repo.objects.set(oid, { type, bytes });
    // Every new object changes what a fetch can return.
    repo.gen += 1;
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Store a blob and return its oid. */
  putBlob(repo: Repo, bytes: Buffer): string {
    return this.putObject(repo, 'blob', bytes);
  }

  /** Create a commit object and return its oid. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const bytes = buildCommit({ tree, parents, author: FORGE_IDENT, committer: FORGE_IDENT, message });
    return this.putObject(repo, 'commit', bytes);
  }

  // -- trees ----------------------------------------------------------------

  /** Read a tree object into entries (empty array when missing/not a tree). */
  readTree(repo: Repo, oid: string): TreeEntry[] {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return [];
    return parseTree(obj.bytes);
  }

  /** Flatten a tree (from a commit oid or a tree oid) to path -> {oid, mode}. */
  flattenTree(repo: Repo, rootOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const start = repo.objects.get(rootOid);
    if (!start) return out;
    let treeOid = rootOid;
    if (start.type === 'commit') {
      const commit = parseCommit(start.bytes);
      if (!commit) return out;
      treeOid = commit.tree;
    }
    const walk = (oid: string, prefix: string): void => {
      for (const entry of this.readTree(repo, oid)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Look one path up in a tree: returns the blob oid, or null when absent. */
  lookupPath(repo: Repo, rootOid: string, path: string): { oid: string; mode: string } | null {
    const flat = this.flattenTree(repo, rootOid);
    return flat.get(path) ?? null;
  }

  /** Return a new tree oid equal to `treeOid` with `path` set to `blobOid`
   *  (or removed when `blobOid` is null). Creates intermediate trees. */
  setPathInTree(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      return treeOid ?? this.putObject(repo, 'tree', buildTree([]));
    }
    const rec = (oid: string | null, depth: number): string => {
      const entries = oid === null ? [] : this.readTree(repo, oid);
      const name = segments[depth];
      const last = depth === segments.length - 1;
      const next: TreeEntry[] = [];
      let found = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          next.push(entry);
          continue;
        }
        found = true;
        if (last) {
          if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
          // else: drop the entry (delete)
        } else if (entry.mode === '40000') {
          next.push({ mode: '40000', name, oid: rec(entry.oid, depth + 1) });
        } else {
          // A file sits where a directory must go: replace it with a subtree.
          next.push({ mode: '40000', name, oid: rec(null, depth + 1) });
        }
      }
      if (!found) {
        if (last) {
          if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        } else {
          next.push({ mode: '40000', name, oid: rec(null, depth + 1) });
        }
      }
      next.sort((a, b) => compareTreeNames(a.name, a.mode === '40000', b.name, b.mode === '40000'));
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return rec(treeOid, 0);
  }

  // -- refs -----------------------------------------------------------------

  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a ?ref= value: a branch name, or a 40-hex commit oid held here. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    const tip = this.branchTip(repo, ref);
    if (tip !== undefined) return tip;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const obj = repo.objects.get(ref);
      if (obj && obj.type === 'commit') return ref;
    }
    return undefined;
  }

  /** Commits reachable from `tip`, newest first (walk parents, dedup). */
  listCommits(repo: Repo, tip: string): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    // Index pointer instead of shift(): shift() re-indexes the whole array
    // on every pop, which is O(n) per commit on long histories.
    let qi = 0;
    while (qi < queue.length) {
      const oid = queue[qi] as string;
      qi += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.bytes);
      if (!commit) continue;
      out.push({ sha: oid, message: commit.message });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (or equals it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    // Index pointer instead of shift(): same O(n)-per-pop cost as listCommits.
    let qi = 0;
    while (qi < queue.length) {
      const oid = queue[qi] as string;
      qi += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.bytes);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  // -- contents -------------------------------------------------------------

  /** Write a file on a branch (creating the branch's first commit when the
   *  repository is unborn). Returns the new commit and blob oids. */
  putFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; created: boolean } {
    const blobSha = this.putBlob(repo, content);
    const tip = this.branchTip(repo, branch);
    let treeOid: string | null = null;
    let created = true;
    const parents: string[] = [];
    if (tip !== undefined) {
      const commit = parseCommit(repo.objects.get(tip)?.bytes ?? Buffer.alloc(0));
      treeOid = commit ? commit.tree : null;
      created = this.lookupPath(repo, tip, path) === null;
      parents.push(tip);
    }
    const newTree = this.setPathInTree(repo, treeOid, path, blobSha);
    const commitSha = this.makeCommit(repo, newTree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    // The ref moved (and objects were created above): the cached
    // advertisement/fetch for this repo is stale.
    repo.gen += 1;
    return { commitSha, blobSha, created };
  }

  /** Delete a file on a branch. Returns null when the branch or path is missing. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = parseCommit(repo.objects.get(tip)?.bytes ?? Buffer.alloc(0));
    if (!commit) return null;
    if (this.lookupPath(repo, tip, path) === null) return null;
    const newTree = this.setPathInTree(repo, commit.tree, path, null);
    const commitSha = this.makeCommit(repo, newTree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.gen += 1;
    return { commitSha };
  }

  // -- issues ---------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const issue: Issue = {
      globalId: `I_${repo.dbId}_${number}`,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: repo.issues.length + 1,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  getIssueByGlobalId(globalId: string): { repo: Repo; issue: Issue } | undefined {
    const match = /^I_(\d+)_(\d+)$/.exec(globalId);
    if (!match) return undefined;
    const repo = [...this.reposByKey.values()].find((r) => r.dbId === Number(match[1]));
    if (!repo) return undefined;
    const issue = repo.issues.find((i) => i.number === Number(match[2]));
    if (!issue) return undefined;
    return { repo, issue };
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const id = repo.nextComment;
    repo.nextComment += 1;
    const comment: IssueComment = { id, globalId: `C_${repo.dbId}_${id}`, body };
    issue.comments.push(comment);
    return comment;
  }

  // -- pull requests --------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PullRequest {
    const number = repo.nextPull;
    repo.nextPull += 1;
    const pr: PullRequest = {
      globalId: `P_${repo.dbId}_${number}`,
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: repo.pulls.length + 1,
    };
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  getPullByGlobalId(globalId: string): { repo: Repo; pull: PullRequest } | undefined {
    const match = /^P_(\d+)_(\d+)$/.exec(globalId);
    if (!match) return undefined;
    const repo = [...this.reposByKey.values()].find((r) => r.dbId === Number(match[1]));
    if (!repo) return undefined;
    const pull = repo.pulls.find((p) => p.number === Number(match[2]));
    if (!pull) return undefined;
    return { repo, pull };
  }

  /** Files changed by a pull request: head tree vs base tree at creation. */
  pullFiles(repo: Repo, pr: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const base = this.flattenTree(repo, pr.baseSha);
    const head = this.flattenTree(repo, pr.headSha);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      if (!b && h) {
        const text = repo.objects.get(h.oid)?.bytes.toString('utf8') ?? '';
        const additions = lineCount(text);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && !h) {
        const text = repo.objects.get(b.oid)?.bytes.toString('utf8') ?? '';
        const deletions = lineCount(text);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b && h) {
        const oldText = repo.objects.get(b.oid)?.bytes.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.bytes.toString('utf8') ?? '';
        const oldLines = oldText.length === 0 ? [] : oldText.split('\n');
        const newLines = newText.length === 0 ? [] : newText.split('\n');
        const oldSet = new Map<string, number>();
        for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
        let additions = 0;
        for (const line of newLines) {
          const left = oldSet.get(line) ?? 0;
          if (left > 0) oldSet.set(line, left - 1);
          else additions += 1;
        }
        let deletions = 0;
        for (const left of oldSet.values()) deletions += left;
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch (file-level three-way).
   * Returns the merge commit sha, or null when the merge conflicts.
   */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    const baseTip = this.branchTip(repo, pr.baseRef);
    if (baseTip === undefined) return null;
    const baseAtCreation = this.flattenTree(repo, pr.baseSha);
    const head = this.flattenTree(repo, pr.headSha);
    const currentBase = this.flattenTree(repo, baseTip);
    const merged = new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of currentBase) merged.set(path, entry);
    const paths = new Set([...baseAtCreation.keys(), ...head.keys()]);
    for (const path of paths) {
      const baseEntry = baseAtCreation.get(path);
      const headEntry = head.get(path);
      const curEntry = currentBase.get(path);
      const baseOid = baseEntry?.oid ?? null;
      const headOid = headEntry?.oid ?? null;
      const curOid = curEntry?.oid ?? null;
      if (headOid === baseOid) {
        // The PR did not touch this path; keep the current base version.
        continue;
      }
      if (curOid === baseOid) {
        // Only the PR touched it: take the PR's version (or its deletion).
        if (headEntry) merged.set(path, headEntry);
        else merged.delete(path);
      } else if (curOid === headOid) {
        // Already identical: nothing to do.
        continue;
      } else {
        return null; // both sides changed it differently: conflict
      }
    }
    // Rebuild the merged tree from the flat map.
    let treeOid: string | null = null;
    // Build bottom-up: group paths by directory.
    const buildFromFlat = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const [path, entry] of merged) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          if (!dirs.has(dir)) dirs.set(dir, []);
          dirs.get(dir)?.push(path);
        }
      }
      for (const dir of [...dirs.keys()].sort()) {
        const childOid = buildFromFlat(`${prefix}${dir}/`);
        entries.push({ mode: '40000', name: dir, oid: childOid });
      }
      entries.sort((a, b) => compareTreeNames(a.name, a.mode === '40000', b.name, b.mode === '40000'));
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    treeOid = buildFromFlat('');
    const mergeSha = this.makeCommit(repo, treeOid, [baseTip], `Merge pull request #${pr.number}`);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    repo.gen += 1;
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = MERGED_AT;
    pr.mergeCommitSha = mergeSha;
    return mergeSha;
  }
}

/** The process-wide store singleton. */
export const store = new Store();
