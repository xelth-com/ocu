import { InvalidRequestError } from "./errors.js";

/**
 * Pagination helpers.
 *
 * The OPAL portal has no native cursor — the scraper simply walks the
 * "Auftragsliste" from the most recent order. We model that as an opaque,
 * offset-based cursor: a base64url-encoded `{ o: <offset> }`. The client treats
 * it as opaque; a swappable DB driver is free to encode a keyset cursor in the
 * same opaque slot without changing the API contract.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface CursorState {
  /** Number of shipments to skip from the head of the list. */
  offset: number;
}

export function encodeCursor(state: CursorState): string {
  const json = JSON.stringify({ o: state.offset });
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorState {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidRequestError("Malformed cursor.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { o?: unknown }).o !== "number"
  ) {
    throw new InvalidRequestError("Malformed cursor.");
  }
  const offset = (parsed as { o: number }).o;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new InvalidRequestError("Malformed cursor.");
  }
  return { offset };
}

/**
 * Validate & normalise the `limit` query parameter.
 * Accepts undefined (→ default), rejects non-numeric / out-of-range values.
 */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidRequestError(
      `Invalid "limit": expected a positive integer, got "${raw}".`,
    );
  }
  return Math.min(n, MAX_LIMIT);
}

/**
 * Validate & decode the optional `cursor` query parameter into an offset.
 */
export function parseCursor(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  return decodeCursor(raw).offset;
}
