// util.ts — small shared helpers for the forge.
// Written from scratch for this entry. Node 22 built-ins only.

import { createHash } from 'node:crypto';

/** SHA-1 of bytes, lowercase 40-hex. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 of a git object: header `<type> <size>\0` + bytes. The hash is fed
 *  incrementally (header, then bytes) so no concatenated copy of the object
 *  is allocated on the hottest path (every pushed object is hashed once). */
export function gitObjectId(type: string, bytes: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${bytes.length}\0`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

/** The all-zero object id: an unborn ref's old/new value. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** Standard-alphabet base64 of UTF-8 text. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 decode, ignoring whitespace (GitHub wraps base64 at newlines). */
export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]/g, ''), 'base64');
}

/** True for a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Count lines the way a diff stat does: trailing newline does not add one. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by the four surfaces.
// ---------------------------------------------------------------------------

/** One parsed request handed to a surface handler. */
export interface ApiRequest {
  method: string;
  pathname: string;
  /** The pathname's `/`-separated segments (empty ones dropped), split once
   *  in toApiRequest so the router and the handlers do not re-split it. */
  parts: string[];
  query: URLSearchParams;
  headers: Record<string, string>;
  rawBody: Buffer;
  /** Parsed JSON body when the content type is JSON and parsing succeeded. */
  json: unknown;
  /** True when a JSON content type was sent but the body did not parse. */
  jsonError: boolean;
  /** True when the Authorization header carries this process's shop token. */
  authed: boolean;
}

/** What a surface handler returns. */
export interface ApiResponse {
  status: number;
  contentType: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

let requestCounter = 0;

/** A fresh request id for the X-GitHub-Request-Id header (format unasserted). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** JSON response with the standard headers every REST/GraphQL/MCP reply carries. */
export function jsonResponse(status: number, value: unknown, extra?: Record<string, string>): ApiResponse {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(value),
    headers: { 'X-GitHub-Request-Id': nextRequestId(), ...(extra ?? {}) },
  };
}

/** The universal error body: a non-empty message string. */
export function errorResponse(status: number, message: string): ApiResponse {
  return jsonResponse(status, { message });
}

/** Split a path into its `/`-separated segments, dropping empty ones. */
export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((part) => part.length > 0);
}
