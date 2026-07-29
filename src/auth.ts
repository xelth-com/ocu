import type { FastifyReply, FastifyRequest } from "fastify";
import { UnauthorizedError } from "./errors.js";

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 * Returns null if the header is missing or not a well-formed Bearer header.
 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * True iff the Authorization header carries a Bearer token present in `keys`.
 * Uses constant-ish membership via Set; keys are compared exactly.
 */
export function isAuthorized(header: string | undefined, keys: ReadonlySet<string>): boolean {
  const token = extractBearer(header);
  return token !== null && keys.has(token);
}

/**
 * Build a Fastify `onRequest` hook that enforces Bearer auth against the given
 * key set. Attach it only to the authenticated route scope; leave /v1/health
 * out of that scope so it stays public.
 */
export function makeAuthHook(apiKeys: readonly string[]) {
  const keys = new Set(apiKeys);
  return async function authHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!isAuthorized(req.headers.authorization, keys)) {
      // Thrown, not replied — the central error handler renders the envelope.
      throw new UnauthorizedError();
    }
  };
}
