// mcp.ts — MCP (Model Context Protocol) surface for the forge.
// Streamable-HTTP JSON-RPC endpoint: POST /mcp (DELETE /mcp tears a session
// down). Two eras: the modern 2026-07-28 server/discover probe and the
// legacy initialize handshake. Six tools, all backed by the shared store.
// Written from scratch for this entry. Node 22 built-ins only.

import { store, VIEWER } from './store.ts';
import type { ApiRequest, ApiResponse } from './util.ts';
import { errorResponse, isRecord, jsonResponse } from './util.ts';

const SERVER_NAME = 'bigpig-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';

const LEGACY_VERSIONS: string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------
// JSON-RPC envelopes
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): ApiResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): ApiResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return jsonResponse(200, { jsonrpc: '2.0', id, error });
}

function rpcParseError(id: unknown): ApiResponse {
  return jsonResponse(400, {
    jsonrpc: '2.0',
    id,
    error: { code: -32700, message: 'Parse error' },
  });
}

/** Extract a numeric "id" from raw (malformed) body text, else null. */
function extractId(raw: string): number | null {
  const match = /"id"\s*:\s*(\d+)/.exec(raw);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// tools/list — built once so two consecutive calls are byte-identical.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, Record<string, string>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const REQUIRED_ARGS: Record<string, string[]> = {};
for (const tool of TOOLS) REQUIRED_ARGS[tool.name] = tool.inputSchema.required;

// ---------------------------------------------------------------------------
// tools/call results
// ---------------------------------------------------------------------------

function toolOk(id: unknown, result: unknown): ApiResponse {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  });
}

function toolFail(id: unknown, message: string): ApiResponse {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown): boolean {
  return value === true;
}

/** Accept a pull number as a number or a digit string; null when unusable. */
function asPullNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function callTool(id: unknown, name: string, args: Record<string, unknown>): ApiResponse {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      const description = asString(args.description);
      const isPrivate = asBool(args.private);
      // An `owner` argument, if sent, is ignored: repos are always created
      // under the viewer login.
      const repo = store.createRepo(repoName, description, isPrivate);
      if (repo === null) return toolFail(id, 'repository already exists');
      return toolOk(id, {
        name: repo.name,
        full_name: `${VIEWER.login}/${repo.name}`,
        private: repo.private,
        id: repo.dbId,
        owner: { login: VIEWER.login },
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFail(id, 'repository not found');
      return toolOk(id, {
        name: repo.name,
        full_name: `${VIEWER.login}/${repo.name}`,
        private: repo.private,
        id: repo.dbId,
        owner: { login: VIEWER.login },
        default_branch: repo.defaultBranch,
        description: repo.description,
      });
    }
    case 'create_issue': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFail(id, 'repository not found');
      const issue = store.createIssue(repo, asString(args.title), asString(args.body), []);
      return toolOk(id, {
        number: issue.number,
        id: issue.globalId,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      });
    }
    case 'list_issues': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFail(id, 'repository not found');
      const state = asString(args.state);
      const issues = repo.issues
        .filter((issue) => {
          if (state === '' || state === 'all') return true;
          if (state === 'open') return issue.state === 'open';
          if (state === 'closed') return issue.state === 'closed';
          return true;
        })
        .map((issue) => ({
          number: issue.number,
          id: issue.globalId,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        }));
      return toolOk(id, { issues });
    }
    case 'create_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFail(id, 'repository not found');
      const head = asString(args.head);
      const base = asString(args.base);
      const headSha = store.branchTip(repo, head);
      if (headSha === undefined) return toolFail(id, `branch not found: ${head}`);
      const baseSha = store.branchTip(repo, base);
      if (baseSha === undefined) return toolFail(id, `branch not found: ${base}`);
      const pr = store.createPull(repo, asString(args.title), asString(args.body), head, base, headSha, baseSha);
      return toolOk(id, {
        number: pr.number,
        id: pr.globalId,
        title: pr.title,
        state: pr.state,
        head: { ref: pr.headRef, sha: pr.headSha },
        base: { ref: pr.baseRef, sha: pr.baseSha },
      });
    }
    case 'merge_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFail(id, 'repository not found');
      const pullNumber = asPullNumber(args.pull_number);
      if (pullNumber === null) return toolFail(id, 'invalid pull_number');
      const pr = store.getPull(repo, pullNumber);
      if (pr === undefined) return toolFail(id, 'pull request not found');
      const mergeSha = store.mergePull(repo, pr);
      if (mergeSha === null) return toolFail(id, 'merge conflict');
      return toolOk(id, {
        number: pr.number,
        merged: true,
        state: pr.state,
        merge_commit_sha: mergeSha,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function handleMcp(req: ApiRequest): ApiResponse {
  if (!req.authed) return errorResponse(401, 'Unauthorized');

  if (req.method === 'DELETE') {
    return { status: 204, contentType: 'application/json', body: '' };
  }

  if (req.jsonError) {
    const raw = req.rawBody.toString('utf8');
    return rpcParseError(extractId(raw));
  }

  const body = req.json;
  if (!isRecord(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }

  // Notifications carry no `id` field: acknowledge with an empty 202.
  if (!('id' in body)) {
    return { status: 202, contentType: 'application/json', body: '' };
  }

  const id = body.id;
  const method = body.method;
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  const params = isRecord(body.params) ? body.params : {};

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [MODERN_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      if (!LEGACY_VERSIONS.includes(offered)) {
        return rpcError(id, -32602, `Unsupported protocol version: ${offered}`);
      }
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name.length === 0) {
        return rpcError(id, -32602, 'Invalid params: missing tool name');
      }
      if (!Object.prototype.hasOwnProperty.call(REQUIRED_ARGS, name)) {
        return rpcError(id, -32601, `Method not found: ${name}`);
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing: string[] = [];
      for (const prop of REQUIRED_ARGS[name] as string[]) {
        const value = args[prop];
        if (value === undefined || value === null) missing.push(prop);
      }
      if (missing.length > 0) {
        return rpcError(id, -32602, `Invalid params: missing required property: ${missing.join(', ')}`);
      }
      return callTool(id, name, args);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
