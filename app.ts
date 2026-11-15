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

/** The token the suite sends; empty in a bare local run (any Bearer then counts).
 *  Read once at startup: the env cannot change under a running server, and
 *  re-reading it plus rebuilding the Bearer string on every request is pure
 *  overhead on the hottest path (2,000 sequential issue reads). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EXPECTED_AUTH = EXPECTED_TOKEN === '' ? '' : `Bearer ${EXPECTED_TOKEN}`;

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (EXPECTED_TOKEN === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === EXPECTED_AUTH;
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
  // `new URL(...)` per request is pure overhead on the hottest path (2,000
  // sequential issue reads): it parses scheme/host/port we never use. The
  // request-target here is always an origin-form path, so split it by hand:
  // strip a fragment, split off the query, and build the search params from
  // the raw query string (URLSearchParams decodes values exactly as URL
  // would). The pathname keeps its percent-encoding, as URL.pathname does;
  // handlers decode segments where they need to.
  const raw = req.url ?? '/';
  let pathname = raw;
  let rawQuery = '';
  const hash = pathname.indexOf('#');
  if (hash >= 0) pathname = pathname.slice(0, hash);
  const q = pathname.indexOf('?');
  if (q >= 0) {
    rawQuery = pathname.slice(q + 1);
    pathname = pathname.slice(0, q);
  }
  if (pathname.length === 0) pathname = '/';
  // Node's IncomingMessage already lowercases every header name, so there is
  // no need to rebuild a lowered copy per request; the raw headers object is
  // used directly (the values this server reads are single strings).
  const headers = req.headers as Record<string, string>;
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
    pathname,
    parts: splitPath(pathname),
    query: new URLSearchParams(rawQuery),
    headers,
    rawBody,
    json,
    jsonError,
    authed: isAuthed(req),
  };
}

async function route(apiReq: ApiRequest): Promise<ApiResponse> {
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
  const parts = apiReq.parts;
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
  if (typeof answer.body === 'string') {
    // Avoid copying the body into a fresh Buffer just to measure it:
    // byteLength gives the exact Content-Length and res.end encodes the
    // string itself.
    headers['Content-Length'] = String(Buffer.byteLength(answer.body, 'utf8'));
    res.writeHead(answer.status, headers);
    res.end(answer.body);
    return;
  }
  headers['Content-Length'] = String(answer.body.length);
  res.writeHead(answer.status, headers);
  res.end(answer.body);
}

/** Build the forge's HTTP server (not yet listening). */
export function createForgeServer(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // Most requests in the suite are body-less GETs (2,000 issue reads):
        // setting up the async body iterator for a request that carries no
        // body is pure overhead. A body is present exactly when the request
        // declares one (content-length > 0 or chunked transfer-encoding);
        // anything else has no body by HTTP semantics, so it is skipped.
        const contentLength = req.headers['content-length'];
        const hasBody =
          (typeof contentLength === 'string' && contentLength !== '0') ||
          req.headers['transfer-encoding'] !== undefined;
        const rawBody = hasBody ? await readBody(req) : Buffer.alloc(0);
        const apiReq = toApiRequest(req, rawBody);
        const answer = await route(apiReq);
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
