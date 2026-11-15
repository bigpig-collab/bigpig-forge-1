// rest.ts — the GitHub REST v3 surface under /api/v3.
// Implements the endpoint catalogue in notes/rest-spec.md against the shared
// store. Written from scratch for this entry. Node 22 built-ins only.

import { parseCommit, store, VIEWER, type Issue, type PullRequest, type Repo } from './store.ts';
import {
  b64decode,
  b64encode,
  errorResponse,
  isRecord,
  jsonResponse,
  splitPath,
  type ApiRequest,
  type ApiResponse,
} from './util.ts';

/** The public shape of one issue. */
function issueShape(issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

/** The public shape of one pull request. */
function pullShape(pr: PullRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: pr.globalId,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
  };
  if (pr.merged) {
    out.merged = true;
    out.merged_at = pr.mergedAt;
    out.merge_commit_sha = pr.mergeCommitSha;
  }
  return out;
}

/** The public shape of one repository. */
function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

/** Load the repo named by the path, or return the 404 response. */
function needRepo(owner: string, name: string): Repo | ApiResponse {
  const repo = store.getRepo(owner, name);
  if (!repo) return errorResponse(404, `repository ${owner}/${name} not found`);
  return repo;
}

/** True when a needRepo result is the error response, not a repository. */
function isErrorResp(value: Repo | ApiResponse): value is ApiResponse {
  return (value as ApiResponse).status !== undefined;
}

/** Parse a positive integer query value, falling back to `fallback`. */
function queryInt(query: URLSearchParams, key: string, fallback: number): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function handleRest(req: ApiRequest): ApiResponse {
  const parts = splitPath(req.pathname);
  // parts[0] === 'api', parts[1] === 'v3', the rest is the route.
  if (parts.length < 2 || parts[0] !== 'api' || parts[1] !== 'v3') {
    return errorResponse(404, 'not found');
  }
  const route = parts.slice(2);

  // Every known REST route requires the shop token; unknown routes are a plain 404.
  const known = isKnownRoute(req.method, route);
  if (!known) return errorResponse(404, 'not found');
  if (!req.authed) return errorResponse(401, 'authentication required');
  if (req.jsonError) return errorResponse(400, 'malformed JSON body');

  // Root and meta.
  if (route.length === 0) {
    if (req.method !== 'GET') return errorResponse(404, 'not found');
    return jsonResponse(200, {}, { 'X-OAuth-Scopes': 'repo' });
  }
  if (route.length === 1 && route[0] === 'meta') {
    if (req.method !== 'GET') return errorResponse(404, 'not found');
    return jsonResponse(200, { installed_version: '1.0.0' });
  }
  if (route.length === 1 && route[0] === 'user') {
    if (req.method !== 'GET') return errorResponse(404, 'not found');
    return jsonResponse(200, {
      id: VIEWER.id,
      login: VIEWER.login,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
  }

  // POST /user/repos and GET /user/repos.
  if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    if (req.method === 'POST') return createRepo(req);
    if (req.method === 'GET') return listUserRepos(req);
    return errorResponse(404, 'not found');
  }

  // /repos/{owner}/{name}[/...]
  if (route.length >= 3 && route[0] === 'repos') {
    const owner = decodeURIComponent(route[1]);
    const name = decodeURIComponent(route[2]);
    const rest = route.slice(3);
    if (rest.length === 0) {
      if (req.method === 'GET') {
        const repo = needRepo(owner, name);
        if (isErrorResp(repo)) return repo;
        return jsonResponse(200, repoShape(repo));
      }
      if (req.method === 'PATCH') return patchRepo(req, owner, name);
      if (req.method === 'DELETE') return deleteRepo(owner, name);
      return errorResponse(404, 'not found');
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && req.method === 'POST') {
      return createGitRef(req, owner, name);
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length >= 4 && req.method === 'GET') {
      return getGitRef(owner, name, rest.slice(2).join('/'));
    }
    if (rest[0] === 'branches' && req.method === 'GET') {
      if (rest.length === 1) return listBranches(owner, name);
      if (rest.length === 2) return getBranch(owner, name, decodeURIComponent(rest[1]));
    }
    if (rest[0] === 'commits' && req.method === 'GET') return listCommits(owner, name, req);
    if (rest[0] === 'contents') return contentsRoute(req, owner, name, rest.slice(1));
    if (rest[0] === 'labels' && req.method === 'POST') return createLabel(req, owner, name);
    if (rest[0] === 'issues') return issuesRoute(req, owner, name, rest.slice(1));
    if (rest[0] === 'pulls') return pullsRoute(req, owner, name, rest.slice(1));
    return errorResponse(404, 'not found');
  }

  return errorResponse(404, 'not found');
}

/** True when the route is one this forge serves (for the auth-first decision). */
function isKnownRoute(method: string, route: string[]): boolean {
  if (route.length === 0) return method === 'GET';
  if (route.length === 1 && (route[0] === 'meta' || route[0] === 'user')) return method === 'GET';
  if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    return method === 'POST' || method === 'GET';
  }
  if (route.length >= 3 && route[0] === 'repos') {
    const rest = route.slice(3);
    if (rest.length === 0) return method === 'GET' || method === 'PATCH' || method === 'DELETE';
    if (rest[0] === 'git' && rest[1] === 'refs') return method === 'POST' || method === 'GET';
    if (rest[0] === 'branches') return method === 'GET';
    if (rest[0] === 'commits') return method === 'GET';
    if (rest[0] === 'contents') return method === 'PUT' || method === 'GET' || method === 'DELETE';
    if (rest[0] === 'labels') return method === 'POST';
    if (rest[0] === 'issues') return true;
    if (rest[0] === 'pulls') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function createRepo(req: ApiRequest): ApiResponse {
  const body = isRecord(req.json) ? req.json : {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return errorResponse(422, 'name is required');
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  const repo = store.createRepo(name, description, isPrivate);
  if (!repo) return errorResponse(422, `repository ${name} already exists`);
  return jsonResponse(201, repoShape(repo));
}

function listUserRepos(req: ApiRequest): ApiResponse {
  const perPage = queryInt(req.query, 'per_page', 30);
  const page = queryInt(req.query, 'page', 1);
  const repos = store.listRepos();
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    const host = req.headers.host ?? '127.0.0.1';
    const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
    headers.Link =
      `<${base}&page=${page + 1}>; rel="next", ` + `<${base}&page=${totalPages}>; rel="last"`;
  }
  return jsonResponse(200, slice.map(repoShape), headers);
}

function patchRepo(req: ApiRequest, owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const body = isRecord(req.json) ? req.json : {};
  if (typeof body.description === 'string') r.description = body.description;
  return jsonResponse(200, repoShape(r));
}

function deleteRepo(owner: string, name: string): ApiResponse {
  if (!store.deleteRepo(owner, name)) return errorResponse(404, `repository ${owner}/${name} not found`);
  return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
}

// ---------------------------------------------------------------------------
// Git refs / branches / commits (REST view of the same store)
// ---------------------------------------------------------------------------

function createGitRef(req: ApiRequest, owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const body = isRecord(req.json) ? req.json : {};
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) {
    return errorResponse(422, 'ref and sha are required');
  }
  const obj = r.objects.get(sha.toLowerCase());
  if (!obj || obj.type !== 'commit') return errorResponse(422, 'sha is not a commit this repository holds');
  r.refs.set(ref, sha.toLowerCase());
  return jsonResponse(201, { ref, object: { sha: sha.toLowerCase() } });
}

function getGitRef(owner: string, name: string, refPath: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const ref = `refs/${refPath}`;
  const sha = r.refs.get(ref);
  if (!sha) return errorResponse(404, `ref ${ref} not found`);
  return jsonResponse(200, { ref, object: { sha } });
}

function listBranches(owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const out = store.branchNames(r).map((branch) => ({
    name: branch,
    commit: { sha: store.branchTip(r, branch) as string },
  }));
  return jsonResponse(200, out);
}

function getBranch(owner: string, name: string, branch: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const sha = store.branchTip(r, branch);
  if (!sha) return errorResponse(404, `branch ${branch} not found`);
  return jsonResponse(200, { name: branch, commit: { sha } });
}

function listCommits(owner: string, name: string, req: ApiRequest): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const shaParam = req.query.get('sha');
  const tip = shaParam !== null ? store.resolveRef(r, shaParam) : store.branchTip(r, r.defaultBranch);
  if (!tip) return jsonResponse(200, []);
  const commits = store.listCommits(r, tip);
  return jsonResponse(200, commits.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function contentsRoute(req: ApiRequest, owner: string, name: string, pathParts: string[]): ApiResponse {
  const path = pathParts.map((p) => decodeURIComponent(p)).join('/');
  if (req.method === 'PUT') return putContents(req, owner, name, path);
  if (req.method === 'GET') return getContents(req, owner, name, path);
  if (req.method === 'DELETE') return deleteContents(req, owner, name, path);
  return errorResponse(404, 'not found');
}

function putContents(req: ApiRequest, owner: string, name: string, path: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const body = isRecord(req.json) ? req.json : {};
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const content = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : r.defaultBranch;
  const bytes = b64decode(content);
  // A branch that does not exist yet starts from the default branch tip
  // (GitHub's behaviour, and the fallback the MCP setup relies on).
  if (store.branchTip(r, branch) === undefined) {
    const defaultTip = store.branchTip(r, r.defaultBranch);
    if (defaultTip !== undefined && branch !== r.defaultBranch) {
      r.refs.set(`refs/heads/${branch}`, defaultTip);
    }
  }
  const tip = store.branchTip(r, branch);
  if (tip !== undefined && typeof body.sha === 'string' && body.sha !== '') {
    const current = store.lookupPath(r, tip, path);
    if (current && current.oid.toLowerCase() !== body.sha.toLowerCase()) {
      return errorResponse(409, 'sha is stale: the file changed since it was read');
    }
  }
  const result = store.putFile(r, branch, path, bytes, message);
  const status = result.created ? 201 : 200;
  return jsonResponse(status, {
    content: { name: path.split('/').pop() ?? path, path, sha: result.blobSha, size: bytes.length, encoding: 'base64', type: 'file' },
    commit: { sha: result.commitSha },
  });
}

function getContents(req: ApiRequest, owner: string, name: string, path: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const refParam = req.query.get('ref');
  const tip = refParam !== null ? store.resolveRef(r, refParam) : store.branchTip(r, r.defaultBranch);
  if (!tip) return errorResponse(404, 'not found');
  if (path === '') return directoryListing(r, tip, '');
  const flat = store.flattenTree(r, tip);
  const file = flat.get(path);
  if (file) {
    const bytes = r.objects.get(file.oid)?.bytes ?? Buffer.alloc(0);
    return jsonResponse(200, {
      type: 'file',
      encoding: 'base64',
      name: path.split('/').pop() ?? path,
      path,
      content: b64encode(bytes.toString('utf8')),
      sha: file.oid,
      size: bytes.length,
    });
  }
  // A directory: any path that is a prefix of a stored path.
  const prefix = `${path}/`;
  const isDir = [...flat.keys()].some((p) => p.startsWith(prefix));
  if (isDir) return directoryListing(r, tip, path);
  return errorResponse(404, 'not found');
}

function directoryListing(repo: Repo, tip: string, dir: string): ApiResponse {
  const prefix = dir === '' ? '' : `${dir}/`;
  const flat = store.flattenTree(repo, tip);
  const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
    } else {
      const sub = rest.slice(0, slash);
      if (!entries.has(sub)) {
        const treeOid = findTreeOid(repo, tip, dir === '' ? sub : `${dir}/${sub}`);
        entries.set(sub, { type: 'dir', name: sub, path: dir === '' ? sub : `${dir}/${sub}`, sha: treeOid });
      }
    }
  }
  const out = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return jsonResponse(200, out);
}

/** The tree oid of a directory path (empty string when unresolvable). */
function findTreeOid(repo: Repo, tip: string, dir: string): string {
  const segments = dir.split('/').filter((s) => s.length > 0);
  const start = repo.objects.get(tip);
  if (!start || start.type !== 'commit') return '';
  const commit = parseCommit(start.bytes);
  if (!commit) return '';
  let current: string | null = commit.tree;
  for (const segment of segments) {
    if (current === null) return '';
    const entries = store.readTree(repo, current);
    const hit = entries.find((e) => e.name === segment && e.mode === '40000');
    if (!hit) return '';
    current = hit.oid;
  }
  return current ?? '';
}

function deleteContents(req: ApiRequest, owner: string, name: string, path: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const body = isRecord(req.json) ? req.json : {};
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : r.defaultBranch;
  const result = store.deleteFile(r, branch, path, message);
  if (!result) return errorResponse(404, 'not found');
  return jsonResponse(200, { commit: { sha: result.commitSha } });
}

// ---------------------------------------------------------------------------
// Labels and issues
// ---------------------------------------------------------------------------

function createLabel(req: ApiRequest, owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const body = isRecord(req.json) ? req.json : {};
  const labelName = typeof body.name === 'string' ? body.name : '';
  if (labelName === '') return errorResponse(422, 'name is required');
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  r.labels.set(labelName, { name: labelName, color });
  return jsonResponse(201, { name: labelName, color });
}

function issuesRoute(req: ApiRequest, owner: string, name: string, rest: string[]): ApiResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') return createIssue(req, owner, name);
    if (req.method === 'GET') return listIssues(req, owner, name);
    return errorResponse(404, 'not found');
  }
  const number = Number.parseInt(rest[0], 10);
  if (!Number.isFinite(number) || number < 1) return errorResponse(404, 'not found');
  if (rest.length === 1) {
    if (req.method === 'GET') return getIssue(owner, name, number);
    if (req.method === 'PATCH') return patchIssue(req, owner, name, number);
    return errorResponse(404, 'not found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (req.method === 'POST') return createComment(req, owner, name, number);
    if (req.method === 'GET') return listComments(owner, name, number);
  }
  return errorResponse(404, 'not found');
}

function createIssue(req: ApiRequest, owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const body = isRecord(req.json) ? req.json : {};
  const title = typeof body.title === 'string' ? body.title : '';
  const issueBody = typeof body.body === 'string' ? body.body : '';
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!r.labels.has(label)) return errorResponse(422, `label ${label} does not exist`);
  }
  const issue = store.createIssue(r, title, issueBody, labels);
  return jsonResponse(201, issueShape(issue));
}

function listIssues(req: ApiRequest, owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'asc';
  const perPage = queryInt(req.query, 'per_page', 30);
  let issues = r.issues;
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  // state=all (or anything else) lists everything.
  issues = [...issues];
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
  }
  return jsonResponse(200, issues.slice(0, perPage).map(issueShape));
}

function getIssue(owner: string, name: string, number: number): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const issue = store.getIssue(r, number);
  if (!issue) return errorResponse(404, `issue #${number} not found`);
  return jsonResponse(200, issueShape(issue));
}

function patchIssue(req: ApiRequest, owner: string, name: string, number: number): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const issue = store.getIssue(r, number);
  if (!issue) return errorResponse(404, `issue #${number} not found`);
  const body = isRecord(req.json) ? req.json : {};
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  else if (typeof body.state === 'string') return errorResponse(422, 'state must be open or closed');
  return jsonResponse(200, issueShape(issue));
}

function createComment(req: ApiRequest, owner: string, name: string, number: number): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const issue = store.getIssue(r, number);
  if (!issue) return errorResponse(404, `issue #${number} not found`);
  const body = isRecord(req.json) ? req.json : {};
  const text = typeof body.body === 'string' ? body.body : '';
  const comment = store.addComment(r, issue, text);
  return jsonResponse(201, { id: comment.id, body: comment.body });
}

function listComments(owner: string, name: string, number: number): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const issue = store.getIssue(r, number);
  if (!issue) return errorResponse(404, `issue #${number} not found`);
  return jsonResponse(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function pullsRoute(req: ApiRequest, owner: string, name: string, rest: string[]): ApiResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') return createPull(req, owner, name);
    if (req.method === 'GET') return listPulls(req, owner, name);
    return errorResponse(404, 'not found');
  }
  const number = Number.parseInt(rest[0], 10);
  if (!Number.isFinite(number) || number < 1) return errorResponse(404, 'not found');
  if (rest.length === 1) {
    if (req.method === 'GET') return getPull(owner, name, number);
    return errorResponse(404, 'not found');
  }
  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    return listPullFiles(owner, name, number);
  }
  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    return mergePull(owner, name, number);
  }
  return errorResponse(404, 'not found');
}

function createPull(req: ApiRequest, owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const body = isRecord(req.json) ? req.json : {};
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  const title = typeof body.title === 'string' ? body.title : '';
  const pullBody = typeof body.body === 'string' ? body.body : '';
  const headSha = head === '' ? undefined : store.branchTip(r, head);
  const baseSha = base === '' ? undefined : store.branchTip(r, base);
  if (headSha === undefined || baseSha === undefined) {
    return errorResponse(422, 'head and base branches must exist');
  }
  const pr = store.createPull(r, title, pullBody, head, base, headSha, baseSha);
  return jsonResponse(201, pullShape(pr));
}

function listPulls(req: ApiRequest, owner: string, name: string): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const state = req.query.get('state');
  const perPage = queryInt(req.query, 'per_page', 30);
  let pulls = r.pulls;
  if (state === 'all') {
    // open and merged alike
  } else {
    pulls = pulls.filter((p) => p.state === 'open');
  }
  return jsonResponse(200, pulls.slice(0, perPage).map(pullShape));
}

function getPull(owner: string, name: string, number: number): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const pr = store.getPull(r, number);
  if (!pr) return errorResponse(404, `pull request #${number} not found`);
  return jsonResponse(200, pullShape(pr));
}

function listPullFiles(owner: string, name: string, number: number): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const pr = store.getPull(r, number);
  if (!pr) return errorResponse(404, `pull request #${number} not found`);
  return jsonResponse(200, store.pullFiles(r, pr));
}

function mergePull(owner: string, name: string, number: number): ApiResponse {
  const repo = needRepo(owner, name);
  if (isErrorResp(repo)) return repo;
  const r = repo as Repo;
  const pr = store.getPull(r, number);
  if (!pr) return errorResponse(404, `pull request #${number} not found`);
  if (pr.merged || pr.state !== 'open') {
    return errorResponse(405, 'pull request is already merged or closed');
  }
  const mergeSha = store.mergePull(r, pr);
  if (mergeSha === null) return errorResponse(405, 'merge conflict: the base changed under this pull request');
  return jsonResponse(200, { merged: true, sha: mergeSha, message: `Pull request #${number} merged` });
}
