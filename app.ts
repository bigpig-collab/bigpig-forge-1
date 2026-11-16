// app.ts (SPIKE raw-http) — minimal HTTP/1.1 transport over node:net,
// replacing node:http. Same handlers (handleGit/handleGraphQL/handleMcp/
// handleRest), same ApiRequest shape, same responses — only the transport
// changes: no IncomingMessage/ServerResponse allocation, no llhttp parse,
// no Date/Connection/Keep-Alive headers, one socket.write per response.
// Everything else in this dir is byte-identical to entry-v4.

import { createServer, type Server, type Socket } from 'node:net';
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
/** Header block cap (Node's default maxHeaderSize). */
const MAX_HEADER_BYTES = 16 << 10;
/** Idle keep-alive close, mirroring Node http's 5 s keepAliveTimeout. */
const KEEP_ALIVE_MS = 5_000;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EXPECTED_AUTH = EXPECTED_TOKEN === '' ? '' : `Bearer ${EXPECTED_TOKEN}`;

function isAuthed(headers: Record<string, string>): boolean {
  const header = headers['authorization'] ?? '';
  if (EXPECTED_TOKEN === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === EXPECTED_AUTH;
}

const EMPTY_PARAMS = new URLSearchParams();

function toApiRequest(
  method: string,
  rawTarget: string,
  headers: Record<string, string>,
  rawBody: Buffer,
): ApiRequest {
  let pathname = rawTarget;
  let rawQuery = '';
  // Absolute-form target (a proxy-style request): strip the origin.
  if (pathname.startsWith('http://') || pathname.startsWith('https://')) {
    try {
      const u = new URL(pathname);
      pathname = u.pathname + u.search;
    } catch {
      // fall through with the raw target; routing will 404 it
    }
  }
  const hash = pathname.indexOf('#');
  if (hash >= 0) pathname = pathname.slice(0, hash);
  const q = pathname.indexOf('?');
  if (q >= 0) {
    rawQuery = pathname.slice(q + 1);
    pathname = pathname.slice(0, q);
  }
  if (pathname.length === 0) pathname = '/';
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
    method,
    pathname,
    parts: splitPath(pathname),
    query: rawQuery === '' ? EMPTY_PARAMS : new URLSearchParams(rawQuery),
    headers,
    rawBody,
    json,
    jsonError,
    authed: isAuthed(headers),
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
  const parts = apiReq.parts;
  if (parts.length >= 1 && parts[0].endsWith('.git')) {
    return handleGit(apiReq);
  }
  if (parts.length >= 2 && parts[1].endsWith('.git')) {
    return handleGit(apiReq);
  }
  return errorResponse(404, 'not found');
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** Serialize one response as a single Buffer (head + body, one write). */
function serialize(answer: ApiResponse, closeAfter: boolean): Buffer {
  const headers: Record<string, string> = {
    'Content-Type': answer.contentType,
    ...(answer.headers ?? {}),
  };
  if (!('x-github-request-id' in headers) && !('X-GitHub-Request-Id' in headers)) {
    headers['X-GitHub-Request-Id'] = nextRequestId();
  }
  const bodyBuf =
    typeof answer.body === 'string' ? Buffer.from(answer.body, 'utf8') : answer.body;
  const lines: string[] = [
    `HTTP/1.1 ${answer.status} ${REASONS[answer.status] ?? ''}`,
  ];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  // RFC 9110: no Content-Length on 1xx/204.
  if (answer.status !== 204) lines.push(`Content-Length: ${bodyBuf.length}`);
  if (closeAfter) lines.push('Connection: close');
  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'ascii');
  return answer.status === 204 ? head : Buffer.concat([head, bodyBuf]);
}

interface ParsedRequest {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: Buffer;
  closeAfter: boolean;
}

/**
 * Try to parse ONE complete request from `buf`.
 * Returns { request } when complete, { needMore: true } when truncated,
 * { error: string } on a malformed request line/headers/body.
 * Chunked transfer-encoding is supported (the kit clients send
 * Content-Length, but a conformance check could send chunked).
 */
function tryParseOne(buf: Buffer): { request?: ParsedRequest; needMore?: boolean; error?: string; consumed?: number; expectContinue?: boolean } {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) return { error: 'request headers too large' };
    return { needMore: true };
  }
  const headText = buf.toString('ascii', 0, headEnd);
  const headLines = headText.split('\r\n');
  const requestLine = headLines[0] ?? '';
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (!m) return { error: 'malformed request line' };
  const method = m[1] as string;
  const target = m[2] as string;
  const headers: Record<string, string> = {};
  for (let i = 1; i < headLines.length; i++) {
    const line = headLines[i] as string;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: 'malformed header line' };
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!(name in headers)) headers[name] = value;
  }
  const expectContinue = (headers['expect'] ?? '').toLowerCase().includes('100-continue');
  let pos = headEnd + 4;
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  const chunked = te.includes('chunked');
  let body: Buffer;
  if (chunked) {
    // Parse chunk-size lines until the 0-chunk + trailers.
    const chunks: Buffer[] = [];
    for (;;) {
      const eol = buf.indexOf('\r\n', pos);
      if (eol < 0) return { needMore: true, expectContinue };
      const sizeText = buf.toString('ascii', pos, eol).split(';')[0]?.trim() ?? '';
      const size = parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) return { error: 'malformed chunk size' };
      const dataStart = eol + 2;
      if (size === 0) {
        // Trailer part: lines until an empty line.
        const trailerEnd = buf.indexOf('\r\n\r\n', dataStart);
        if (trailerEnd >= 0) pos = trailerEnd + 4;
        else if (buf.length >= dataStart + 2 && buf[dataStart] === 13 && buf[dataStart + 1] === 10) pos = dataStart + 2;
        else return { needMore: true, expectContinue };
        break;
      }
      if (buf.length < dataStart + size + 2) return { needMore: true, expectContinue };
      chunks.push(Buffer.from(buf.subarray(dataStart, dataStart + size)));
      pos = dataStart + size + 2; // skip trailing CRLF
    }
    body = Buffer.concat(chunks);
  } else {
    const lenRaw = headers['content-length'];
    let len = 0;
    if (lenRaw !== undefined && lenRaw !== '') {
      len = Number(lenRaw);
      if (!Number.isInteger(len) || len < 0) return { error: 'malformed content-length' };
    }
    if (len > MAX_BODY_BYTES) return { error: 'request body too large' };
    if (buf.length < pos + len) return { needMore: true, expectContinue };
    body = len === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(pos, pos + len));
    pos += len;
  }
  if (body.length > MAX_BODY_BYTES) return { error: 'request body too large' };
  const conn = (headers['connection'] ?? '').toLowerCase();
  return {
    request: { method, target, headers, body, closeAfter: conn === 'close' },
    consumed: pos,
  };
}

function writeAsync(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error): void => reject(err);
    socket.once('error', onErr);
    socket.write(data, () => {
      socket.removeListener('error', onErr);
      resolve();
    });
  });
}

/** Build the forge's HTTP server (not yet listening). */
export function createForgeServer(): Server {
  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(KEEP_ALIVE_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let busy = false;
    let closed = false;
    let continueSent = false;
    const processBuffered = (): void => {
      if (busy || closed) return;
      const parsed = tryParseOne(buf);
      if (parsed.error !== undefined) {
        const answer = errorResponse(400, parsed.error);
        const data = serialize(answer, true);
        closed = true;
        socket.write(data, () => socket.destroy());
        return;
      }
      if (parsed.needMore === true || parsed.request === undefined) {
        if (parsed.expectContinue === true && !continueSent) {
          continueSent = true;
          socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        return;
      }
      continueSent = false;
      const req = parsed.request;
      buf = Buffer.from(buf.subarray(parsed.consumed ?? 0));
      busy = true;
      void (async () => {
        try {
          const apiReq = toApiRequest(req.method, req.target, req.headers, req.body);
          const answer = await route(apiReq);
          await writeAsync(socket, serialize(answer, req.closeAfter));
          if (req.closeAfter) {
            closed = true;
            socket.destroy();
            return;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'internal error';
          try {
            await writeAsync(socket, serialize(errorResponse(500, message), true));
          } catch {
            // ignore
          }
          closed = true;
          socket.destroy();
          return;
        }
        busy = false;
        socket.setTimeout(KEEP_ALIVE_MS);
        // More pipelined data may already be buffered.
        processBuffered();
      })();
    };
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      processBuffered();
    });
    socket.on('close', () => {
      closed = true;
    });
  });
  return server;
}
