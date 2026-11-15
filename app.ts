// app.ts — HTTP front door: body parsing, auth, routing to the four surfaces.
// Written from scratch for this entry. Node 22 built-ins only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import {
  errorResponse,
  nextRequestId,
  splitPath,
  type ApiRequest,
  type ApiResponse,
} from './util.ts';

/** Bodies larger than this are refused (packs in this suite stay far below it). */
const MAX_BODY_BYTES = 16 << 20;

/** The token the suite sends; empty in a bare local run (any Bearer then counts). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const expected = expectedToken();
  if (expected === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${expected}`;
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function toApiRequest(req: IncomingMessage, rawBody: Buffer): ApiRequest {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const headers = lowerHeaders(req);
  const contentType = headers['content-type'] ?? '';
  let json: unknown;
  let jsonError = false;
  if (contentType.includes('application/json') && rawBody.length > 0) {
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      jsonError = true;
    }
  }
  return {
    method: req.method ?? 'GET',
    pathname: url.pathname,
    query: url.searchParams,
    headers,
    rawBody,
    json,
    jsonError,
    authed: isAuthed(req),
  };
}

function route(apiReq: ApiRequest): ApiResponse {
  const pathname = apiReq.pathname;
  if (pathname === '/healthz') {
    return { status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true}' };
  }
  if (pathname === '/api/graphql') {
    if (apiReq.method !== 'POST') return errorResponse(404, 'not found');
    return handleGraphQL(apiReq);
  }
  if (pathname === '/mcp') {
    if (apiReq.method === 'DELETE') {
      return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
    }
    if (apiReq.method !== 'POST') return errorResponse(404, 'not found');
    return handleMcp(apiReq);
  }
  if (pathname.startsWith('/api/v3/') || pathname === '/api/v3') {
    return handleRest(apiReq);
  }
  // Git smart HTTP: /<owner>/<repo>.git[/info/refs|/git-upload-pack|/git-receive-pack]
  const parts = splitPath(pathname);
  if (parts.length >= 1 && parts[0].endsWith('.git')) {
    return handleGit(apiReq);
  }
  if (parts.length >= 2 && parts[1].endsWith('.git')) {
    return handleGit(apiReq);
  }
  return errorResponse(404, 'not found');
}

function send(res: ServerResponse, answer: ApiResponse): void {
  const headers: Record<string, string> = {
    'Content-Type': answer.contentType,
    ...(answer.headers ?? {}),
  };
  if (!('x-github-request-id' in headers) && !('X-GitHub-Request-Id' in headers)) {
    headers['X-GitHub-Request-Id'] = nextRequestId();
  }
  if (answer.status === 204 || answer.body === '') {
    res.writeHead(answer.status, headers);
    res.end();
    return;
  }
  const body = typeof answer.body === 'string' ? Buffer.from(answer.body, 'utf8') : answer.body;
  headers['Content-Length'] = String(body.length);
  res.writeHead(answer.status, headers);
  res.end(body);
}

/** Build the forge's HTTP server (not yet listening). */
export function createForgeServer(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawBody = await readBody(req);
        const apiReq = toApiRequest(req, rawBody);
        const answer = route(apiReq);
        send(res, answer);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'internal error';
        try {
          send(res, errorResponse(500, message));
        } catch {
          res.writeHead(500);
          res.end();
        }
      }
    })();
  });
  return server;
}
